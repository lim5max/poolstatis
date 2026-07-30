import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const waitForPurgeLock = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await env.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE '%id = ANY%'
           AND query LIKE '%FOR UPDATE%'
       ) AS waiting`,
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('purge did not reach the expected event row lock');
};
const historicalEvents = [
  {
    event: 'skill.enabled',
    timestamp: daysAgo(20),
    distinct_id: 'atlas-user-1',
    properties: { skill: 'search' },
  },
  {
    event: 'skill.enabled',
    timestamp: daysAgo(10),
    distinct_id: 'atlas-user-2',
    properties: { skill: 'writing' },
  },
];

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
  await activeMetric(env, {
    key: 'skill_enabled',
    source: { event: 'skill.enabled' },
    purpose: 'Measures historical skill adoption by the date each participant enabled it.',
  });
});

afterAll(() => env.close());

describe('historical event backfill', () => {
  it('previews and atomically imports exact historical timestamps', async () => {
    const events = historicalEvents;
    const preview = await api(
      env,
      env.personalToken,
      'POST',
      `${P()}/events/backfill/preview`,
      { env: 'prod', events },
    );

    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      valid: true,
      event_count: 2,
      registered_count: 2,
      unregistered_count: 0,
      errors: [],
    });
    expect(preview.body.payload_sha256).toMatch(/^[a-f0-9]{64}$/);

    const committed = await api(
      env,
      env.personalToken,
      'POST',
      `${P()}/events/backfill`,
      {
        env: 'prod',
        batch_id: 'atlas-skill-history-part-001',
        reason: 'Restore Atlas skill activation facts from the product database.',
        expected_payload_sha256: preview.body.payload_sha256,
        events,
      },
    );

    expect(committed.status).toBe(201);
    expect(committed.body).toMatchObject({
      inserted: 2,
      batch: {
        batch_id: 'atlas-skill-history-part-001',
        event_count: 2,
        registered_count: 2,
        unregistered_count: 0,
      },
    });

    const sample = await api(
      env,
      env.secretToken,
      'GET',
      `${P()}/events/sample?event=skill.enabled&limit=10&env=prod`,
    );
    expect(sample.body.events).toHaveLength(2);
    expect(sample.body.events.map((event: { timestamp: string }) => event.timestamp).sort())
      .toEqual(events.map((event) => event.timestamp).sort());
    expect(sample.body.events.every((event: { id: string }) =>
      /^[a-f0-9-]{36}$/.test(event.id))).toBe(true);
    expect(sample.body.events.every((event: { origin: string }) =>
      event.origin === 'backfill')).toBe(true);

    const trend = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend',
      metric: 'skill_enabled',
      date_from: '-30d',
      interval: 'day',
      env: 'prod',
    });
    expect(trend.body.series.reduce(
      (total: number, point: { value: number }) => total + point.value,
      0,
    )).toBe(2);
    expect(trend.body.series).toHaveLength(2);
  });

  it('makes an exact retry safe and rejects batch_id reuse with another payload', async () => {
    const events = historicalEvents;
    const preview = await api(env, env.secretToken, 'POST', `${P()}/events/backfill/preview`, {
      env: 'prod', events,
    });
    const replay = await api(env, env.secretToken, 'POST', `${P()}/events/backfill`, {
      env: 'prod',
      batch_id: 'atlas-skill-history-part-001',
      reason: 'Exact retry after a lost client acknowledgement from the import.',
      expected_payload_sha256: preview.body.payload_sha256,
      events,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ inserted: 0, duplicate: true });

    const different = [{
      event: 'skill.enabled',
      timestamp: daysAgo(5),
      distinct_id: 'atlas-user-3',
      properties: { skill: 'analysis' },
    }];
    const differentPreview = await api(env, env.secretToken, 'POST', `${P()}/events/backfill/preview`, {
      env: 'prod', events: different,
    });
    const conflict = await api(env, env.secretToken, 'POST', `${P()}/events/backfill`, {
      env: 'prod',
      batch_id: 'atlas-skill-history-part-001',
      reason: 'This must not overwrite the already completed historical batch.',
      expected_payload_sha256: differentPreview.body.payload_sha256,
      events: different,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('backfill_batch_conflict');
  });

  it('rejects the whole batch when any row is invalid or outside retention', async () => {
    const before = await env.pool.query(
      'SELECT count(*)::int AS count FROM events WHERE project_id = $1',
      [env.projectId],
    );
    const preview = await api(env, env.secretToken, 'POST', `${P()}/events/backfill/preview`, {
      env: 'prod',
      events: [
        { event: 'skill.enabled', timestamp: daysAgo(3), distinct_id: 'valid-user' },
        { event: 'Bad Event', timestamp: daysAgo(3), distinct_id: 'invalid-user' },
        { event: 'skill.enabled', timestamp: '2020-01-01T00:00:00Z', distinct_id: 'expired-user' },
      ],
    });
    expect(preview.status).toBe(200);
    expect(preview.body.valid).toBe(false);
    expect(preview.body.payload_sha256).toBeNull();
    expect(preview.body.errors.map((error: { index: number }) => error.index)).toEqual([1, 2]);

    const rejected = await api(env, env.secretToken, 'POST', `${P()}/events/backfill`, {
      env: 'prod',
      batch_id: 'invalid-mixed-batch',
      reason: 'This batch demonstrates all-or-nothing validation before storage.',
      expected_payload_sha256: '0'.repeat(64),
      events: [
        { event: 'skill.enabled', timestamp: daysAgo(3), distinct_id: 'valid-user' },
        { event: 'Bad Event', timestamp: daysAgo(3), distinct_id: 'invalid-user' },
      ],
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('backfill_validation_failed');
    const after = await env.pool.query(
      'SELECT count(*)::int AS count FROM events WHERE project_id = $1',
      [env.projectId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});

describe('audited event correction', () => {
  it('previews, applies, and records an optimistic before/after revision', async () => {
    const sample = await api(
      env,
      env.secretToken,
      'GET',
      `${P()}/events/sample?event=skill.enabled&distinct_id=atlas-user-1&env=prod`,
    );
    const event = sample.body.events[0];
    const correctedTimestamp = daysAgo(15);
    const patch = {
      timestamp: correctedTimestamp,
      set_properties: { skill_level: 'advanced' },
      unset_properties: ['skill'],
    };
    const preview = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${event.id}/revisions/preview`,
      { env: 'prod', patch },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.expected_revision).toBe(1);
    expect(preview.body.preview_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.body.changed_fields).toEqual(
      expect.arrayContaining(['timestamp', 'properties']),
    );
    expect(preview.body.after.properties).toEqual({ skill_level: 'advanced' });

    const changedAfterPreview = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${event.id}/revisions`,
      {
        env: 'prod',
        expected_revision: preview.body.expected_revision,
        expected_preview_sha256: preview.body.preview_sha256,
        reason: 'A different patch must never reuse an earlier reviewed fingerprint.',
        patch: { set_properties: { unreviewed: true } },
      },
    );
    expect(changedAfterPreview.status).toBe(409);
    expect(changedAfterPreview.body.error.code).toBe('event_revision_preview_changed');

    const committed = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${event.id}/revisions`,
      {
        env: 'prod',
        expected_revision: preview.body.expected_revision,
        expected_preview_sha256: preview.body.preview_sha256,
        reason: 'Correct the activation date and normalize the imported skill property.',
        patch,
      },
    );
    expect(committed.status).toBe(201);
    expect(committed.body.revision).toMatchObject({
      event_id: event.id,
      revision: 2,
      previous_snapshot: { timestamp: event.timestamp, properties: { skill: 'search' } },
      snapshot: { timestamp: correctedTimestamp, properties: { skill_level: 'advanced' } },
    });

    const history = await api(
      env,
      env.secretToken,
      'GET',
      `${P()}/events/${event.id}?env=prod`,
    );
    expect(history.status).toBe(200);
    expect(history.body.event).toMatchObject({
      id: event.id,
      revision: 2,
      timestamp: correctedTimestamp,
      properties: { skill_level: 'advanced' },
    });
    expect(history.body.revisions).toHaveLength(1);

    const stale = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${event.id}/revisions`,
      {
        env: 'prod',
        expected_revision: 1,
        expected_preview_sha256: preview.body.preview_sha256,
        reason: 'A stale correction must not overwrite a newer reviewed revision.',
        patch: { set_properties: { stale: true } },
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'event_revision_conflict',
      details: { current_revision: 2 },
    });
  });

  it('refuses to revise system events and purges personal audit snapshots with the actor', async () => {
    const systemId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO events (
         id, project_id, env, event, "timestamp", distinct_id, properties,
         registered, is_system, event_source
       ) VALUES ($1, $2, 'prod', '$feature_flag_called', now(), 'system-user',
                 '{}', false, true, 'system')`,
      [systemId, env.projectId],
    );
    const denied = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${systemId}/revisions`,
      {
        env: 'prod',
        expected_revision: 1,
        expected_preview_sha256: '0'.repeat(64),
        reason: 'System evidence must remain immutable even for platform credentials.',
        patch: { set_properties: { edited: true } },
      },
    );
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('event_not_editable');

    const revised = await env.pool.query<{ id: string }>(
      `SELECT id FROM events
       WHERE project_id = $1 AND distinct_id = 'atlas-user-1'`,
      [env.projectId],
    );
    expect(revised.rows).toHaveLength(1);
    const renamePreview = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${revised.rows[0]!.id}/revisions/preview`,
      { env: 'prod', patch: { distinct_id: 'atlas-user-renamed' } },
    );
    expect(renamePreview.status).toBe(200);
    const renamed = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/${revised.rows[0]!.id}/revisions`,
      {
        env: 'prod',
        expected_revision: renamePreview.body.expected_revision,
        expected_preview_sha256: renamePreview.body.preview_sha256,
        reason: 'Correct the historical actor identifier while preserving its audit trail.',
        patch: { distinct_id: 'atlas-user-renamed' },
      },
    );
    expect(renamed.status).toBe(201);
    const purged = await api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
      scope: 'events',
      env: 'prod',
      distinct_id: 'atlas-user-1',
      confirm_slug: env.projectSlug,
    });
    expect(purged.status).toBe(200);
    expect(purged.body.events_deleted).toBe(1);
    const audit = await env.pool.query(
      'SELECT count(*)::int AS count FROM event_revisions WHERE event_id = $1',
      [revised.rows[0].id],
    );
    expect(audit.rows[0].count).toBe(0);
    const current = await env.pool.query(
      'SELECT count(*)::int AS count FROM events WHERE id = $1',
      [revised.rows[0]!.id],
    );
    expect(current.rows[0].count).toBe(0);
  });

  it('serializes a concurrent actor correction and GDPR purge without orphan audit PII', async () => {
    const events = [{
      event: 'skill.enabled',
      timestamp: daysAgo(1),
      distinct_id: 'purge-race-old-actor',
      properties: { skill: 'race-fixture' },
    }];
    const backfillPreview = await api(
      env,
      env.secretToken,
      'POST',
      `${P()}/events/backfill/preview`,
      { env: 'prod', events },
    );
    await api(env, env.secretToken, 'POST', `${P()}/events/backfill`, {
      env: 'prod',
      batch_id: 'purge-revision-race-fixture',
      reason: 'Create one isolated event for the purge and revision lock-order test.',
      expected_payload_sha256: backfillPreview.body.payload_sha256,
      events,
    });
    const sample = await api(
      env,
      env.secretToken,
      'GET',
      `${P()}/events/sample?distinct_id=purge-race-old-actor&env=prod`,
    );
    const event = sample.body.events[0];
    // Hold the exact lock used by reviseEvent, write the new audit snapshot,
    // and keep it uncommitted while purge takes its candidate snapshot. This
    // deterministically exercises the READ COMMITTED race that a single CTE
    // statement cannot handle.
    const revisionClient = await env.pool.connect();
    let purgePromise: ReturnType<typeof api> | undefined;
    try {
      await revisionClient.query('BEGIN');
      const before = await revisionClient.query<{ snapshot: Record<string, unknown> }>(
        `SELECT to_jsonb(events) AS snapshot
         FROM events
         WHERE project_id = $1 AND env = 'prod' AND id = $2
         FOR UPDATE`,
        [env.projectId, event.id],
      );
      const updated = await revisionClient.query<{ snapshot: Record<string, unknown> }>(
        `UPDATE events
         SET distinct_id = 'purge-race-new-actor', revision = revision + 1
         WHERE project_id = $1 AND env = 'prod' AND id = $2
         RETURNING to_jsonb(events) AS snapshot`,
        [env.projectId, event.id],
      );
      await revisionClient.query(
        `INSERT INTO event_revisions (
           event_id, project_id, env, revision, actor, reason,
           previous_snapshot, snapshot
         ) VALUES ($1, $2, 'prod', 2, 'test:concurrency',
                   'Deterministic correction held open while purge starts.',
                   $3, $4)`,
        [
          event.id,
          env.projectId,
          before.rows[0]!.snapshot,
          updated.rows[0]!.snapshot,
        ],
      );

      purgePromise = api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
        scope: 'events',
        env: 'prod',
        distinct_id: 'purge-race-old-actor',
        confirm_slug: env.projectSlug,
      });
      await waitForPurgeLock();
      await revisionClient.query('COMMIT');

      const purge = await purgePromise;
      expect(purge.status).toBe(200);
    } catch (error) {
      await revisionClient.query('ROLLBACK').catch(() => {});
      await purgePromise?.catch(() => {});
      throw error;
    } finally {
      revisionClient.release();
    }
    const remaining = await env.pool.query<{ events: number; revisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM events WHERE id = $1) AS events,
         (SELECT count(*)::int FROM event_revisions WHERE event_id = $1) AS revisions`,
      [event.id],
    );
    expect(remaining.rows[0]).toEqual({ events: 0, revisions: 0 });
  });
});

