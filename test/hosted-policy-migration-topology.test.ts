import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { createPool, migrate } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import {
  assertHostedDatabaseRoleSeparation,
  prepareHostedOrganizationPolicies,
} from '../src/services/accounts.js';
import {
  ensureRetentionIndexes,
  retentionIndexesReady,
} from '../src/services/retentionIndexes.js';
import {
  ensureRollingEventPartitions,
  rollingEventPartitionsReady,
} from '../src/stores/postgresEventStore.js';
import {
  createApiKey,
  createOrganization,
  createProject,
} from '../src/services/projects.js';

const execFileAsync = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return stdout.trim();
}

async function waitForDatabase(databaseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('isolated postgres did not become ready');
}

interface IsolatedPostgres {
  container: string;
  port: number;
  bootstrap: pg.Pool;
  close(): Promise<void>;
}

async function startIsolatedPostgres(label: string): Promise<IsolatedPostgres> {
  const suffix = `${label}-${process.pid}-${Date.now()}`;
  const container = `poolstatis-policy-${suffix}`;
  const bootstrapPassword = `bootstrap-${suffix}`;
  await docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--env',
    `POSTGRES_PASSWORD=${bootstrapPassword}`,
    '--env',
    'POSTGRES_USER=bootstrap',
    '--env',
    'POSTGRES_DB=postgres',
    '--publish',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  );
  const portOutput = await docker('port', container, '5432/tcp');
  const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!portMatch) {
    await docker('rm', '--force', container).catch(() => {});
    throw new Error(`unexpected docker port output: ${portOutput}`);
  }
  const port = Number(portMatch[1]);
  const bootstrapUrl =
    `postgres://bootstrap:${encodeURIComponent(bootstrapPassword)}@127.0.0.1:${port}/postgres`;
  await waitForDatabase(bootstrapUrl);
  const bootstrap = createPool(bootstrapUrl, { max: 1 });
  return {
    container,
    port,
    bootstrap,
    async close() {
      await bootstrap.end().catch(() => {});
      await docker('rm', '--force', container).catch(() => {});
    },
  };
}

