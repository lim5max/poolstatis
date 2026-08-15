import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool, discoverMigrationFiles } from '../src/db.js';
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
      database = createPool(databaseUrl.toString(), { max: 1 });
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
      await database.query(
        `INSERT INTO replay_project_deletion_jobs (project_id, actor)
         VALUES ($1,'upgrade:test')`,
        [projectId],
      );
      await database.query(
        `INSERT INTO replay_project_deletion_artifacts (project_id, artifact_key)
         VALUES ($1,'durable/snapshot.png')`,
        [projectId],
      );
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
      )).rows).toEqual([{ artifact_key: 'durable/snapshot.png' }]);
    } finally {
      await database?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end();
    }
  }, 90_000);
});
