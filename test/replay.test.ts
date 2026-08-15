import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { LocalReplayObjectStore, type ReplayObjectStore } from '../src/replay/objectStore.js';
import { sanitizeReplayEvents } from '../src/replay/sanitize.js';
import { purgeExpiredReplays, ReplayService } from '../src/services/replay.js';

let env: TestEnv;
let other: TestEnv;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poolstatis-replays-'));
  env = await createTestEnv({ replayDir: root });
  other = await createTestEnv({ replayDir: root });
  for (const target of [env, other]) {
    await api(target, target.secretToken, 'POST', `/api/v1/projects/${target.projectSlug}/experience/surfaces`, {
      key: 'workspace', name: 'Workspace', purpose: 'Reproduce consented workspace interaction failures.',
    });
  }
});

afterAll(async () => {
  await env.close();
  await other.close();
  await rm(root, { recursive: true, force: true });
});

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const policy = { version: 'privacy-v1', text: 'masked' as const, maskSelectors: [], blockSelectors: [] };

async function createReplay(target = env, distinctId = 'actor-1') {
  return api(target, target.ingestToken, 'POST', '/i/v1/replays', {
    surface: 'workspace', route: 'workspace', session_id: `session-${Date.now()}-${Math.random()}`,
    distinct_id: distinctId, host: 'app.example.test', version: 'release-1', device: 'desktop',
    consent_version: 'consent-v1', policy, policy_hash: sha(policy), retention_days: 7,
  });
}

function replayEvents(start = 100) {
  return [
    { type: 4, timestamp: start, data: { href: 'https://app.example.test/workspace?token=secret#private', width: 1280, height: 720 } },
    {
      type: 2,
      timestamp: start + 1,
      data: {
        node: {
          type: 0,
          childNodes: [{
            type: 2, tagName: 'body', attributes: {}, childNodes: [
              { type: 2, tagName: 'h1', attributes: { 'aria-label': 'alice@example.com' }, childNodes: [{ type: 3, textContent: 'Private workspace' }] },
            ],
          }],
        },
      },
    },
    { type: 3, timestamp: start + 2, data: { source: 1, positions: [{ x: 120, y: 240, id: 2, timeOffset: 0 }] } },
    { type: 3, timestamp: start + 3, data: { source: 0, texts: [{ id: 4, value: 'Changed private text' }], adds: [], removes: [], attributes: [] } },
    { type: 3, timestamp: start + 4, data: { source: 3, id: 2, x: 0, y: 480 } },
  ];
}