async function migrateWithEvidence(pool: pg.Pool): Promise<string[]> {
  try {
    return await migrate(pool);
  } catch (error) {
    const recorded = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}; last applied migration: ${recorded.rows.at(-1)?.name ?? 'none'}`,
      { cause: error },
    );
  }
}

function databaseUrl(port: number, user: string, password: string, database: string): string {
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

describe('hosted policy migration role topology', () => {
  it('runs real Core HTTP as a restricted runtime after a bootstrapped non-superuser migration', async () => {
    const isolated = await startIsolatedPostgres('positive');
    const deployPassword = `deploy-${process.pid}`;
    const corePassword = `core-${process.pid}`;
    const cloudPassword = `cloud-${process.pid}`;
    let deploy: pg.Pool | undefined;
    let coreRuntime: pg.Pool | undefined;
    let cloudRuntime: pg.Pool | undefined;
    let app: FastifyInstance | undefined;

    try {
      await isolated.bootstrap.query(
        `CREATE ROLE core_deploy LOGIN PASSWORD '${deployPassword}'
         CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION;
         CREATE ROLE poolstatis_policy_owner NOLOGIN NOINHERIT;
         CREATE ROLE poolstatis_core_runtime NOLOGIN NOINHERIT;
         CREATE ROLE poolstatis_policy_activator NOLOGIN NOINHERIT;
         GRANT poolstatis_policy_owner TO core_deploy WITH ADMIN TRUE;
         GRANT poolstatis_policy_owner TO core_deploy WITH SET TRUE;
         GRANT poolstatis_core_runtime TO core_deploy WITH ADMIN TRUE;
         GRANT poolstatis_core_runtime TO core_deploy WITH INHERIT FALSE;
         GRANT poolstatis_policy_activator TO core_deploy WITH ADMIN TRUE;
         GRANT poolstatis_policy_activator TO core_deploy WITH INHERIT FALSE`,
      );
      await isolated.bootstrap.query('CREATE DATABASE poolstatis_core OWNER core_deploy');

      const deployUrl = databaseUrl(
        isolated.port,
        'core_deploy',
        deployPassword,
        'poolstatis_core',
      );
      deploy = createPool(deployUrl, { max: 2 });
      const applied = await migrateWithEvidence(deploy);
      expect(applied.at(-1)).toBe(
        '034_project_deletion.sql',
      );
      const beforePrepare = await deploy.query<{
        marker_owner: string;
        runtime_can_write_projects: boolean;
      }>(
        `SELECT
           (SELECT pg_get_userbyid(relowner)
            FROM pg_class
            WHERE oid = 'organization_policy_state'::regclass) AS marker_owner,
           has_table_privilege(
             'poolstatis_core_runtime',
             'projects',
             'INSERT'
           ) AS runtime_can_write_projects`,
      );
      expect(beforePrepare.rows).toEqual([{
        marker_owner: 'core_deploy',
        runtime_can_write_projects: false,
      }]);
      await deploy.query(
        'SELECT poolstatis_prepare_hosted_policy_role_hardening()',
      );
      await deploy.query(
        'SELECT poolstatis_prepare_visual_experience_role_grants()',
      );
      await deploy.query(
        'SELECT poolstatis_prepare_metric_taxonomy_role_grants()',
      );
      await deploy.query(
        'SELECT poolstatis_prepare_hosted_policy_role_hardening()',
      );
      await ensureRollingEventPartitions(deploy, new Date(), 12);
      expect(await rollingEventPartitionsReady(deploy, new Date(), 12)).toBe(true);
      expect((await ensureRetentionIndexes(deploy)).ready).toBe(true);

      const deployAttributes = await deploy.query<{
        superuser: boolean;
        create_role: boolean;
        create_db: boolean;
        core_admin: boolean;
        activator_admin: boolean;
        owner_schema_create: boolean;
      }>(
        `SELECT
           current_setting('is_superuser')::boolean AS superuser,
           (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS create_role,
           (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS create_db,
           EXISTS (
             SELECT 1 FROM pg_auth_members am
             JOIN pg_roles granted_role ON granted_role.oid = am.roleid
             JOIN pg_roles member_role ON member_role.oid = am.member
             WHERE granted_role.rolname = 'poolstatis_core_runtime'
               AND member_role.rolname = current_user AND am.admin_option
           ) AS core_admin,
           EXISTS (
             SELECT 1 FROM pg_auth_members am
             JOIN pg_roles granted_role ON granted_role.oid = am.roleid
             JOIN pg_roles member_role ON member_role.oid = am.member
             WHERE granted_role.rolname = 'poolstatis_policy_activator'
               AND member_role.rolname = current_user AND am.admin_option
           ) AS activator_admin,
           has_schema_privilege('poolstatis_policy_owner', 'public', 'CREATE')
             AS owner_schema_create`,
      );
      expect(deployAttributes.rows).toEqual([{
        superuser: false,
        create_role: true,
        create_db: false,
        core_admin: true,
        activator_admin: true,
        owner_schema_create: false,
      }]);

      await deploy.query(
        `CREATE ROLE core_runtime_login LOGIN INHERIT PASSWORD '${corePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
         CREATE ROLE cloud_runtime_login LOGIN INHERIT PASSWORD '${cloudPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
         GRANT poolstatis_core_runtime TO core_runtime_login WITH INHERIT TRUE;
         GRANT poolstatis_core_runtime TO core_runtime_login WITH SET FALSE;
         GRANT poolstatis_policy_activator TO cloud_runtime_login WITH INHERIT TRUE;
         GRANT poolstatis_policy_activator TO cloud_runtime_login WITH SET FALSE`,
      );

      coreRuntime = createPool(
        databaseUrl(isolated.port, 'core_runtime_login', corePassword, 'poolstatis_core'),
        { max: 4 },
      );
      cloudRuntime = createPool(
        databaseUrl(isolated.port, 'cloud_runtime_login', cloudPassword, 'poolstatis_core'),
        { max: 1 },
      );
      await expect(assertHostedDatabaseRoleSeparation(
        deploy,
        coreRuntime,
        true,
      )).resolves.toBeUndefined();
      await expect(retentionIndexesReady(coreRuntime)).resolves.toBe(true);
      await expect(prepareHostedOrganizationPolicies(coreRuntime, true)).resolves.toBe(0);
      await expect(coreRuntime.query(
        'SELECT poolstatis_activate_organization_policy($1)',
        ['00000000-0000-4000-8000-000000000098'],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(coreRuntime.query(
        'SELECT * FROM organization_policy_state',
      )).rejects.toMatchObject({ code: '42501' });
      await expect(coreRuntime.query(
        'SELECT * FROM schema_migrations',
      )).rejects.toMatchObject({ code: '42501' });
      await expect(coreRuntime.query(
        'CREATE TABLE runtime_must_not_create_tables (id int)',
      )).rejects.toMatchObject({ code: '42501' });
      await expect(coreRuntime.query(
        'SELECT count(*)::int AS count FROM metric_categories',
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });

      const pair = await generateKeyPair('RS256');
      const publicJwk = await exportJWK(pair.publicKey);
      const jwks: { keys: JWK[] } = {
        keys: [{ ...publicJwk, kid: 'isolated-key', alg: 'RS256', use: 'sig' }],
      };
      const issuer = 'https://isolated-policy-auth.test/';
      const audience = 'https://isolated-policy-api.test/';
      const token = await new SignJWT({
        email: 'isolated-owner@example.test',
        email_verified: true,
        name: 'Isolated Owner',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'isolated-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('auth0|isolated-owner')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(pair.privateKey);
      app = buildServer(coreRuntime, {
        auth: {
          issuer,
          audience,
          jwks: async () => jwks,
          requireOrganizationPolicy: true,
        },
        ingestBuffer: false,
        manageEventPartitions: false,
      });
      const api = async (
        bearer: string,
        method: 'GET' | 'POST',
        url: string,
        payload?: unknown,
      ) => {
        const response = await app!.inject({
          method,
          url,
          headers: { authorization: `Bearer ${bearer}` },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
        return { status: response.statusCode, body: response.json() };
      };

      const profile = await api(token, 'GET', '/api/v1/me');
      expect(profile.status).toBe(200);
      const organizationId = profile.body.organization.id as string;
      const pending = await api(token, 'POST', '/api/v1/projects', {
        slug: 'isolated-project',
        name: 'Isolated project',
      });
      expect(pending.status).toBe(402);
      expect(pending.body.error.code).toBe('organization_write_disabled');

      await expect(cloudRuntime.query(
        'SELECT poolstatis_activate_organization_policy($1) AS activated',
        [organizationId],
      )).resolves.toMatchObject({ rows: [{ activated: true }] });
      await expect(cloudRuntime.query(
        'SELECT * FROM organization_policy_state',
      )).rejects.toMatchObject({ code: '42501' });
      await expect(cloudRuntime.query(
        'SELECT poolstatis_require_organization_policy($1)',
        [organizationId],
      )).rejects.toMatchObject({ code: '42501' });

      const project = await api(token, 'POST', '/api/v1/projects', {
        slug: 'isolated-project',
        name: 'Isolated project',
      });
      expect(project.status).toBe(201);
      const ingestKey = await api(
        token,
        'POST',
        '/api/v1/projects/isolated-project/keys',
        { kind: 'ingest', env: 'prod', label: 'Isolated ingest' },
      );
      expect(ingestKey.status).toBe(201);
      const metric = await api(token, 'POST', '/api/v1/projects/isolated-project/metrics', {
        key: 'isolated_events',
        name: 'Isolated events',
        type: 'count',
        purpose: 'Proves the restricted Core runtime can serve the real hosted data path.',
        source: { event: 'isolated.event' },
      });
      expect(metric.status).toBe(201);
      const ingested = await api(ingestKey.body.token, 'POST', '/i/v1/events', {
        events: [{ event: 'isolated.event', distinct_id: 'isolated-actor' }],
      });
      expect(ingested.status).toBe(200);
      expect(ingested.body.accepted).toBe(1);
      const storedPartition = await deploy.query<{ partition: string }>(
        `SELECT tableoid::regclass::text AS partition
         FROM events WHERE event = 'isolated.event'`,
      );
      const now = new Date();
      expect(storedPartition.rows).toEqual([{
        partition:
          `events_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
      }]);
      const queried = await api(
        token,
        'POST',
        '/api/v1/projects/isolated-project/query',
        { kind: 'trend', metric: 'isolated_events', date_from: '-1d', interval: 'day' },
      );
      expect(queried.status).toBe(200);
      expect(queried.body.series.reduce(
        (total: number, point: { value: number }) => total + point.value,
        0,
      )).toBe(1);
    } finally {
      await app?.close().catch(() => {});
      await cloudRuntime?.end().catch(() => {});
      await coreRuntime?.end().catch(() => {});
      await deploy?.end().catch(() => {});
      await isolated.close();
    }
  }, 90_000);

  it('keeps migration schema-only and fails explicit hosted preparation when roles were not bootstrapped', async () => {
    const isolated = await startIsolatedPostgres('negative');
    const deployPassword = `deploy-negative-${process.pid}`;
    let deploy: pg.Pool | undefined;
    try {
      await isolated.bootstrap.query(
        `CREATE ROLE unbootstrapped_deploy LOGIN PASSWORD '${deployPassword}'
         CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION;
         CREATE ROLE poolstatis_policy_owner NOLOGIN NOINHERIT;
         CREATE ROLE poolstatis_core_runtime NOLOGIN NOINHERIT;
         CREATE ROLE poolstatis_policy_activator NOLOGIN NOINHERIT`,
      );
      await isolated.bootstrap.query(
        'CREATE DATABASE poolstatis_unbootstrapped OWNER unbootstrapped_deploy',
      );
      deploy = createPool(
        databaseUrl(
          isolated.port,
          'unbootstrapped_deploy',
          deployPassword,
          'poolstatis_unbootstrapped',
        ),
        { max: 1 },
      );
      await expect(migrateWithEvidence(deploy)).resolves.toContain(
        '027_hosted_policy_readiness.sql',
      );
      await expect(deploy.query(
        'SELECT poolstatis_apply_hosted_policy_role_hardening()',
      )).rejects.toThrow(
        'hosted policy hardening requires poolstatis_policy_owner SET membership',
      );
      const state = await deploy.query<{
        last_migration: string;
        marker_table: string | null;
        policy_functions: string;
        policy_triggers: number;
      }>(
        `SELECT
           (SELECT max(name) FROM schema_migrations) AS last_migration,
           to_regclass('public.organization_policy_state')::text AS marker_table,
           (SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc
            WHERE proname LIKE 'poolstatis_%organization_policy%') AS policy_functions,
           (SELECT count(*)::int FROM pg_trigger
            WHERE tgname LIKE '%policy_ready') AS policy_triggers`,
      );
      expect(state.rows).toEqual([{
        last_migration: '034_project_deletion.sql',
        marker_table: 'organization_policy_state',
        policy_functions: [
          'poolstatis_activate_organization_policy',
          'poolstatis_backfill_organization_policy_state',
          'poolstatis_enforce_organization_policy_ready',
          'poolstatis_organization_policy_allows_writes',
          'poolstatis_protect_organization_policy_state',
          'poolstatis_require_organization_policy',
        ].join(','),
        policy_triggers: 3,
      }]);
    } finally {
      await deploy?.end().catch(() => {});
      await isolated.close();
    }
  }, 90_000);

  it('converts a CREATEROLE self-host database through explicit hosted preparation without replaying 027', async () => {
    const isolated = await startIsolatedPostgres('selfhost-createrole');
    const selfHostPassword = `selfhost-createrole-${process.pid}`;
    const corePassword = `converted-core-${process.pid}`;
    const cloudPassword = `converted-cloud-${process.pid}`;
    let selfHost: pg.Pool | undefined;
    let coreRuntime: pg.Pool | undefined;
    let cloudRuntime: pg.Pool | undefined;
    let app: FastifyInstance | undefined;
    try {
      await isolated.bootstrap.query(
        `CREATE ROLE selfhost_createrole_owner LOGIN PASSWORD '${selfHostPassword}'
         NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION`,
      );
      await isolated.bootstrap.query(
        'CREATE DATABASE poolstatis_selfhost_createrole OWNER selfhost_createrole_owner',
      );
      selfHost = createPool(
        databaseUrl(
          isolated.port,
          'selfhost_createrole_owner',
          selfHostPassword,
          'poolstatis_selfhost_createrole',
        ),
        { max: 1 },
      );
      await expect(migrateWithEvidence(selfHost)).resolves.toContain(
        '027_hosted_policy_readiness.sql',
      );
      const topology = await selfHost.query<{
        stable_roles: number;
        marker_owner: string;
      }>(
        `SELECT
           (SELECT count(*)::int
            FROM pg_roles
            WHERE rolname IN (
              'poolstatis_policy_owner',
              'poolstatis_core_runtime',
              'poolstatis_policy_activator'
            )) AS stable_roles,
           (SELECT pg_get_userbyid(relowner)
            FROM pg_class
            WHERE oid = 'organization_policy_state'::regclass) AS marker_owner`,
      );
      expect(topology.rows).toEqual([{
        stable_roles: 0,
        marker_owner: 'selfhost_createrole_owner',
      }]);

      await isolated.bootstrap.query(
        `CREATE ROLE poolstatis_policy_owner NOLOGIN NOINHERIT;
         CREATE ROLE poolstatis_core_runtime NOLOGIN NOINHERIT;
         CREATE ROLE poolstatis_policy_activator NOLOGIN NOINHERIT;
         GRANT poolstatis_policy_owner TO selfhost_createrole_owner WITH ADMIN TRUE;
         GRANT poolstatis_policy_owner TO selfhost_createrole_owner WITH SET TRUE;
         GRANT poolstatis_core_runtime TO selfhost_createrole_owner WITH ADMIN TRUE;
         GRANT poolstatis_core_runtime TO selfhost_createrole_owner WITH INHERIT FALSE;
         GRANT poolstatis_policy_activator TO selfhost_createrole_owner WITH ADMIN TRUE;
         GRANT poolstatis_policy_activator TO selfhost_createrole_owner WITH INHERIT FALSE`,
      );
      await selfHost.query('SELECT poolstatis_apply_hosted_policy_role_hardening()');
      await selfHost.query('SELECT poolstatis_prepare_visual_experience_role_grants()');
      await selfHost.query('SELECT poolstatis_prepare_metric_taxonomy_role_grants()');
      await selfHost.query('SELECT poolstatis_apply_hosted_policy_role_hardening()');
      await ensureRollingEventPartitions(selfHost, new Date(), 12);
      await ensureRetentionIndexes(selfHost);
      expect(await migrateWithEvidence(selfHost)).toEqual([]);
      await expect(selfHost.query(
        `SELECT count(*)::int AS applied
         FROM schema_migrations
         WHERE name = '027_hosted_policy_readiness.sql'`,
      )).resolves.toMatchObject({ rows: [{ applied: 1 }] });

      await selfHost.query(
        `CREATE ROLE converted_core_runtime LOGIN INHERIT PASSWORD '${corePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
         CREATE ROLE converted_cloud_runtime LOGIN INHERIT PASSWORD '${cloudPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
         GRANT poolstatis_core_runtime TO converted_core_runtime WITH INHERIT TRUE;
         GRANT poolstatis_core_runtime TO converted_core_runtime WITH SET FALSE;
         GRANT poolstatis_policy_activator TO converted_cloud_runtime WITH INHERIT TRUE;
         GRANT poolstatis_policy_activator TO converted_cloud_runtime WITH SET FALSE`,
      );
      coreRuntime = createPool(
        databaseUrl(
          isolated.port,
          'converted_core_runtime',
          corePassword,
          'poolstatis_selfhost_createrole',
        ),
        { max: 4 },
      );
      cloudRuntime = createPool(
        databaseUrl(
          isolated.port,
          'converted_cloud_runtime',
          cloudPassword,
          'poolstatis_selfhost_createrole',
        ),
        { max: 1 },
      );
      await assertHostedDatabaseRoleSeparation(selfHost, coreRuntime, true);
      await expect(prepareHostedOrganizationPolicies(coreRuntime, true)).resolves.toBe(0);

      const pair = await generateKeyPair('RS256');
      const publicJwk = await exportJWK(pair.publicKey);
      const issuer = 'https://converted-policy-auth.test/';
      const audience = 'https://converted-policy-api.test/';
      const token = await new SignJWT({
        email: 'converted-owner@example.test',
        email_verified: true,
        name: 'Converted Owner',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'converted-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('auth0|converted-owner')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(pair.privateKey);
      app = buildServer(coreRuntime, {
        auth: {
          issuer,
          audience,
          jwks: async () => ({
            keys: [{ ...publicJwk, kid: 'converted-key', alg: 'RS256', use: 'sig' }],
          }),
          requireOrganizationPolicy: true,
        },
        ingestBuffer: false,
        manageEventPartitions: false,
      });
      const profile = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(profile.statusCode).toBe(200);
      const organizationId = profile.json().organization.id as string;
      const pending = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${token}` },
        payload: { slug: 'converted-project', name: 'Converted project' },
      });
      expect(pending.statusCode).toBe(402);
      await expect(cloudRuntime.query(
        'SELECT poolstatis_activate_organization_policy($1) AS activated',
        [organizationId],
      )).resolves.toMatchObject({ rows: [{ activated: true }] });
      const projectProbe = await coreRuntime.connect();
      try {
        await projectProbe.query('BEGIN');
        await projectProbe.query(
          `INSERT INTO projects (org_id, slug, name)
           VALUES ($1, 'taxonomy-trigger-probe', 'Taxonomy trigger probe')`,
          [organizationId],
        );
        await projectProbe.query('ROLLBACK');
      } catch (error) {
        await projectProbe.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        projectProbe.release();
      }
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${token}` },
        payload: { slug: 'converted-project', name: 'Converted project' },
      });
      expect(created.statusCode, created.body).toBe(201);
    } finally {
      await app?.close().catch(() => {});
      await cloudRuntime?.end().catch(() => {});
      await coreRuntime?.end().catch(() => {});
      await selfHost?.end().catch(() => {});
      await isolated.close();
    }
  }, 90_000);

  it('keeps full self-host migration and startup available to a database owner without CREATEROLE', async () => {
    const isolated = await startIsolatedPostgres('selfhost');
    const selfHostPassword = `selfhost-${process.pid}`;
    let selfHost: pg.Pool | undefined;
    let app: FastifyInstance | undefined;
    try {
      await isolated.bootstrap.query(
        `CREATE ROLE selfhost_owner LOGIN PASSWORD '${selfHostPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await isolated.bootstrap.query(
        'CREATE DATABASE poolstatis_selfhost OWNER selfhost_owner',
      );
      selfHost = createPool(
        databaseUrl(
          isolated.port,
          'selfhost_owner',
          selfHostPassword,
          'poolstatis_selfhost',
        ),
        { max: 4 },
      );
      const applied = await migrateWithEvidence(selfHost);
      expect(applied.at(-1)).toBe(
        '034_project_deletion.sql',
      );
      const topology = await selfHost.query<{
        superuser: boolean;
        create_role: boolean;
        policy_owner_exists: boolean;
        marker_owner: string;
      }>(
        `SELECT
           current_setting('is_superuser')::boolean AS superuser,
           (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS create_role,
           EXISTS (
             SELECT 1 FROM pg_roles WHERE rolname = 'poolstatis_policy_owner'
           ) AS policy_owner_exists,
           (SELECT pg_get_userbyid(relowner)
            FROM pg_class
            WHERE oid = 'organization_policy_state'::regclass) AS marker_owner`,
      );
      expect(topology.rows).toEqual([{
        superuser: false,
        create_role: false,
        policy_owner_exists: false,
        marker_owner: 'selfhost_owner',
      }]);

      const organization = await createOrganization(selfHost, 'Self-host no CREATEROLE');
      const project = await createProject(
        selfHost,
        organization.id,
        'selfhost-no-createrole',
        'Self-host no CREATEROLE',
      );
      const ingest = await createApiKey(selfHost, {
        orgId: organization.id,
        projectId: project.id,
        kind: 'ingest',
      });
      app = buildServer(selfHost, { ingestBuffer: false });
      const response = await app.inject({
        method: 'POST',
        url: '/i/v1/events',
        headers: { authorization: `Bearer ${ingest.token}` },
        payload: {
          events: [{ event: 'selfhost.started', distinct_id: 'selfhost-owner' }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().accepted).toBe(1);
    } finally {
      await app?.close().catch(() => {});
      await selfHost?.end().catch(() => {});
      await isolated.close();
    }
  }, 90_000);
});
