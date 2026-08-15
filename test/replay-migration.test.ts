import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool, discoverMigrationFiles, migrate } from '../src/db.js';
import { ADMIN_URL } from './urls.js';

describe('session replay hardening migration upgrade', () => {
  it('upgrades an applied 042 database and leaves a deletion job past project cascade', async () => {
    const databaseName = `poolsatis_replay_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(ADMIN_URL, { max: 1 });
    let database: ReturnType<typeof createPool> | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const databaseUrl = new URL(ADMIN_URL);
      databaseUrl.pathname = `/${databaseName}`;
      database = createPool(databaseUrl.toString(), { max: 4 });
      const migrations = await discoverMigrationFiles();
      for (const migration of migrations.filter((name) => name < '043_')) {
        await database.query(await readFile(resolve('migrations', migration), 'utf8'));
      }
      const fixture = await database.query<{
        project_id: string;
        surface_id: string;
        route_id: string;
      }>(
        `WITH organization AS (
           INSERT INTO organizations (name) VALUES ('Replay upgrade') RETURNING id
         ), project AS (
           INSERT INTO projects (org_id, slug, name)
           SELECT id, 'replay-upgrade', 'Replay upgrade' FROM organization RETURNING id
         ), surface AS (
           INSERT INTO experience_surfaces (project_id, key, name, purpose)
           SELECT id, 'workspace', 'Workspace', 'Verify replay migration upgrade.' FROM project
           RETURNING id, project_id
         ), route AS (
           INSERT INTO experience_routes (project_id, surface_id, key, name, path_pattern)
           SELECT project_id, id, 'workspace', 'Workspace', '/workspace' FROM surface
           RETURNING id
         )
         SELECT project.id AS project_id, surface.id AS surface_id, route.id AS route_id
         FROM project, surface, route`,
      );
      const { project_id: projectId, surface_id: surfaceId, route_id: routeId } = fixture.rows[0]!;
      const replay = await database.query<{ id: string }>(
        `INSERT INTO replay_sessions (
           project_id, surface_id, route_id, env, session_id, distinct_id, host,
           version, device, consent_version, policy_version, policy_hash,
           text_mode, upload_token_hash, delete_after
         ) VALUES ($1,$2,$3,'prod','session-upgrade','actor-upgrade','app.example.test',
           'release-upgrade','desktop','consent-v1','privacy-v1',$4,'masked',$4,now() + interval '7 days')
         RETURNING id`,
        [projectId, surfaceId, routeId, 'a'.repeat(64)],
      );

      // Some pre-merge test installations applied an early 042 that already
      // carried these three hardening objects under their final names. The
      // numbered 043 must upgrade both that state and the released base 042.
      await database.query(
        `ALTER TABLE replay_sessions
           ADD COLUMN mask_selectors text[] NOT NULL DEFAULT '{}'
             CHECK (cardinality(mask_selectors) <= 20),
           ADD COLUMN block_selectors text[] NOT NULL DEFAULT '{}'
             CHECK (cardinality(block_selectors) <= 20);
         ALTER TABLE replay_audit_log
           DROP CONSTRAINT replay_audit_log_action_check,
           ADD CONSTRAINT replay_audit_log_action_check
             CHECK (action IN ('view', 'delete_requested', 'delete_completed'));
         CREATE UNIQUE INDEX replay_audit_delete_once_idx
           ON replay_audit_log (replay_id, action)
           WHERE action IN ('delete_requested', 'delete_completed');
         CREATE TRIGGER replay_audit_log_append_only
           BEFORE UPDATE OR DELETE ON replay_audit_log
           FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();`,
      );

      await database.query(
        await readFile(resolve('migrations/043_session_replay_hardening.sql'), 'utf8'),
      );
      await database.query(
        await readFile(resolve('migrations/044_session_replay_project_deletion_phases.sql'), 'utf8'),
      );
      expect((await database.query<{
        mask_selectors: string[];
        block_selectors: string[];
        retry_ready: boolean;
        claim_ready: boolean;
      }>(
        `SELECT mask_selectors, block_selectors,
           delete_retry_after = '-infinity'::timestamptz AS retry_ready,
           deletion_claimed_until = '-infinity'::timestamptz AS claim_ready
         FROM replay_sessions WHERE id = $1`,
        [replay.rows[0]!.id],
      )).rows).toEqual([{
        mask_selectors: [], block_selectors: [], retry_ready: true, claim_ready: true,
      }]);
      await database.query(
        `INSERT INTO replay_audit_log (project_id, replay_id, actor, action)
         VALUES
           ($1,$2,'upgrade:test','delete_requested'),
           ($1,$2,'upgrade:test','delete_completed')`,
        [projectId, replay.rows[0]!.id],
      );
      const snapshotId = randomUUID();
      const artifactKey = `${projectId}/${snapshotId}.png`;
      const advisoryKey = '8675309123';
      await database.query(
        `CREATE FUNCTION poolstatis_test_pause_snapshot()
         RETURNS trigger AS $test_pause$
         BEGIN
           PERFORM pg_advisory_xact_lock(8675309123);
           RETURN NEW;
         END
         $test_pause$ LANGUAGE plpgsql;
         CREATE TRIGGER zz_test_pause_snapshot
           BEFORE INSERT ON experience_snapshots
           FOR EACH ROW EXECUTE FUNCTION poolstatis_test_pause_snapshot();`,
      );
      const controller = await database.connect();
      const deletionClient = await database.connect();
      let controllerLocked = false;
      try {
        await controller.query('SELECT pg_advisory_lock($1::bigint)', [advisoryKey]);
        controllerLocked = true;
        const snapshotInsert = database.query(
          `INSERT INTO experience_snapshots (
             id, project_id, surface_id, route_id, env, version, device, release_hash,
             artifact_key, mime_type, byte_size, width, height, viewport_width,
             viewport_height, document_width, document_height, captured_at, expires_at
           ) VALUES ($1,$2,$3,$4,'prod','v1','desktop',$5,$6,'image/png',1,1,1,240,240,1,1,$7,$8)`,
          [
            snapshotId, projectId, surfaceId, routeId, 'b'.repeat(64), artifactKey,
            new Date(), new Date(Date.now() + 86_400_000),
          ],
        );
        await waitForDatabaseState(async () => {
          const waiting = await database!.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event = 'advisory'
             ) AS waiting`,
          );
          return waiting.rows[0]?.waiting === true;
        }, 'snapshot insert did not reach the deterministic pause trigger');

        const deletionPid = (await deletionClient.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        let deletionSettled = false;
        const deletion = (async () => {
          await deletionClient.query('BEGIN');
          await deletionClient.query(
            'UPDATE projects SET replay_deletion_pending = true WHERE id = $1',
            [projectId],
          );
          await deletionClient.query(
            `INSERT INTO replay_project_deletion_jobs (project_id, actor)
             VALUES ($1,'upgrade:test')`,
            [projectId],
          );
          await deletionClient.query(
            `INSERT INTO replay_project_deletion_artifacts (project_id, artifact_key)
             SELECT $1, artifact_key FROM experience_snapshots WHERE project_id = $1`,
            [projectId],
          );
          await deletionClient.query('COMMIT');
        })().finally(() => { deletionSettled = true; });
        await waitForDatabaseState(async () => {
          const waiting = await database!.query<{ waiting: boolean }>(
            `SELECT wait_event_type = 'Lock' AS waiting
             FROM pg_stat_activity WHERE pid = $1`,
            [deletionPid],
          );
          return waiting.rows[0]?.waiting === true;
        }, 'project deletion did not wait for the snapshot project-row share lock');
        expect(deletionSettled).toBe(false);

        await controller.query('SELECT pg_advisory_unlock($1::bigint)', [advisoryKey]);
        controllerLocked = false;
        await snapshotInsert;
        await deletion;
      } catch (error) {
        await deletionClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        if (controllerLocked) {
          await controller.query('SELECT pg_advisory_unlock($1::bigint)', [advisoryKey])
            .catch(() => undefined);
        }
        controller.release();
        deletionClient.release();
      }
      await database.query('DELETE FROM projects WHERE id = $1', [projectId]);
      expect((await database.query<{ action: string; actor: string }>(
        `SELECT action, actor FROM replay_audit_log
         WHERE project_id = $1 ORDER BY id`,
        [projectId],
      )).rows).toEqual([
        { action: 'delete_requested', actor: 'upgrade:test' },
        { action: 'delete_completed', actor: 'upgrade:test' },
      ]);
      const immutableClient = await database.connect();
      try {
        await expect(immutableClient.query(
          'DELETE FROM replay_audit_log WHERE project_id = $1',
          [projectId],
        )).rejects.toThrow('append-only');
      } finally {
        immutableClient.release();
      }
      expect((await database.query(
        'SELECT 1 FROM replay_project_deletion_jobs WHERE project_id = $1',
        [projectId],
      )).rowCount).toBe(1);
      expect((await database.query<{ artifact_key: string }>(
        'SELECT artifact_key FROM replay_project_deletion_artifacts WHERE project_id = $1',
        [projectId],
      )).rows).toEqual([{ artifact_key: artifactKey }]);
    } finally {
      await closeAndDropTestDatabase(admin, database, databaseName);
      await admin.end();
    }
  }, 90_000);

  it('applies 044 after the pre-phases 043 was already recorded', async () => {
    const databaseName = `poolsatis_replay_043_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(ADMIN_URL, { max: 1 });
    let database: ReturnType<typeof createPool> | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const databaseUrl = new URL(ADMIN_URL);
      databaseUrl.pathname = `/${databaseName}`;
      database = createPool(databaseUrl.toString(), { max: 1 });
      const migrations = await discoverMigrationFiles();
      await database.query(
        `CREATE TABLE schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      for (const migration of migrations.filter((name) => name < '043_')) {
        await database.query(await readFile(resolve('migrations', migration), 'utf8'));
        await database.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration]);
      }
      await database.query(
        await readFile(resolve('test/fixtures/043_session_replay_hardening_pre_phases.sql'), 'utf8'),
      );
      await database.query(
        `INSERT INTO schema_migrations (name)
         VALUES ('043_session_replay_hardening.sql')`,
      );

      await expect(migrate(database)).resolves.toEqual([
        '044_session_replay_project_deletion_phases.sql',
      ]);
      const columns = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'replay_project_deletion_jobs'
           AND column_name IN ('phase','artifacts_deleted','events_deleted','replays_deleted')
         ORDER BY column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'artifacts_deleted', 'events_deleted', 'phase', 'replays_deleted',
      ]);
      expect((await database.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'replay_project_deletion_artifacts'`,
      )).rowCount).toBe(1);
      const trigger = await database.query<{ definition: string }>(
        `SELECT pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p WHERE p.proname = 'poolstatis_reject_snapshot_for_deleting_project'`,
      );
      expect(trigger.rows[0]?.definition).toContain('FOR SHARE');
    } finally {
      await closeAndDropTestDatabase(admin, database, databaseName);
      await admin.end();
    }
  }, 90_000);
});

async function waitForDatabaseState(
  predicate: () => Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function closeAndDropTestDatabase(
  admin: ReturnType<typeof createPool>,
  database: ReturnType<typeof createPool> | undefined,
  databaseName: string,
): Promise<void> {
  await database?.end();
  await waitForDatabaseState(async () => {
    const active = await admin.query<{ connections: number }>(
      `SELECT count(*)::int AS connections
       FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    return active.rows[0]?.connections === 0;
  }, `database pool for ${databaseName} did not close cleanly`);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
}
