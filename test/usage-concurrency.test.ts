import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
});
afterAll(() => env.close());

function raw(projectId: string, name: string) {
  return {
    projectId, env: 'prod', event: name, timestamp: new Date(), distinctId: name,
    sessionId: null, properties: {}, registered: false,
  };
}

describe('usage concurrency protocol', () => {
  it('commits opposite-order multi-organization raw appends without a deadlock', async () => {
    const suffix = `${Date.now()}`.slice(-8).padStart(8, '0');
    const orgA = `10000000-0000-4000-8000-${suffix}0001`;
    const orgB = `20000000-0000-4000-8000-${suffix}0002`;
    const aLow = `30000000-0000-4000-8000-${suffix}0001`;
    const bLow = `40000000-0000-4000-8000-${suffix}0002`;
    const bHigh = `50000000-0000-4000-8000-${suffix}0003`;
    const aHigh = `60000000-0000-4000-8000-${suffix}0004`;
    await env.pool.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Deadlock A'), ($2, 'Deadlock B')`, [orgA, orgB]);
    await env.pool.query(
      `INSERT INTO projects (id, org_id, slug, name) VALUES
         ($1, $2, $7, 'A low'), ($3, $4, $8, 'B low'),
         ($5, $4, $9, 'B high'), ($6, $2, $10, 'A high')`,
      [aLow, orgA, bLow, orgB, bHigh, aHigh, `a-low-${suffix}`, `b-low-${suffix}`, `b-high-${suffix}`, `a-high-${suffix}`],
    );
    // Project order deliberately conflicts with organization order:
    // [A-low, B-high] vs [B-low, A-high]. On a483caf the sleep barrier
    // makes each transaction retain its first organization lock, then 40P01.
    const first = [aLow, bHigh];
    const second = [bLow, aHigh];

    await env.pool.query(`
      CREATE OR REPLACE FUNCTION pause_usage_ledger_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER usage_ledger_concurrency_pause BEFORE INSERT ON usage_ledger
      FOR EACH ROW EXECUTE FUNCTION pause_usage_ledger_insert();
    `);
    try {
      const store = new PostgresEventStore(env.pool);
      const [left, right] = await Promise.all([
        store.append(first.map((projectId, index) => raw(projectId, `left-${index}`))),
        store.append(second.map((projectId, index) => raw(projectId, `right-${index}`))),
      ]);
      expect(left.inserted).toBe(2);
      expect(right.inserted).toBe(2);
      const projected = await env.pool.query<{ org_id: string; quantity: string; ledger: string }>(
        `SELECT u.org_id::text, u.quantity::text,
                (SELECT COALESCE(sum(l.quantity), 0)::bigint::text FROM usage_ledger l
                  WHERE l.org_id = u.org_id AND l.meter_key = u.meter_key AND l.period_start = u.period_start) AS ledger
         FROM organization_usage u WHERE u.org_id = ANY($1::uuid[]) ORDER BY u.org_id`,
        [[orgA, orgB]],
      );
      expect(projected.rows).toHaveLength(2);
      expect(projected.rows.every((row) => row.quantity === row.ledger && row.quantity === '2')).toBe(true);
    } finally {
      await env.pool.query('DROP TRIGGER IF EXISTS usage_ledger_concurrency_pause ON usage_ledger; DROP FUNCTION IF EXISTS pause_usage_ledger_insert();');
    }
  });

  it('linearizes a lower entitlement update before ingest and makes the batch obey it', async () => {
    const orgId = (await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId])).rows[0]!.org_id;
    await env.pool.query(`INSERT INTO organization_entitlements (org_id, meter_key, hard_limit) VALUES ($1, 'events_stored', 10)`, [orgId]);
    const writer = await env.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE organization_entitlements SET hard_limit = 0 WHERE org_id = $1 AND meter_key = 'events_stored'`, [orgId]);
      const ingest = api(env, env.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'entitlement-update-race', events: [{ event: 'race.update', distinct_id: 'race' }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writer.query('COMMIT');
      const result = await ingest;
      expect(result.status).toBe(402);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }
  });

  it('linearizes an absent entitlement insert before ingest and makes the batch obey it', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    const writer = await isolated.pool.connect();
    try {
      const orgId = (await isolated.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [isolated.projectId])).rows[0]!.org_id;
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO organization_entitlements (org_id, meter_key, hard_limit) VALUES ($1, 'events_stored', 0)`, [orgId]);
      const ingest = api(isolated, isolated.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'entitlement-insert-race', events: [{ event: 'race.insert', distinct_id: 'race' }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writer.query('COMMIT');
      expect((await ingest).status).toBe(402);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      await isolated.close();
    }
  });

  it('rejects a later lower entitlement once ingest has committed current-month usage', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    try {
      expect((await api(isolated, isolated.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'ingest-wins-entitlement', events: [{ event: 'race.wins', distinct_id: 'race' }],
      })).status).toBe(200);
      const orgId = (await isolated.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [isolated.projectId])).rows[0]!.org_id;
      await expect(isolated.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit) VALUES ($1, 'events_stored', 0)`, [orgId],
      )).rejects.toThrow();
    } finally {
      await isolated.close();
    }
  });

  it('linearizes entitlement deletion before ingest so removing a cap takes effect atomically', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    const writer = await isolated.pool.connect();
    try {
      const orgId = (await isolated.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [isolated.projectId])).rows[0]!.org_id;
      await isolated.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit) VALUES ($1, 'events_stored', 0)`,
        [orgId],
      );
      await writer.query('BEGIN');
      await writer.query(`DELETE FROM organization_entitlements WHERE org_id = $1 AND meter_key = 'events_stored'`, [orgId]);
      const ingest = api(isolated, isolated.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'entitlement-delete-race', events: [{ event: 'race.delete', distinct_id: 'race' }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writer.query('COMMIT');
      expect((await ingest).status).toBe(200);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      await isolated.close();
    }
  });

  it('rejects moving an entitlement to a different organization in place', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    try {
      const orgId = (await isolated.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [isolated.projectId])).rows[0]!.org_id;
      const other = (await isolated.pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Entitlement move target') RETURNING id::text AS id`,
      )).rows[0]!.id;
      await isolated.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit) VALUES ($1, 'events_stored', 1)`,
        [orgId],
      );
      await expect(isolated.pool.query(
        `UPDATE organization_entitlements SET org_id = $2 WHERE org_id = $1 AND meter_key = 'events_stored'`,
        [orgId, other],
      )).rejects.toThrow();
    } finally {
      await isolated.close();
    }
  });

  it('enforces month, precision, and ordered-threshold invariants in the database', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    try {
      const orgId = (await isolated.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [isolated.projectId])).rows[0]!.org_id;
      const unsafe = '9007199254740992';
      await expect(isolated.pool.query(
        `INSERT INTO usage_ledger (org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key)
         VALUES ($1, $2, 'prod', 'events_stored',
           date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date + 1, 1, 'invalid-period', 'invalid-period')`,
        [orgId, isolated.projectId],
      )).rejects.toThrow();
      await expect(isolated.pool.query(
        `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
         VALUES ($1, 'events_stored', date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date, $2)`,
        [orgId, unsafe],
      )).rejects.toThrow();
      await expect(isolated.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
         VALUES ($1, 'events_stored', $2, ARRAY[1, 2]::bigint[])`,
        [orgId, unsafe],
      )).rejects.toThrow();
      await expect(isolated.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, warning_thresholds)
         VALUES ($1, 'events_stored', ARRAY[2, 2]::bigint[])`,
        [orgId],
      )).rejects.toThrow();
      await expect(isolated.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, warning_thresholds)
         VALUES ($1, 'events_stored', ARRAY[2, NULL]::bigint[])`,
        [orgId],
      )).rejects.toThrow();
    } finally {
      await isolated.close();
    }
  });
});
