import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import {
  ensureHistoricalEventPartitions,
  historicalEventPartitionsReady,
  rollingEventPartitionsReady,
} from '../src/stores/postgresEventStore.js';
import { TEST_DB_URL } from './urls.js';

describe('migration 032 event management upgrade', () => {
  const schema = `m032_${Date.now()}`;
  const pool = createPool(TEST_DB_URL);
  let scopedPool!: pg.Pool;
  const projectId = '00000000-0000-0000-0000-000000000032';

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE projects (
          id uuid PRIMARY KEY,
          retention_months integer NOT NULL DEFAULT 12
        );
        INSERT INTO projects (id) VALUES ('${projectId}');
        CREATE TABLE events (
          project_id uuid NOT NULL,
          env text NOT NULL,
          event text NOT NULL,
          "timestamp" timestamptz NOT NULL,
          distinct_id text NOT NULL,
          session_id text,
          properties jsonb NOT NULL DEFAULT '{}',
          registered boolean NOT NULL DEFAULT false,
          ingested_at timestamptz NOT NULL DEFAULT now(),
          is_system boolean NOT NULL DEFAULT false,
          event_source text NOT NULL DEFAULT 'ingest'
        ) PARTITION BY RANGE ("timestamp");
        CREATE TABLE events_default PARTITION OF events DEFAULT;
        INSERT INTO events (
          project_id, env, event, "timestamp", distinct_id, properties
        ) VALUES
          ('${projectId}', 'prod', 'legacy.one', now() - interval '2 days', 'u1', '{"old":1}'),
          ('${projectId}', 'prod', 'legacy.two', now() - interval '1 day', 'u2', '{"old":2}');
      `);
      const migration = await readFile(resolve('migrations/032_event_backfill_revisions.sql'), 'utf8');
      await client.query(migration);
      await client.query('COMMIT');
      scopedPool = new pg.Pool({
        connectionString: TEST_DB_URL,
        options: `-c timezone=UTC -c search_path=${schema},public`,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await scopedPool.end();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it('adds stable ids to every existing row without recreating or losing events', async () => {
    const rows = await pool.query<{
      id: string;
      event: string;
      revision: number;
      origin: string;
    }>(
      `SELECT id, event, revision, origin FROM ${schema}.events ORDER BY event`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row) => row.id)).size).toBe(2);
    expect(rows.rows).toEqual([
      expect.objectContaining({ event: 'legacy.one', revision: 1, origin: 'live' }),
      expect.objectContaining({ event: 'legacy.two', revision: 1, origin: 'live' }),
    ]);
  });

  it('assigns ids to new rows and keeps audit tables append-only', async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO ${schema}.events (
         project_id, env, event, "timestamp", distinct_id
       ) VALUES ($1, 'prod', 'new.event', now(), 'u3')
       RETURNING id`,
      [projectId],
    );
    expect(inserted.rows[0]?.id).toMatch(/^[a-f0-9-]{36}$/);

    const batch = await pool.query<{ id: string }>(
      `INSERT INTO ${schema}.event_backfill_batches (
         project_id, env, batch_id, payload_sha256, reason, actor,
         event_count, registered_count, unregistered_count,
         min_timestamp, max_timestamp
       ) VALUES (
         $1, 'prod', 'batch-1', $2, 'Trusted migration fixture reason.',
         'test:actor', 1, 1, 0, now(), now()
       ) RETURNING id`,
      [projectId, 'a'.repeat(64)],
    );
    await expect(pool.query(
      `UPDATE ${schema}.event_backfill_batches SET reason = 'Changed reason is forbidden.'
       WHERE id = $1`,
      [batch.rows[0]?.id],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('allows audit rows to follow an intentional project cascade', async () => {
    const cascadeProject = '00000000-0000-0000-0000-000000000033';
    await pool.query(`INSERT INTO ${schema}.projects (id) VALUES ($1)`, [cascadeProject]);
    await pool.query(
      `INSERT INTO ${schema}.event_backfill_batches (
         project_id, env, batch_id, payload_sha256, reason, actor,
         event_count, registered_count, unregistered_count,
         min_timestamp, max_timestamp
       ) VALUES (
         $1, 'prod', 'cascade-batch', $2, 'Cascade cleanup fixture reason.',
         'test:actor', 1, 0, 1, now(), now()
       )`,
      [cascadeProject, 'b'.repeat(64)],
    );
    await expect(pool.query(
      `DELETE FROM ${schema}.projects WHERE id = $1`,
      [cascadeProject],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it('keeps historical writes ready when existing rows require the DEFAULT partition', async () => {
    const now = new Date();
    await expect(ensureHistoricalEventPartitions(scopedPool, now, 0)).resolves.toBeUndefined();
    await expect(historicalEventPartitionsReady(scopedPool, now, 0)).resolves.toBe(true);
    await expect(rollingEventPartitionsReady(scopedPool, now, 0)).resolves.toBe(true);
    const rows = await scopedPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM events_default',
    );
    expect(rows.rows[0]?.count).toBeGreaterThan(0);
  });
});
