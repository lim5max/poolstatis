import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import {
  getOrCreateAuthenticatedAccount,
  prepareHostedOrganizationPolicies,
} from '../src/services/accounts.js';
import {
  createApiKey,
  createOrganization,
  createProject,
} from '../src/services/projects.js';
import { TEST_DB_URL } from './urls.js';

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };
let sequence = 0;

const issuer = 'https://policy-auth.poolstatis.test/';
const audience = 'https://policy-api.poolstatis.test/';

async function jwt(subject: string, email: string): Promise<string> {
  return new SignJWT({ email, email_verified: true, name: 'Policy Owner' })
    .setProtectedHeader({ alg: 'RS256', kid: 'policy-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function request(
  token: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'policy-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, {
    auth: {
      issuer,
      audience,
      jwks: async () => jwks,
      requireOrganizationPolicy: true,
    },
    ingestBuffer: false,
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('hosted policy readiness', () => {
  it('atomically marks the first JWT organization pending before concurrent project and key writes', async () => {
    const id = `${Date.now()}-${sequence++}`;
    const subject = `auth0|pending-${id}`;
    const token = await jwt(subject, `pending-${id}@example.test`);

    const [profile, projectAttempts, tokenAttempts] = await Promise.all([
      request(token, 'GET', '/api/v1/me'),
      Promise.all(Array.from({ length: 10 }, (_, index) => request(
        token,
        'POST',
        '/api/v1/projects',
        { slug: `pending-${id}-${index}`, name: `Pending ${index}` },
      ))),
      Promise.all(Array.from({ length: 10 }, (_, index) => request(
        token,
        'POST',
        '/api/v1/me/tokens',
        { label: `Pending ${index}` },
      ))),
    ]);

    expect(profile.status).toBe(200);
    for (const attempt of [...projectAttempts, ...tokenAttempts]) {
      expect(attempt).toEqual({
        status: 402,
        body: {
          error: {
            code: 'organization_write_disabled',
            message: 'writes are disabled for this organization',
            hint: 'read access remains available; ask an organization operator to restore writes',
          },
        },
      });
    }

    const state = await pool.query<{
      org_id: string;
      activated_at: Date | null;
      projects: number;
      keys: number;
    }>(
      `SELECT ops.org_id::text,
              ops.activated_at,
              (SELECT count(*)::int FROM projects p WHERE p.org_id = ops.org_id) AS projects,
              (SELECT count(*)::int FROM api_keys k WHERE k.org_id = ops.org_id) AS keys
       FROM auth_users au
       JOIN organization_members om ON om.user_id = au.id
       JOIN organization_policy_state ops ON ops.org_id = om.org_id
       WHERE au.subject = $1`,
      [subject],
    );
    expect(state.rows).toEqual([{
      org_id: profile.body.organization.id,
      activated_at: null,
      projects: 0,
      keys: 0,
    }]);
  });

  it('rolls back combined hosted onboarding without returning or storing credentials while pending', async () => {
    const id = `${Date.now()}-${sequence++}`;
    const subject = `auth0|onboarding-${id}`;
    const token = await jwt(subject, `onboarding-${id}@example.test`);
    const profile = await request(token, 'GET', '/api/v1/me');
    const originalName = profile.body.organization.name as string;

    const response = await request(token, 'POST', '/api/v1/onboarding', {
      workspace_name: 'Must roll back',
      project_slug: `blocked-${id}`,
      project_name: 'Blocked',
    });

    expect(response).toEqual({
      status: 402,
      body: {
        error: {
          code: 'organization_write_disabled',
          message: 'writes are disabled for this organization',
          hint: 'read access remains available; ask an organization operator to restore writes',
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('pt_');
    expect(JSON.stringify(response.body)).not.toContain('pk_');
    const stored = await pool.query<{ name: string; projects: number; keys: number }>(
      `SELECT o.name,
              (SELECT count(*)::int FROM projects p WHERE p.org_id = o.id) AS projects,
              (SELECT count(*)::int FROM api_keys k WHERE k.org_id = o.id) AS keys
       FROM organizations o
       WHERE o.id = $1`,
      [profile.body.organization.id],
    );
    expect(stored.rows).toEqual([{ name: originalName, projects: 0, keys: 0 }]);
  });

  it('backfills old hosted credentials pending, blocks writes without free usage, then activates once', async () => {
    const id = `${Date.now()}-${sequence++}`;
    const subject = `auth0|upgrade-${id}`;
    const organization = await createOrganization(pool, `Upgrade ${id}`);
    const { rows: users } = await pool.query<{ id: string }>(
      `INSERT INTO auth_users (
         identity_issuer, subject, email, email_verified, display_name, name, connection_strategy
       ) VALUES ($1, $2, $3, true, 'Upgrade Owner', 'Upgrade Owner', 'auth0')
       RETURNING id`,
      [issuer, subject, `upgrade-${id}@example.test`],
    );
    const userId = users[0]!.id;
    await pool.query(
      'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [organization.id, userId, 'owner'],
    );
    const project = await createProject(pool, organization.id, `upgrade-${id}`, 'Upgrade project');
    const ingest = await createApiKey(pool, {
      orgId: organization.id,
      projectId: project.id,
      kind: 'ingest',
    });
    const personal = await createApiKey(pool, {
      orgId: organization.id,
      projectId: null,
      kind: 'personal',
      issuedByUserId: userId,
    });
    const secret = await createApiKey(pool, {
      orgId: organization.id,
      projectId: project.id,
      kind: 'secret',
    });
    const pendingEvent = 'policy.pending_event';
    expect(await pool.query(
      'SELECT 1 FROM organization_policy_state WHERE org_id = $1',
      [organization.id],
    )).toMatchObject({ rowCount: 0 });

    expect(await prepareHostedOrganizationPolicies(pool, true)).toBeGreaterThanOrEqual(1);
    expect(await pool.query(
      'SELECT activated_at FROM organization_policy_state WHERE org_id = $1',
      [organization.id],
    )).toMatchObject({ rows: [{ activated_at: null }] });
    expect(await prepareHostedOrganizationPolicies(pool, true)).toBe(0);

    const projectsBefore = await request(personal.token, 'POST', '/api/v1/projects', {
      slug: `upgrade-blocked-${id}`,
      name: 'Upgrade blocked',
    });
    expect(projectsBefore.status).toBe(402);
    expect(projectsBefore.body.error.code).toBe('organization_write_disabled');
    const keyBefore = await request(
      secret.token,
      'POST',
      `/api/v1/projects/${project.slug}/keys`,
      { kind: 'secret', label: 'must stay blocked' },
    );
    expect(keyBefore.status).toBe(402);
    expect(keyBefore.body.error.code).toBe('organization_write_disabled');

    const ingestAttempts = await Promise.all(Array.from({ length: 10 }, (_, index) => request(
      ingest.token,
      'POST',
      '/i/v1/events',
      {
        batch_id: `upgrade-pending-${id}-${index}`,
        events: [{
          event: pendingEvent,
          distinct_id: `actor-${index}`,
        }],
      },
    )));
    expect(ingestAttempts.map((attempt) => attempt.status)).toEqual(Array(10).fill(402));
    expect(ingestAttempts.every((attempt) =>
      attempt.body.error.code === 'organization_write_disabled')).toBe(true);

    const readable = await request(secret.token, 'GET', '/api/v1/projects');
    expect(readable.status).toBe(200);
    expect(readable.body.projects.map((candidate: any) => candidate.slug)).toEqual([project.slug]);

    const beforeActivation = await pool.query<{ events: number; ledger: number; usage: number; projects: number }>(
      `SELECT
         (SELECT count(*)::int FROM events WHERE project_id = $1 AND event = $2) AS events,
         (SELECT count(*)::int FROM usage_ledger WHERE org_id = $3) AS ledger,
         (SELECT count(*)::int FROM organization_usage WHERE org_id = $3) AS usage,
         (SELECT count(*)::int FROM projects WHERE org_id = $3) AS projects`,
      [project.id, pendingEvent, organization.id],
    );
    expect(beforeActivation.rows).toEqual([{ events: 0, ledger: 0, usage: 0, projects: 1 }]);

    const deployMigrator = `poolstatis_policy_deploy_${process.pid}`;
    const activator = `poolstatis_policy_cloud_${process.pid}`;
    const unauthorized = `poolstatis_policy_unauthorized_${process.pid}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE ROLE ${deployMigrator} NOLOGIN NOINHERIT`);
      await client.query(`CREATE ROLE ${activator} NOLOGIN INHERIT`);
      await client.query(`CREATE ROLE ${unauthorized} NOLOGIN NOINHERIT`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${activator}, ${unauthorized}`);

      await client.query(`SET ROLE ${unauthorized}`);
      await expect(prepareHostedOrganizationPolicies(
        client as unknown as pg.Pool,
        true,
      )).rejects.toThrow('membership in poolstatis_core_runtime');
      await expect(client.query(
        'SELECT poolstatis_activate_organization_policy($1)',
        [organization.id],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        'UPDATE organization_policy_state SET activated_at = now() WHERE org_id = $1',
        [organization.id],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        'SELECT poolstatis_require_organization_policy($1)',
        [organization.id],
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('RESET ROLE');

      // The Core migration gives its deploy migrator ADMIN OPTION on the
      // stable activator group. A private non-superuser migration can then
      // grant only group membership to its restricted runtime.
      await client.query(
        `GRANT poolstatis_policy_activator TO ${deployMigrator} WITH ADMIN OPTION`,
      );
      await client.query(`SET ROLE ${deployMigrator}`);
      await client.query(`GRANT poolstatis_policy_activator TO ${activator}`);
      await client.query('RESET ROLE');
      await client.query(`SET ROLE ${activator}`);
      const activated = await client.query<{ activated: boolean }>(
        'SELECT poolstatis_activate_organization_policy($1) AS activated',
        [organization.id],
      );
      expect(activated.rows).toEqual([{ activated: true }]);
      const absent = await client.query<{ activated: boolean }>(
        `SELECT poolstatis_activate_organization_policy(
           '00000000-0000-4000-8000-000000000099'::uuid
         ) AS activated`,
      );
      expect(absent.rows).toEqual([{ activated: false }]);
      await expect(client.query(
        'UPDATE organization_policy_state SET activated_at = NULL WHERE org_id = $1',
        [organization.id],
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('RESET ROLE');
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      await client.query(`REVOKE poolstatis_policy_activator FROM ${activator}`).catch(() => {});
      await client.query(
        `REVOKE ADMIN OPTION FOR poolstatis_policy_activator FROM ${deployMigrator}`,
      ).catch(() => {});
      await client.query(`REVOKE USAGE ON SCHEMA public FROM ${activator}, ${unauthorized}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${activator}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${unauthorized}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${deployMigrator}`).catch(() => {});
      client.release();
    }
    await expect(pool.query(
      'UPDATE organization_policy_state SET activated_at = NULL WHERE org_id = $1',
      [organization.id],
    )).rejects.toMatchObject({ code: '55000' });

    const activatedProject = await request(personal.token, 'POST', '/api/v1/projects', {
      slug: `upgrade-active-${id}`,
      name: 'Upgrade active',
    });
    expect(activatedProject.status).toBe(201);
    const hostedToken = await request(
      await jwt(subject, `upgrade-${id}@example.test`),
      'POST',
      '/api/v1/me/tokens',
      { label: 'Activated hosted token' },
    );
    expect(hostedToken.status).toBe(201);
    expect(hostedToken.body.token).toMatch(/^pt_/);
    const activatedIngest = await request(ingest.token, 'POST', '/i/v1/events', {
      batch_id: `upgrade-active-${id}`,
      events: [{ event: pendingEvent, distinct_id: 'active-actor' }],
    });
    expect(activatedIngest.status).toBe(200);

    const afterActivation = await pool.query<{ events: number; ledger: number; usage: string }>(
      `SELECT
         (SELECT count(*)::int FROM events WHERE project_id = $1 AND event = $2) AS events,
         (SELECT count(*)::int FROM usage_ledger WHERE org_id = $3) AS ledger,
         (SELECT COALESCE(sum(quantity), 0)::text FROM organization_usage WHERE org_id = $3) AS usage`,
      [project.id, pendingEvent, organization.id],
    );
    expect(afterActivation.rows).toEqual([{ events: 1, ledger: 1, usage: '1' }]);
  });

  it('keeps policy functions behind hardened owner and exact runtime grants', async () => {
    const functions = await pool.query<{
      name: string;
      security_definer: boolean;
      config: string[] | null;
      core_execute: boolean;
    }>(
      `SELECT p.proname AS name,
              p.prosecdef AS security_definer,
              p.proconfig AS config,
              has_function_privilege(
                'poolstatis_core_runtime',
                p.oid,
                'EXECUTE'
              ) AS core_execute
       FROM pg_proc p
       WHERE p.oid IN (
         'poolstatis_require_organization_policy(uuid)'::regprocedure,
         'poolstatis_activate_organization_policy(uuid)'::regprocedure,
         'poolstatis_backfill_organization_policy_state()'::regprocedure,
         'poolstatis_enforce_organization_policy_ready()'::regprocedure,
         'poolstatis_protect_organization_policy_state()'::regprocedure
       )
       ORDER BY p.proname`,
    );
    expect(functions.rows).toEqual([
      {
        name: 'poolstatis_activate_organization_policy',
        security_definer: true,
        config: ['search_path=pg_catalog, public'],
        core_execute: false,
      },
      {
        name: 'poolstatis_backfill_organization_policy_state',
        security_definer: true,
        config: ['search_path=pg_catalog, public'],
        core_execute: true,
      },
      {
        name: 'poolstatis_enforce_organization_policy_ready',
        security_definer: true,
        config: ['search_path=pg_catalog, public'],
        core_execute: false,
      },
      {
        name: 'poolstatis_protect_organization_policy_state',
        security_definer: true,
        config: ['search_path=pg_catalog, public'],
        core_execute: false,
      },
      {
        name: 'poolstatis_require_organization_policy',
        security_definer: true,
        config: ['search_path=pg_catalog, public'],
        core_execute: true,
      },
    ]);
    const roles = await pool.query<{
      owner_login: boolean;
      owner_inherit: boolean;
      runtime_login: boolean;
      runtime_inherit: boolean;
      activator_login: boolean;
      activator_inherit: boolean;
      activator_can_activate: boolean;
      activator_can_read_table: boolean;
      activator_can_write_table: boolean;
      migrator_admin_option: boolean;
      runtime_can_read_table: boolean;
      runtime_can_write_table: boolean;
    }>(
      `SELECT
         (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'poolstatis_policy_owner') AS owner_login,
         (SELECT rolinherit FROM pg_roles WHERE rolname = 'poolstatis_policy_owner') AS owner_inherit,
         (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'poolstatis_core_runtime') AS runtime_login,
         (SELECT rolinherit FROM pg_roles WHERE rolname = 'poolstatis_core_runtime') AS runtime_inherit,
         (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'poolstatis_policy_activator') AS activator_login,
         (SELECT rolinherit FROM pg_roles WHERE rolname = 'poolstatis_policy_activator') AS activator_inherit,
         has_function_privilege(
           'poolstatis_policy_activator',
           'poolstatis_activate_organization_policy(uuid)',
           'EXECUTE'
         ) AS activator_can_activate,
         has_table_privilege(
           'poolstatis_policy_activator',
           'organization_policy_state',
           'SELECT'
         ) AS activator_can_read_table,
         has_table_privilege(
           'poolstatis_policy_activator',
           'organization_policy_state',
           'INSERT,UPDATE,DELETE'
         ) AS activator_can_write_table,
         EXISTS (
           SELECT 1
           FROM pg_auth_members am
           JOIN pg_roles granted_role ON granted_role.oid = am.roleid
           JOIN pg_roles member_role ON member_role.oid = am.member
           WHERE granted_role.rolname = 'poolstatis_policy_activator'
             AND member_role.rolname = current_user
             AND am.admin_option
         ) AS migrator_admin_option,
         has_table_privilege(
           'poolstatis_core_runtime',
           'organization_policy_state',
           'SELECT'
         ) AS runtime_can_read_table,
         has_table_privilege(
           'poolstatis_core_runtime',
           'organization_policy_state',
           'INSERT,UPDATE,DELETE'
         ) AS runtime_can_write_table`,
    );
    expect(roles.rows).toEqual([{
      owner_login: false,
      owner_inherit: false,
      runtime_login: false,
      runtime_inherit: false,
      activator_login: false,
      activator_inherit: false,
      activator_can_activate: true,
      activator_can_read_table: false,
      activator_can_write_table: false,
      migrator_admin_option: true,
      runtime_can_read_table: false,
      runtime_can_write_table: false,
    }]);

    const restrictedRuntime = `poolstatis_core_restricted_${process.pid}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE ROLE ${restrictedRuntime} NOLOGIN INHERIT`);
      await client.query(`GRANT poolstatis_core_runtime TO ${restrictedRuntime}`);
      await client.query(`SET ROLE ${restrictedRuntime}`);
      await expect(prepareHostedOrganizationPolicies(
        client as unknown as pg.Pool,
        true,
      )).resolves.toBe(0);
      await expect(client.query(
        'SELECT poolstatis_activate_organization_policy($1)',
        ['00000000-0000-4000-8000-000000000098'],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        'SELECT * FROM organization_policy_state LIMIT 1',
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      await client.query(`REVOKE poolstatis_core_runtime FROM ${restrictedRuntime}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${restrictedRuntime}`).catch(() => {});
      client.release();
    }
  });

  it('keeps JWT self-host organizations unlimited when hosted policy is not explicitly enabled', async () => {
    const selfHostApp = buildServer(pool, {
      auth: { issuer, audience, jwks: async () => jwks },
      ingestBuffer: false,
    });
    const id = `${Date.now()}-${sequence++}`;
    const subject = `auth0|selfhost-${id}`;
    const token = await jwt(subject, `selfhost-${id}@example.test`);
    const selfHostRequest = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const response = await selfHostApp.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return { status: response.statusCode, body: response.json() };
    };
    try {
      const profile = await selfHostRequest('GET', '/api/v1/me');
      expect(profile.status).toBe(200);
      expect(await pool.query(
        'SELECT 1 FROM organization_policy_state WHERE org_id = $1',
        [profile.body.organization.id],
      )).toMatchObject({ rowCount: 0 });

      const onboarding = await selfHostRequest('POST', '/api/v1/onboarding', {
        workspace_name: 'Self-host JWT',
        project_slug: `selfhost-${id}`,
        project_name: 'Self-host JWT',
      });
      expect(onboarding.status).toBe(201);
      expect(onboarding.body.tokens.personal).toMatch(/^pt_/);
      expect(onboarding.body.tokens.ingest_prod).toMatch(/^pk_/);
    } finally {
      await selfHostApp.close();
    }
  });

  it('allows organization offboarding to cascade the marker but rejects direct marker deletion', async () => {
    const organization = await createOrganization(pool, `Delete ${Date.now()}-${sequence++}`);
    await pool.query(
      'SELECT poolstatis_require_organization_policy($1)',
      [organization.id],
    );
    await expect(pool.query(
      'DELETE FROM organization_policy_state WHERE org_id = $1',
      [organization.id],
    )).rejects.toMatchObject({ code: '55000' });

    await pool.query('DELETE FROM organizations WHERE id = $1', [organization.id]);
    expect(await pool.query(
      'SELECT 1 FROM organization_policy_state WHERE org_id = $1',
      [organization.id],
    )).toMatchObject({ rowCount: 0 });
  });

  it('requires the marker inside the same transaction as org and membership provisioning', async () => {
    const id = `${Date.now()}-${sequence++}`;
    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_fail_atomic_policy_marker() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM organizations
            WHERE id = NEW.org_id AND name = 'Atomic rollback''s workspace'
          ) THEN
            RAISE EXCEPTION 'forced marker failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER test_fail_atomic_policy_marker
          AFTER INSERT ON organization_policy_state
          FOR EACH ROW EXECUTE FUNCTION test_fail_atomic_policy_marker();
      `);
      await expect(getOrCreateAuthenticatedAccount(pool, {
        issuer,
        subject: `auth0|atomic-${id}`,
        email: `atomic-${id}@example.test`,
        emailVerified: true,
        displayName: 'Atomic rollback',
        connectionStrategy: 'auth0',
        requireOrganizationPolicy: true,
      })).rejects.toThrow('forced marker failure');
      const stored = await pool.query<{ users: number; organizations: number; markers: number }>(
        `SELECT
           (SELECT count(*)::int FROM auth_users WHERE subject = $1) AS users,
           (SELECT count(*)::int FROM organizations WHERE name = 'Atomic rollback''s workspace') AS organizations,
           (SELECT count(*)::int
            FROM organization_policy_state ops
            JOIN organizations o ON o.id = ops.org_id
            WHERE o.name = 'Atomic rollback''s workspace') AS markers`,
        [`auth0|atomic-${id}`],
      );
      expect(stored.rows).toEqual([{ users: 0, organizations: 0, markers: 0 }]);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_fail_atomic_policy_marker ON organization_policy_state')
        .catch(() => {});
      await pool.query('DROP FUNCTION IF EXISTS test_fail_atomic_policy_marker()').catch(() => {});
    }
  });
});
