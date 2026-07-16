import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { IngestService } from '../src/services/ingest.js';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';
import type { EventStore, StorableEvent } from '../src/stores/eventStore.js';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('event ingest', () => {
  it('accepts events for unknown event names but counts them unregistered', async () => {
    const res = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        { event: 'wild.event', distinct_id: 'u1', properties: { a: 1 } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 1, unregistered: 1 });
  });

  it('marks events registered once an active metric covers them', async () => {
    await activeMetric(env, { key: 'doc_exported', source: { event: 'doc.exported' } });
    const res = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'doc.exported', distinct_id: 'u1' }],
    });
    expect(res.body).toEqual({ accepted: 1, unregistered: 0 });

    const sample = await api(env, env.secretToken, 'GET', `${P()}/events/sample?event=doc.exported`);
    expect(sample.body.events[0].registered).toBe(true);
  });

  it('deduplicates replayed batch_ids', async () => {
    const payload = {
      batch_id: 'batch-123',
      events: [{ event: 'doc.exported', distinct_id: 'u2' }],
    };
    const first = await api(env, env.ingestToken, 'POST', '/i/v1/events', payload);
    expect(first.body.accepted).toBe(1);
    const replay = await api(env, env.ingestToken, 'POST', '/i/v1/events', payload);
    expect(replay.body).toEqual({ accepted: 0, unregistered: 0, duplicate: true });
  });

  it('treats a batch_id replay as new once the 24h window has passed', async () => {
    const payload = {
      batch_id: 'batch-expiring',
      events: [{ event: 'doc.exported', distinct_id: 'u-exp' }],
    };
    await api(env, env.ingestToken, 'POST', '/i/v1/events', payload);
    // Age the dedup row past the window.
    await env.pool.query(
      `UPDATE ingest_batches SET received_at = now() - interval '25 hours' WHERE batch_id = $1`,
      ['batch-expiring'],
    );
    const replay = await api(env, env.ingestToken, 'POST', '/i/v1/events', payload);
    expect(replay.body.accepted).toBe(1);
    expect(replay.body.duplicate).toBeUndefined();
  });

  it('allows retrying a batch_id when event append fails before storage', async () => {
    const { rows } = await env.pool.query(
      'SELECT id, retention_months FROM projects WHERE slug = $1',
      [env.projectSlug],
    );
    const project = rows[0] as { id: string; retention_months: number };
    const eventStore = failFirstAppendEventStore();
    const ingest = new IngestService(env.pool, eventStore);
    const payload = {
      batch_id: 'batch-append-fails',
      events: [{ event: 'append.failed', distinct_id: 'u-retry' }],
    };

    await expect(ingest.processBatch(project, 'prod', payload)).rejects.toThrow('database down');
    const retry = await ingest.processBatch(project, 'prod', payload);

    expect(retry).toEqual({ accepted: 1, unregistered: 1 });
    expect(eventStore.appends).toHaveLength(2);
  });

  it('returns retryable batch_processing while the same batch_id is still appending', async () => {
    const { rows } = await env.pool.query(
      'SELECT id, retention_months FROM projects WHERE slug = $1',
      [env.projectSlug],
    );
    const project = rows[0] as { id: string; retention_months: number };
    const eventStore = blockingAppendEventStore();
    const ingest = new IngestService(env.pool, eventStore);
    const payload = {
      batch_id: 'batch-still-processing',
      events: [{ event: 'append.blocked', distinct_id: 'u-processing' }],
    };

    const first = ingest.processBatch(project, 'prod', payload);
    await eventStore.started;

    await expect(ingest.processBatch(project, 'prod', payload)).rejects.toMatchObject({
      statusCode: 503,
      code: 'batch_processing',
    });

    eventStore.release();
    await expect(first).resolves.toEqual({ accepted: 1, unregistered: 1 });
  });

  it('does not duplicate events when storage commits but the acknowledgement is lost', async () => {
    const { rows } = await env.pool.query(
      'SELECT id, retention_months FROM projects WHERE slug = $1',
      [env.projectSlug],
    );
    const project = rows[0] as { id: string; retention_months: number };
    const inner = new PostgresEventStore(env.pool);
    let loseAcknowledgement = true;
    const eventStore = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'append' || property === 'appendIdempotent') {
          return async (...args: unknown[]) => {
            const result = await (target[property] as (...values: unknown[]) => Promise<unknown>).apply(target, args);
            if (loseAcknowledgement) {
              loseAcknowledgement = false;
              throw new Error('connection lost after durable commit');
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as EventStore;
    const ingest = new IngestService(env.pool, eventStore);
    const payload = {
      batch_id: `batch-lost-ack-${Date.now()}`,
      events: [{ event: 'append.committed', distinct_id: 'u-lost-ack' }],
    };

    await expect(ingest.processBatch(project, 'prod', payload)).rejects.toThrow('connection lost after durable commit');
    const retry = await ingest.processBatch(project, 'prod', payload);
    const count = await env.pool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE project_id = $1 AND env = 'prod' AND event = 'append.committed' AND distinct_id = 'u-lost-ack'`,
      [project.id],
    );

    expect(retry).toEqual({ accepted: 0, unregistered: 0, duplicate: true });
    expect(count.rows[0].count).toBe(1);
  });

  it('returns retryable batch_processing for a fresh legacy processing claim', async () => {
    const project = (await env.pool.query('SELECT id FROM projects WHERE slug = $1', [env.projectSlug])).rows[0];
    const batchId = `legacy-processing-${Date.now()}`;
    await env.pool.query(
      `INSERT INTO ingest_batches (project_id, env, batch_id, status)
       VALUES ($1, 'prod', $2, 'processing')`,
      [project.id, batchId],
    );

    const retry = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: batchId,
      events: [{ event: 'legacy.processing', distinct_id: 'u-legacy-processing' }],
    });

    expect(retry.status).toBe(503);
    expect(retry.body.error.code).toBe('batch_processing');
    const stored = await env.pool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE project_id = $1 AND event = 'legacy.processing'`,
      [project.id],
    );
    expect(stored.rows[0].count).toBe(0);
  });

  it('returns 207 with per-element errors without sinking the batch', async () => {
    const res = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        { event: 'doc.exported', distinct_id: 'u3' },
        { event: 'BadName!!', distinct_id: 'u3' },
        { event: 'doc.exported' }, // missing distinct_id
      ],
    });
    expect(res.status).toBe(207);
    expect(res.body.accepted).toBe(1);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].index).toBe(1);
    expect(res.body.errors[1].index).toBe(2);
  });

  it('corrects far-future timestamps and flags $clock_skew', async () => {
    const res = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{
        event: 'doc.exported',
        distinct_id: 'u-skew',
        timestamp: new Date(Date.now() + 3600_000).toISOString(),
      }],
    });
    expect(res.body.accepted).toBe(1);
    const sample = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=5`);
    const skewed = sample.body.events.find((e: any) => e.distinct_id === 'u-skew');
    expect(skewed.properties.$clock_skew).toBe(true);
    expect(new Date(skewed.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps env separation: dev key writes dev events', async () => {
    await api(env, env.ingestDevToken, 'POST', '/i/v1/events', {
      events: [{ event: 'doc.exported', distinct_id: 'dev-user' }],
    });
    const prodSample = await api(env, env.secretToken, 'GET', `${P()}/events/sample?env=prod&limit=100`);
    expect(prodSample.body.events.every((e: any) => e.env === 'prod')).toBe(true);
    const devSample = await api(env, env.secretToken, 'GET', `${P()}/events/sample?env=dev&limit=100`);
    expect(devSample.body.events.map((e: any) => e.distinct_id)).toContain('dev-user');
  });

  it('rejects platform tokens on ingest routes', async () => {
    const res = await api(env, env.secretToken, 'POST', '/i/v1/events', {
      events: [{ event: 'doc.exported', distinct_id: 'u4' }],
    });
    expect(res.status).toBe(403);
  });
});

function failFirstAppendEventStore(): EventStore & { appends: StorableEvent[][] } {
  const appends: StorableEvent[][] = [];
  return {
    appends,
    append: async (events: StorableEvent[]) => {
      appends.push(events);
      if (appends.length === 1) throw new Error('database down');
    },
    appendIdempotent: async (batch) => {
      appends.push(batch.events);
      if (appends.length === 1) throw new Error('database down');
      return true;
    },
    trend: async () => [],
    funnel: async () => [],
    retention: async () => [],
    lifecycle: async () => [],
    stickiness: async () => [],
    sample: async () => [],
    eventNames: async () => [],
    eventStats: async () => [],
    entityStatusEvidence: async () => [],
    purge: async () => 0,
    actorSummary: async () => ({
      first_seen: null,
      last_seen: null,
      total_events: 0,
      distinct_events: 0,
      active_days: 0,
      sessions: 0,
      registered_share: 0,
      top_events: [],
    }),
  };
}

function blockingAppendEventStore(): EventStore & {
  appends: StorableEvent[][];
  started: Promise<void>;
  release: () => void;
} {
  const appends: StorableEvent[][] = [];
  let release = () => {};
  let started = () => {};
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let processing = false;
  let completed = false;
  return {
    appends,
    started: startedPromise,
    release,
    append: async (events: StorableEvent[]) => {
      appends.push(events);
      started();
      await releasePromise;
    },
    appendIdempotent: async (batch) => {
      if (processing) {
        throw new ApiError(
          503,
          'batch_processing',
          'this batch_id is already being processed',
          'retry shortly',
        );
      }
      if (completed) return false;
      processing = true;
      appends.push(batch.events);
      started();
      await releasePromise;
      processing = false;
      completed = true;
      return true;
    },
    trend: async () => [],
    funnel: async () => [],
    retention: async () => [],
    lifecycle: async () => [],
    stickiness: async () => [],
    sample: async () => [],
    eventNames: async () => [],
    eventStats: async () => [],
    entityStatusEvidence: async () => [],
    purge: async () => 0,
    actorSummary: async () => ({
      first_seen: null,
      last_seen: null,
      total_events: 0,
      distinct_events: 0,
      active_days: 0,
      sessions: 0,
      registered_share: 0,
      top_events: [],
    }),
  };
}

describe('entity ingest', () => {
  it('rejects entities of unregistered types', async () => {
    const res = await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [{ entity_type: 'ghost', entity_id: 'g1', properties: {} }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_entity_type');
  });

  it('merges properties on upsert; explicit null deletes a key', async () => {
    await api(env, env.secretToken, 'POST', `${P()}/entity-types`, {
      name: 'account',
      description: 'Customer account entity used in the entity merge tests.',
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [{ entity_type: 'account', entity_id: 'acc1', properties: { plan: 'free', seats: 2, trial: true } }],
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [{ entity_type: 'account', entity_id: 'acc1', properties: { plan: 'pro', trial: null } }],
    });

    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'entities',
      entity_type: 'account',
      filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.entities).toHaveLength(1);
    expect(res.body.entities[0].properties).toEqual({ plan: 'pro', seats: 2 });
  });
});
