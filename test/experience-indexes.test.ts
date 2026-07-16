import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let projectId: string;

beforeAll(async () => {
  env = await createTestEnv();
  projectId = (await env.pool.query('SELECT id FROM projects WHERE slug = $1', [env.projectSlug])).rows[0].id;
  const partitionSeed = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    events: [{ event: 'index.fixture', distinct_id: 'index-fixture' }],
  });
  if (partitionSeed.body.accepted !== 1) throw new Error(JSON.stringify(partitionSeed.body));
  await env.pool.query(
    `INSERT INTO events (
       project_id, env, event, "timestamp", distinct_id, session_id,
       properties, registered, event_source
     )
     SELECT $1, 'prod',
       CASE WHEN n % 5 = 0 THEN 'experience.element_clicked' ELSE 'experience.page_viewed' END,
       now() - (n || ' seconds')::interval,
       'actor-' || (n % 200), 'session-' || (n % 100),
       jsonb_build_object(
         'surface', CASE WHEN n % 5 = 0 THEN 'checkout' ELSE 'workspace' END,
         'x', (n % 100)::double precision / 100,
         'y', (n % 80)::double precision / 80,
         'label', 'action-' || (n % 20), 'sequence', n
       ), true, 'experience'
     FROM generate_series(1, 5000) AS n`,
    [projectId],
  );
  await env.pool.query('ANALYZE events');
});

afterAll(() => env.close());

function indexNames(plan: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record['Index Name'] === 'string') found.push(record['Index Name']);
      Object.values(record).forEach(visit);
    }
  };
  visit(plan);
  return found;
}

describe('Browser Experience query indexes', () => {
  it('uses purpose-built indexes for click maps and session timelines', async () => {
    const client = await env.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const indexFamily = async (parent: string): Promise<string[]> => {
        const children = await client.query(
          `SELECT child.relname
           FROM pg_inherits
           JOIN pg_class parent ON parent.oid = inhparent
           JOIN pg_class child ON child.oid = inhrelid
           WHERE parent.relname = $1`,
          [parent],
        );
        return [parent, ...children.rows.map((row) => row.relname as string)];
      };
      const clickPlan = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT properties->>'label', count(*)
         FROM events
         WHERE project_id = $1 AND env = 'prod'
           AND event = 'experience.element_clicked' AND event_source = 'experience'
           AND properties->>'surface' = 'checkout'
           AND "timestamp" >= now() - interval '1 day' AND "timestamp" < now()
         GROUP BY 1`,
        [projectId],
      );
      const sessionPlan = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT event, "timestamp", properties
         FROM events
         WHERE project_id = $1 AND env = 'prod' AND session_id = 'session-5'
           AND event_source = 'experience'
           AND properties->>'surface' = 'checkout'
           AND "timestamp" >= now() - interval '1 day' AND "timestamp" < now()
         ORDER BY "timestamp", (properties->>'sequence')::int`,
        [projectId],
      );

      const clickIndexes = indexNames(clickPlan.rows[0]['QUERY PLAN']);
      const sessionIndexes = indexNames(sessionPlan.rows[0]['QUERY PLAN']);
      const clickFamily = await indexFamily('events_experience_click_surface_time_idx');
      const sessionFamily = await indexFamily('events_experience_session_surface_time_idx');
      expect(clickIndexes.some((name) => clickFamily.includes(name))).toBe(true);
      expect(sessionIndexes.some((name) => sessionFamily.includes(name))).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