describe('hosted write policy boundary', () => {
  it('keeps previews readable while blocking backfill and revision commits', async () => {
    const hosted = await createTestEnv({
      ingestBuffer: false,
      auth: {
        issuer: 'https://identity.example.test/',
        audience: 'poolstatis-test',
        jwks: async () => ({ keys: [] }),
        requireOrganizationPolicy: true,
      },
    });
    try {
      await api(hosted, hosted.ingestToken, 'POST', '/i/v1/events', {
        events: [{ event: 'skill.enabled', distinct_id: 'hosted-existing-user' }],
      });
      const project = await hosted.pool.query<{ org_id: string }>(
      'SELECT org_id FROM projects WHERE id = $1',
        [hosted.projectId],
      );
      await hosted.pool.query(
        `INSERT INTO organization_policy_state (org_id)
         VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
        [project.rows[0]?.org_id],
      );
      const events = [{
        event: 'skill.enabled',
        timestamp: daysAgo(2),
        distinct_id: 'policy-user',
      }];
      const path = `/api/v1/projects/${hosted.projectSlug}`;
      const preview = await api(hosted, hosted.secretToken, 'POST', `${path}/events/backfill/preview`, {
        env: 'prod',
        events,
      });
      expect(preview.status).toBe(200);

      const blocked = await api(hosted, hosted.secretToken, 'POST', `${path}/events/backfill`, {
        env: 'prod',
        batch_id: 'policy-blocked-backfill',
        reason: 'Writes are intentionally unavailable for this hosted organization.',
        expected_payload_sha256: preview.body.payload_sha256,
        events,
      });
      expect(blocked.status).toBe(402);
      expect(blocked.body.error.code).toBe('organization_write_disabled');

      const sample = await api(
        hosted,
        hosted.secretToken,
        'GET',
        `${path}/events/sample?event=skill.enabled&distinct_id=hosted-existing-user&env=prod`,
      );
      const correctionPreview = await api(
        hosted,
        hosted.secretToken,
        'POST',
        `${path}/events/${sample.body.events[0].id}/revisions/preview`,
        { env: 'prod', patch: { set_properties: { reviewed: true } } },
      );
      expect(correctionPreview.status).toBe(200);
      const correction = await api(
        hosted,
        hosted.secretToken,
        'POST',
        `${path}/events/${sample.body.events[0].id}/revisions`,
        {
          env: 'prod',
          patch: { set_properties: { reviewed: true } },
          expected_revision: correctionPreview.body.expected_revision,
          expected_preview_sha256: correctionPreview.body.preview_sha256,
          reason: 'This correction must be blocked by the hosted write policy.',
        },
      );
      expect(correction.status).toBe(402);
      expect(correction.body.error.code).toBe('organization_write_disabled');
    } finally {
      await hosted.close();
    }
  });
});