describe('session replay vertical slice', () => {
  it('stores idempotent chunks, completes, isolates tenants and serves sanitized playback', async () => {
    const created = await createReplay();
    expect(created.status).toBe(201);
    const replayId = created.body.replay.id as string;
    const uploadToken = created.body.upload_token as string;
    const events = replayEvents();
    const chunk = { upload_token: uploadToken, sequence: 0, checksum: sha(events), events };
    const uploaded = await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${replayId}/chunks`, chunk);
    expect(uploaded).toMatchObject({ status: 201, body: { accepted: true, duplicate: false, sequence: 0 } });
    expect(await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${replayId}/chunks`, chunk))
      .toMatchObject({ status: 200, body: { duplicate: true } });
    const conflict = await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${replayId}/chunks`, {
      ...chunk, checksum: 'a'.repeat(64), events: [{ type: 4, timestamp: 100, data: {} }],
    });
    expect(conflict.status).toBe(400);
    const conflictingEvents = [{ type: 4, timestamp: 100, data: { width: 1, height: 1 } }];
    const sequenceConflict = await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${replayId}/chunks`, {
      ...chunk, checksum: sha(conflictingEvents), events: conflictingEvents,
    });
    expect(sequenceConflict.status).toBe(409);

    const complete = await api(env, env.ingestToken, 'POST', `/i/v1/replays/${replayId}/complete`, {
      upload_token: uploadToken, last_sequence: 0,
    });
    expect(complete).toMatchObject({ status: 200, body: { status: 'playable', event_count: 5 } });

    const listed = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays?env=prod`);
    expect(listed.body.replays).toEqual(expect.arrayContaining([expect.objectContaining({ id: replayId, viewer_path: `/experience?replay=${replayId}&env=prod` })]));
    const played = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${replayId}/events?env=prod`);
    expect(played.status).toBe(200);
    expect(played.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 2 }),
      expect.objectContaining({ type: 3, data: expect.objectContaining({ source: 1 }) }),
      expect.objectContaining({ type: 3, data: expect.objectContaining({ source: 3 }) }),
    ]));
    const serialized = JSON.stringify(played.body);
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('Private workspace');
    expect(serialized).not.toContain('Changed private text');

    const crossTenant = await api(other, other.secretToken, 'GET', `/api/v1/projects/${other.projectSlug}/replays/${replayId}?env=prod`);
    expect(crossTenant.status).toBe(404);
    const audit = await env.pool.query<{ action: string }>('SELECT action FROM replay_audit_log WHERE replay_id = $1', [replayId]);
    expect(audit.rows.map((row) => row.action)).toContain('view');
  });

  it('recovers an identical orphan object and rejects overlapping chunk time', async () => {
    const orphan = await createReplay();
    const orphanId = orphan.body.replay.id as string;
    const orphanToken = orphan.body.upload_token as string;
    const events = replayEvents(1_000);
    const sanitized = sanitizeReplayEvents(events, { route: 'workspace', textMode: 'masked' });
    const store = new LocalReplayObjectStore(root);
    await store.put(`${env.projectId}/${orphanId}/0.json`, Buffer.from(JSON.stringify(sanitized.events)));
    const recovered = await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${orphanId}/chunks`, {
      upload_token: orphanToken, sequence: 0, checksum: sha(events), events,
    });
    expect(recovered.status).toBe(201);

    const created = await createReplay();
    const id = created.body.replay.id as string;
    const token = created.body.upload_token as string;
    const first = replayEvents(2_000);
    const second = [{ type: 3, timestamp: 2_003, data: { source: 1, positions: [{ x: 1, y: 1, id: 2, timeOffset: 0 }] } }];
    for (const [sequence, chunkEvents] of [[0, first], [1, second]] as const) {
      expect((await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${id}/chunks`, {
        upload_token: token, sequence, checksum: sha(chunkEvents), events: chunkEvents,
      })).status).toBe(201);
    }
    const completed = await api(env, env.ingestToken, 'POST', `/i/v1/replays/${id}/complete`, {
      upload_token: token, last_sequence: 1,
    });
    expect(completed.body.status).toBe('incomplete');
  });

  it('persists selector policy and enforces it against a client that bypasses the SDK', async () => {
    const explicitPolicy = {
      version: 'privacy-visible-v1',
      text: 'visible' as const,
      maskSelectors: ['[data-mask-me]'],
      blockSelectors: ['.private-block'],
    };
    const created = await api(env, env.ingestToken, 'POST', '/i/v1/replays', {
      surface: 'workspace', route: 'workspace', session_id: `selector-${Date.now()}`,
      distinct_id: 'actor-selector', host: 'app.example.test', version: 'release-1', device: 'desktop',
      consent_version: 'consent-v1', policy: explicitPolicy, policy_hash: sha(explicitPolicy), retention_days: 7,
    });
    const id = created.body.replay.id as string;
    const token = created.body.upload_token as string;
    const events = [{
      type: 2,
      timestamp: 900,
      data: { node: { type: 0, childNodes: [{
        type: 2, tagName: 'body', attributes: {}, childNodes: [
          { type: 2, tagName: 'section', attributes: { class: 'private-block' }, childNodes: [{ type: 3, textContent: 'Blocked Alice Secret' }] },
          { type: 2, tagName: 'p', attributes: { 'data-mask-me': '' }, childNodes: [{ type: 3, textContent: 'Masked Alice Secret' }] },
          { type: 2, tagName: 'p', attributes: {}, childNodes: [{ type: 3, textContent: 'Visible public label' }] },
        ],
      }] } },
    }];
    expect((await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${id}/chunks`, {
      upload_token: token, sequence: 0, checksum: sha(events), events,
    })).status).toBe(201);
    expect((await api(env, env.ingestToken, 'POST', `/i/v1/replays/${id}/complete`, {
      upload_token: token, last_sequence: 0,
    })).body.status).toBe('playable');
    const played = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${id}/events?env=prod`);
    const serialized = JSON.stringify(played.body);
    expect(serialized).toContain('Visible public label');
    expect(serialized).not.toContain('Blocked Alice Secret');
    expect(serialized).not.toContain('Masked Alice Secret');
    const storedPolicy = await env.pool.query<{ mask_selectors: string[]; block_selectors: string[] }>(
      'SELECT mask_selectors, block_selectors FROM replay_sessions WHERE id = $1',
      [id],
    );
    expect(storedPolicy.rows[0]).toEqual({
      mask_selectors: explicitPolicy.maskSelectors,
      block_selectors: explicitPolicy.blockSelectors,
    });
  });

  it('tombstones expired replays before retention deletes their objects', async () => {
    const created = await createReplay();
    const id = created.body.replay.id as string;
    await env.pool.query("UPDATE replay_sessions SET delete_after = now() - interval '1 second' WHERE id = $1", [id]);
    expect((await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${id}?env=prod`)).status).toBe(410);
    expect((await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${id}/events?env=prod`)).status).toBe(410);
    const beforePurge = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays?env=prod`);
    expect(beforePurge.body.replays).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    const result = await purgeExpiredReplays(
      new ReplayService(env.pool, new LocalReplayObjectStore(root)),
      env.pool,
      10,
      new Date(),
    );
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const gone = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${id}?env=prod`);
    expect(gone.status).toBe(410);
  });

  it('physically removes replay objects through the env-scoped data purge seam', async () => {
    const target = await createTestEnv({ replayDir: root });
    try {
      await api(target, target.secretToken, 'POST', `/api/v1/projects/${target.projectSlug}/experience/surfaces`, {
        key: 'workspace', name: 'Workspace', purpose: 'Reproduce consented workspace interaction failures.',
      });
      const created = await createReplay(target);
      const id = created.body.replay.id as string;
      const token = created.body.upload_token as string;
      const events = replayEvents(3_000);
      expect((await api(target, target.ingestToken, 'PUT', `/i/v1/replays/${id}/chunks`, {
        upload_token: token, sequence: 0, checksum: sha(events), events,
      })).status).toBe(201);

      const purged = await api(
        target,
        target.secretToken,
        'POST',
        `/api/v1/projects/${target.projectSlug}/data/purge`,
        { env: 'prod', scope: 'all', confirm_slug: target.projectSlug },
      );
      expect(purged).toMatchObject({ status: 200, body: { replays_deleted: 1 } });
      expect((await api(target, target.secretToken, 'GET', `/api/v1/projects/${target.projectSlug}/replays/${id}?env=prod`)).status).toBe(410);
      await expect(new LocalReplayObjectStore(root).get(`${target.projectId}/${id}/0.json`)).rejects.toThrow();
    } finally {
      await target.close();
    }
  });

  it('rejects a corrupt stored object instead of passing it to the player', async () => {
    const created = await createReplay();
    const id = created.body.replay.id as string;
    const token = created.body.upload_token as string;
    const events = replayEvents(4_000);
    expect((await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${id}/chunks`, {
      upload_token: token, sequence: 0, checksum: sha(events), events,
    })).status).toBe(201);
    expect((await api(env, env.ingestToken, 'POST', `/i/v1/replays/${id}/complete`, {
      upload_token: token, last_sequence: 0,
    })).body.status).toBe('playable');
    await writeFile(join(root, env.projectId, id, '0.json'), Buffer.alloc(600_000, 0x78));
    const played = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${id}/events?env=prod`);
    expect(played.status).toBe(409);
    expect(played.body.error.code).toBe('replay_object_corrupt');
  });

  it('physically removes exact-subject replays without touching another actor', async () => {
    const actorReplay = await createReplay(env, 'actor-delete-me');
    const otherReplay = await createReplay(env, 'actor-keep-me');
    const actorId = actorReplay.body.replay.id as string;
    const actorToken = actorReplay.body.upload_token as string;
    const events = replayEvents(6_000);
    expect((await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${actorId}/chunks`, {
      upload_token: actorToken, sequence: 0, checksum: sha(events), events,
    })).status).toBe(201);

    const purged = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/data/purge`, {
      env: 'prod', scope: 'events', distinct_id: 'actor-delete-me', confirm_slug: env.projectSlug,
    });
    expect(purged).toMatchObject({
      status: 200,
      body: { replays_deleted: 1, identity_scope: 'exact_raw_distinct_id', canonical_expansion: false },
    });
    expect((await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${actorId}?env=prod`)).status).toBe(410);
    const kept = await env.pool.query<{ status: string }>('SELECT status FROM replay_sessions WHERE id = $1', [otherReplay.body.replay.id]);
    expect(kept.rows[0]?.status).toBe('recording');
    await expect(new LocalReplayObjectStore(root).get(`${env.projectId}/${actorId}/0.json`)).rejects.toThrow();
  });

  it('serializes playback with consent withdrawal so no read completes afterward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'poolstatis-replay-read-delete-'));
    const delegate = new LocalReplayObjectStore(directory);
    let markReadEntered!: () => void;
    let releaseRead!: () => void;
    const readEntered = new Promise<void>((resolve) => { markReadEntered = resolve; });
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    class BlockingReadStore implements ReplayObjectStore {
      put(key: string, bytes: Buffer) { return delegate.put(key, bytes); }
      async get(key: string, maxBytes?: number) {
        markReadEntered();
        await readReleased;
        return delegate.get(key, maxBytes);
      }
      delete(key: string) { return delegate.delete(key); }
      deleteReplay(projectId: string, replayId: string) { return delegate.deleteReplay(projectId, replayId); }
      deleteProject(projectId: string) { return delegate.deleteProject(projectId); }
    }
    const target = await createTestEnv({ replayObjectStore: new BlockingReadStore() });
    try {
      await api(target, target.secretToken, 'POST', `/api/v1/projects/${target.projectSlug}/experience/surfaces`, {
        key: 'workspace', name: 'Workspace', purpose: 'Reproduce consented workspace interaction failures.',
      });
      const created = await createReplay(target);
      const id = created.body.replay.id as string;
      const token = created.body.upload_token as string;
      const events = replayEvents(5_000);
      expect((await api(target, target.ingestToken, 'PUT', `/i/v1/replays/${id}/chunks`, {
        upload_token: token, sequence: 0, checksum: sha(events), events,
      })).status).toBe(201);
      expect((await api(target, target.ingestToken, 'POST', `/i/v1/replays/${id}/complete`, {
        upload_token: token, last_sequence: 0,
      })).body.status).toBe('playable');

      const completionOrder: string[] = [];
      const reading = api(target, target.secretToken, 'GET', `/api/v1/projects/${target.projectSlug}/replays/${id}/events?env=prod`)
        .then((result) => {
          completionOrder.push('read');
          return result;
        });
      await readEntered;
      let withdrawalSettled = false;
      const withdrawing = api(target, target.ingestToken, 'DELETE', `/i/v1/replays/${id}`, {
        upload_token: token,
      }).then((result) => {
        withdrawalSettled = true;
        completionOrder.push('withdrawal');
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(withdrawalSettled).toBe(false);

      releaseRead();
      expect((await reading).status).toBe(200);
      expect((await withdrawing).status).toBe(200);
      expect(completionOrder).toEqual(['read', 'withdrawal']);
      expect((await api(target, target.secretToken, 'GET', `/api/v1/projects/${target.projectSlug}/replays/${id}/events?env=prod`)).status).toBe(410);
    } finally {
      releaseRead();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('replay deletion crash convergence', () => {
  it('keeps a failed deletion unreadable and converges on retry', async () => {
    class FailOnceStore implements ReplayObjectStore {
      private readonly delegate: LocalReplayObjectStore;
      private failed = false;
      constructor(directory: string) { this.delegate = new LocalReplayObjectStore(directory); }
      put(key: string, bytes: Buffer) { return this.delegate.put(key, bytes); }
      get(key: string, maxBytes?: number) { return this.delegate.get(key, maxBytes); }
      async delete(key: string) {
        return this.delegate.delete(key);
      }
      async deleteReplay(projectId: string, replayId: string) {
        if (!this.failed) { this.failed = true; throw new Error('synthetic storage outage'); }
        return this.delegate.deleteReplay(projectId, replayId);
      }
      deleteProject(projectId: string) { return this.delegate.deleteProject(projectId); }
    }
    const directory = await mkdtemp(join(tmpdir(), 'poolstatis-replay-delete-'));
    const store = new FailOnceStore(directory);
    const target = await createTestEnv({ replayObjectStore: store });
    try {
      await api(target, target.secretToken, 'POST', `/api/v1/projects/${target.projectSlug}/experience/surfaces`, {
        key: 'workspace', name: 'Workspace', purpose: 'Reproduce consented workspace interaction failures.',
      });
      const created = await createReplay(target);
      const id = created.body.replay.id as string;
      const token = created.body.upload_token as string;
      const events = replayEvents();
      await api(target, target.ingestToken, 'PUT', `/i/v1/replays/${id}/chunks`, {
        upload_token: token, sequence: 0, checksum: sha(events), events,
      });
      await store.put(`${target.projectId}/${id}/1.json`, Buffer.from('orphan-without-metadata'));
      const failed = await api(target, target.secretToken, 'DELETE', `/api/v1/projects/${target.projectSlug}/replays/${id}`);
      expect(failed.status).toBe(503);
      expect((await api(target, target.secretToken, 'GET', `/api/v1/projects/${target.projectSlug}/replays/${id}?env=prod`)).status).toBe(410);
      const retried = await purgeExpiredReplays(
        new ReplayService(target.pool, store),
        target.pool,
        10,
        new Date(Date.now() + 1_000),
      );
      expect(retried.deleted).toBeGreaterThanOrEqual(1);
      const row = await target.pool.query<{ status: string }>('SELECT status FROM replay_sessions WHERE id = $1', [id]);
      expect(row.rows[0]?.status).toBe('deleted');
      await expect(store.get(`${target.projectId}/${id}/1.json`)).rejects.toThrow();
      const audit = await target.pool.query<{ actor: string; action: string }>(
        'SELECT actor, action FROM replay_audit_log WHERE replay_id = $1 ORDER BY id',
        [id],
      );
      expect(audit.rows.map((entry) => entry.action)).toEqual(['delete_requested', 'delete_completed']);
      expect(audit.rows[1]?.actor).toBe(audit.rows[0]?.actor);
      expect(audit.rows[0]?.actor).not.toBe('retention:worker');
      await expect(target.pool.query('UPDATE replay_audit_log SET actor = $2 WHERE replay_id = $1', [id, 'tampered']))
        .rejects.toThrow('append-only');
    } finally {
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
