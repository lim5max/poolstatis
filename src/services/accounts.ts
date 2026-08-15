import type pg from 'pg';
import { ApiError, badRequest, organizationWriteDisabled } from '../errors.js';
import { projectIntentInputSchema, type HostedOnboardingInput } from '../schemas.js';
import { createApiKey, createProject, type Project } from './projects.js';
import { upsertProjectIntent, type StoredProjectIntent } from './projectIntents.js';

export interface AuthUserInput {
  issuer: string;
  subject: string;
  email?: string | null;
  emailVerified: boolean;
  displayName?: string | null;
  pictureUrl?: string | null;
  connectionStrategy: string;
  legacyIssuer?: string | null;
  requireOrganizationPolicy?: boolean;
}

export interface AuthenticatedAccount {
  user: {
    id: string;
    identity_issuer: string;
    subject: string;
    email: string | null;
    email_verified: boolean;
    display_name: string | null;
    name: string | null;
    picture_url: string | null;
    connection_strategy: string;
  };
  organization: {
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
  };
}

export interface BillingSummary {
  plan: {
    id: string;
    name: string;
    price_cents: number;
    currency: string;
    billing_interval: string;
    included_events_monthly: number;
    included_mtu_monthly: number;
    included_projects: number;
    included_retention_months: number;
    included_seats: number;
    pricing_stage: string;
    features: Record<string, unknown>;
  };
  status: string;
  billing_limit_cents: number | null;
  current_period_start: string;
  current_period_end: string;
  meters: Array<{
    key: string;
    name: string;
    unit: string;
    aggregation: string;
    hard_limit: number | null;
    warning_thresholds: number[];
  }>;
}

export type OnboardingInput = HostedOnboardingInput;

export interface OnboardingResult {
  organization: { id: string; name: string };
  project: Pick<Project, 'slug' | 'name' | 'timezone'>;
  intent: StoredProjectIntent | null;
  tokens: {
    personal: string | null;
    ingest_prod: string;
  };
  mcp: {
    command: string;
    args: string[];
    package_status: 'published' | 'publish_pending';
    note: string;
    env: {
      POOLSTATIS_URL: string;
      POOLSTATIS_TOKEN: string | null;
    };
  };
}

export interface McpRunnerConfig {
  command: string;
  args: string[];
  packageStatus: 'published' | 'publish_pending';
  note: string;
}

function cleanText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function defaultOrgName(user: AuthUserInput): string {
  const display = cleanText(user.displayName, cleanText(user.email, 'Poolstatis'));
  return `${display}'s workspace`;
}

export async function getOrCreateAuthenticatedAccount(
  pool: pg.Pool,
  input: AuthUserInput,
): Promise<AuthenticatedAccount> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.subject]);
    const selectUser = () => client.query(
      `SELECT id, identity_issuer, subject, email, email_verified, display_name, name, picture_url, connection_strategy
       FROM auth_users WHERE subject = $1 FOR UPDATE`,
      [input.subject],
    );
    let existing = (await selectUser()).rows[0];
    let user;
    if (!existing) {
      const { rows } = await client.query(
        `INSERT INTO auth_users (
           identity_issuer, subject, email, email_verified, display_name, name,
           picture_url, connection_strategy, updated_at, last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, now(), now())
         ON CONFLICT (subject) DO NOTHING
         RETURNING id, identity_issuer, subject, email, email_verified, display_name, name, picture_url, connection_strategy`,
        [
          input.issuer,
          input.subject,
          input.email ?? null,
          input.emailVerified,
          input.displayName ?? null,
          input.pictureUrl ?? null,
          input.connectionStrategy,
        ],
      );
      user = rows[0];
      if (!user) existing = (await selectUser()).rows[0];
    }
    if (existing) {
      const adoptLegacy = existing.identity_issuer === null && input.legacyIssuer === input.issuer;
      if ((!adoptLegacy && existing.identity_issuer === null)
        || (existing.identity_issuer !== null && existing.identity_issuer !== input.issuer)) {
        throw new ApiError(401, 'unauthorized', 'authentication failed');
      }
      const { rows } = await client.query(
        `UPDATE auth_users SET
           identity_issuer = COALESCE(identity_issuer, $2),
           email = COALESCE($3, email),
           email_verified = $4,
           picture_url = COALESCE($5, picture_url),
           connection_strategy = $6,
           updated_at = now(),
           last_seen_at = now()
         WHERE id = $1
         RETURNING id, identity_issuer, subject, email, email_verified, display_name, name, picture_url, connection_strategy`,
        [
          existing.id,
          input.issuer,
          input.email ?? null,
          input.emailVerified,
          input.pictureUrl ?? null,
          input.connectionStrategy,
        ],
      );
      user = rows[0];
    }

    const { rows: memberships } = await client.query(
      `SELECT o.id, o.name, om.role
       FROM organization_members om
       JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = $1
       ORDER BY om.created_at
       LIMIT 1`,
      [user.id],
    );

    let organization = memberships[0];
    if (!organization) {
      const { rows: orgRows } = await client.query(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id, name',
        [defaultOrgName(input)],
      );
      organization = { ...orgRows[0], role: 'owner' };
      await client.query(
        'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
        [organization.id, user.id, 'owner'],
      );
      await client.query(
        `INSERT INTO organization_billing (org_id, plan_id, status)
         VALUES ($1, 'free', 'free')
         ON CONFLICT (org_id) DO NOTHING`,
        [organization.id],
      );
    } else {
      await client.query(
        `INSERT INTO organization_billing (org_id, plan_id, status)
         VALUES ($1, 'free', 'free')
         ON CONFLICT (org_id) DO NOTHING`,
        [organization.id],
      );
    }

    if (input.requireOrganizationPolicy === true) {
      // The marker is part of the same transaction as first hosted account
      // provisioning. Cloud activates it only after its policy rows are durable.
      await client.query(
        'SELECT poolstatis_require_organization_policy($1::uuid)',
        [organization.id],
      );
    }

    await client.query('COMMIT');
    return {
      user,
      organization: {
        id: organization.id,
        name: organization.name,
        role: organization.role,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upgrade gate for a hosted process. This must complete before the server
 * starts listening so pre-existing JWT organizations and their old keys fail
 * closed until the external control plane activates each policy.
 */
export async function prepareHostedOrganizationPolicies(
  pool: pg.Pool,
  required: boolean,
): Promise<number> {
  if (!required) return 0;
  const { rows: privilegeRows } = await pool.query<{
    runtime_member: boolean;
    can_require: boolean;
    can_backfill: boolean;
    can_check_writes: boolean;
  }>(
    `SELECT
       pg_has_role(current_user, 'poolstatis_core_runtime', 'MEMBER') AS runtime_member,
       has_function_privilege(
         current_user,
         'poolstatis_require_organization_policy(uuid)',
         'EXECUTE'
       ) AS can_require,
       has_function_privilege(
         current_user,
         'poolstatis_backfill_organization_policy_state()',
         'EXECUTE'
       ) AS can_backfill,
       has_function_privilege(
         current_user,
         'poolstatis_organization_policy_allows_writes(uuid)',
         'EXECUTE'
       ) AS can_check_writes`,
  );
  const privileges = privilegeRows[0];
  if (!privileges?.runtime_member
      || !privileges.can_require
      || !privileges.can_backfill
      || !privileges.can_check_writes) {
    throw new Error(
      'hosted policy startup requires membership in poolstatis_core_runtime with require/backfill/write-check execute privileges',
    );
  }
  const { rows } = await pool.query<{ inserted: string }>(
    'SELECT poolstatis_backfill_organization_policy_state()::text AS inserted',
  );
  return Number(rows[0]?.inserted ?? 0);
}

/**
 * Shared HTTP/MCP write boundary. The MCP server is a thin HTTP client, so
 * both customer surfaces resolve the same authenticated organization marker.
 * No marker means ordinary self-host behavior remains unlimited.
 */
export async function requireOrganizationWriteReadiness(
  pool: pg.Pool,
  organizationId: string,
): Promise<void> {
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT poolstatis_organization_policy_allows_writes($1) AS allowed`,
    [organizationId],
  );
  if (rows[0]?.allowed !== true) throw organizationWriteDisabled();
}

/**
 * Hosted deployments use a short-lived deploy credential and a distinct
 * least-privilege runtime credential. Check the effective database roles after
 * migrations and before the deploy pool is closed.
 */
export async function assertHostedDatabaseRoleSeparation(
  migrationPool: pg.Pool,
  runtimePool: pg.Pool,
  required: boolean,
): Promise<void> {
  if (!required) return;
  const { rows: migrationRows } = await migrationPool.query<{
    user_name: string;
    core_admin: boolean;
    activator_admin: boolean;
  }>(
    `SELECT
       current_user AS user_name,
       EXISTS (
         SELECT 1 FROM pg_auth_members am
         JOIN pg_roles granted_role ON granted_role.oid = am.roleid
         JOIN pg_roles member_role ON member_role.oid = am.member
         WHERE granted_role.rolname = 'poolstatis_core_runtime'
           AND member_role.rolname = current_user
           AND am.admin_option
       ) AS core_admin,
       EXISTS (
         SELECT 1 FROM pg_auth_members am
         JOIN pg_roles granted_role ON granted_role.oid = am.roleid
         JOIN pg_roles member_role ON member_role.oid = am.member
         WHERE granted_role.rolname = 'poolstatis_policy_activator'
           AND member_role.rolname = current_user
           AND am.admin_option
       ) AS activator_admin`,
  );
  const { rows: runtimeRows } = await runtimePool.query<{
    user_name: string;
    core_member: boolean;
    can_check_writes: boolean;
    can_activate: boolean;
    can_read_policy: boolean;
    can_write_policy: boolean;
    can_read_migrations: boolean;
    can_write_migrations: boolean;
    can_use_experience_routes: boolean;
    can_use_experience_snapshots: boolean;
    can_use_replay_sessions: boolean;
    can_use_replay_chunks: boolean;
    can_use_replay_audit: boolean;
    can_use_replay_project_deletion_jobs: boolean;
    can_use_replay_project_deletion_artifacts: boolean;
  }>(
    `SELECT
       current_user AS user_name,
       pg_has_role(current_user, 'poolstatis_core_runtime', 'MEMBER') AS core_member,
       has_function_privilege(
         current_user,
         'poolstatis_organization_policy_allows_writes(uuid)',
         'EXECUTE'
       ) AS can_check_writes,
       has_function_privilege(
         current_user,
         'poolstatis_activate_organization_policy(uuid)',
         'EXECUTE'
       ) AS can_activate,
       has_table_privilege(
         current_user,
         'organization_policy_state',
         'SELECT'
       ) AS can_read_policy,
       has_table_privilege(
         current_user,
         'organization_policy_state',
         'INSERT,UPDATE,DELETE'
       ) AS can_write_policy,
       has_table_privilege(current_user, 'schema_migrations', 'SELECT')
         AS can_read_migrations,
       has_table_privilege(
         current_user,
         'schema_migrations',
         'INSERT,UPDATE,DELETE'
       ) AS can_write_migrations,
       has_table_privilege(current_user, 'experience_routes', 'SELECT')
         AND has_table_privilege(current_user, 'experience_routes', 'INSERT')
         AND has_table_privilege(current_user, 'experience_routes', 'UPDATE')
         AND has_table_privilege(current_user, 'experience_routes', 'DELETE')
         AS can_use_experience_routes,
       has_table_privilege(current_user, 'experience_snapshots', 'SELECT')
         AND has_table_privilege(current_user, 'experience_snapshots', 'INSERT')
         AND has_table_privilege(current_user, 'experience_snapshots', 'UPDATE')
         AND has_table_privilege(current_user, 'experience_snapshots', 'DELETE')
         AS can_use_experience_snapshots,
       has_table_privilege(current_user, 'replay_sessions', 'SELECT')
         AND has_table_privilege(current_user, 'replay_sessions', 'INSERT')
         AND has_table_privilege(current_user, 'replay_sessions', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_sessions', 'DELETE')
         AS can_use_replay_sessions,
       has_table_privilege(current_user, 'replay_chunks', 'SELECT')
         AND has_table_privilege(current_user, 'replay_chunks', 'INSERT')
         AND has_table_privilege(current_user, 'replay_chunks', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_chunks', 'DELETE')
         AS can_use_replay_chunks,
       has_table_privilege(current_user, 'replay_audit_log', 'SELECT')
         AND has_table_privilege(current_user, 'replay_audit_log', 'INSERT')
         AND NOT has_table_privilege(current_user, 'replay_audit_log', 'UPDATE')
         AND NOT has_table_privilege(current_user, 'replay_audit_log', 'DELETE')
         AS can_use_replay_audit,
       has_table_privilege(current_user, 'replay_project_deletion_jobs', 'SELECT')
         AND has_table_privilege(current_user, 'replay_project_deletion_jobs', 'INSERT')
         AND has_table_privilege(current_user, 'replay_project_deletion_jobs', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_project_deletion_jobs', 'DELETE')
         AS can_use_replay_project_deletion_jobs,
       has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'SELECT')
         AND has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'INSERT')
         AND has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'DELETE')
         AS can_use_replay_project_deletion_artifacts`,
  );
  const migration = migrationRows[0];
  const runtime = runtimeRows[0];
  if (!migration || !runtime
      || migration.user_name === runtime.user_name
      || !migration.core_admin
      || !migration.activator_admin
      || !runtime.core_member
      || !runtime.can_check_writes
      || runtime.can_activate
      || runtime.can_read_policy
      || runtime.can_write_policy
      || runtime.can_read_migrations
      || runtime.can_write_migrations
      || !runtime.can_use_experience_routes
      || !runtime.can_use_experience_snapshots
      || !runtime.can_use_replay_sessions
      || !runtime.can_use_replay_chunks
      || !runtime.can_use_replay_audit
      || !runtime.can_use_replay_project_deletion_jobs
      || !runtime.can_use_replay_project_deletion_artifacts) {
    throw new Error(
      'hosted database roles are not separated: use a deploy migrator with Core/activator ADMIN OPTION and a distinct poolstatis_core_runtime login without policy or migration-table access',
    );
  }
}

export async function assertHostedRuntimeDatabaseRole(
  runtimePool: pg.Pool,
  required: boolean,
): Promise<void> {
  if (!required) return;
  const { rows } = await runtimePool.query<{
    core_member: boolean;
    can_check_writes: boolean;
    can_activate: boolean;
    can_read_policy: boolean;
    can_write_policy: boolean;
    can_read_migrations: boolean;
    can_write_migrations: boolean;
    can_use_experience_routes: boolean;
    can_use_experience_snapshots: boolean;
    can_use_replay_sessions: boolean;
    can_use_replay_chunks: boolean;
    can_use_replay_audit: boolean;
    can_use_replay_project_deletion_jobs: boolean;
    can_use_replay_project_deletion_artifacts: boolean;
  }>(
    `SELECT
       pg_has_role(current_user, 'poolstatis_core_runtime', 'MEMBER') AS core_member,
       has_function_privilege(
         current_user,
         'poolstatis_organization_policy_allows_writes(uuid)',
         'EXECUTE'
       ) AS can_check_writes,
       has_function_privilege(
         current_user,
         'poolstatis_activate_organization_policy(uuid)',
         'EXECUTE'
       ) AS can_activate,
       has_table_privilege(current_user, 'organization_policy_state', 'SELECT')
         AS can_read_policy,
       has_table_privilege(
         current_user,
         'organization_policy_state',
         'INSERT,UPDATE,DELETE'
       ) AS can_write_policy,
       has_table_privilege(current_user, 'schema_migrations', 'SELECT')
         AS can_read_migrations,
       has_table_privilege(
         current_user,
         'schema_migrations',
         'INSERT,UPDATE,DELETE'
       ) AS can_write_migrations,
       has_table_privilege(current_user, 'experience_routes', 'SELECT')
         AND has_table_privilege(current_user, 'experience_routes', 'INSERT')
         AND has_table_privilege(current_user, 'experience_routes', 'UPDATE')
         AND has_table_privilege(current_user, 'experience_routes', 'DELETE')
         AS can_use_experience_routes,
       has_table_privilege(current_user, 'experience_snapshots', 'SELECT')
         AND has_table_privilege(current_user, 'experience_snapshots', 'INSERT')
         AND has_table_privilege(current_user, 'experience_snapshots', 'UPDATE')
         AND has_table_privilege(current_user, 'experience_snapshots', 'DELETE')
         AS can_use_experience_snapshots,
       has_table_privilege(current_user, 'replay_sessions', 'SELECT')
         AND has_table_privilege(current_user, 'replay_sessions', 'INSERT')
         AND has_table_privilege(current_user, 'replay_sessions', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_sessions', 'DELETE')
         AS can_use_replay_sessions,
       has_table_privilege(current_user, 'replay_chunks', 'SELECT')
         AND has_table_privilege(current_user, 'replay_chunks', 'INSERT')
         AND has_table_privilege(current_user, 'replay_chunks', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_chunks', 'DELETE')
         AS can_use_replay_chunks,
       has_table_privilege(current_user, 'replay_audit_log', 'SELECT')
         AND has_table_privilege(current_user, 'replay_audit_log', 'INSERT')
         AND NOT has_table_privilege(current_user, 'replay_audit_log', 'UPDATE')
         AND NOT has_table_privilege(current_user, 'replay_audit_log', 'DELETE')
         AS can_use_replay_audit,
       has_table_privilege(current_user, 'replay_project_deletion_jobs', 'SELECT')
         AND has_table_privilege(current_user, 'replay_project_deletion_jobs', 'INSERT')
         AND has_table_privilege(current_user, 'replay_project_deletion_jobs', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_project_deletion_jobs', 'DELETE')
         AS can_use_replay_project_deletion_jobs,
       has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'SELECT')
         AND has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'INSERT')
         AND has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'UPDATE')
         AND has_table_privilege(current_user, 'replay_project_deletion_artifacts', 'DELETE')
         AS can_use_replay_project_deletion_artifacts`,
  );
  const runtime = rows[0];
  if (!runtime
      || !runtime.core_member
      || !runtime.can_check_writes
      || runtime.can_activate
      || runtime.can_read_policy
      || runtime.can_write_policy
      || runtime.can_read_migrations
      || runtime.can_write_migrations
      || !runtime.can_use_experience_routes
      || !runtime.can_use_experience_snapshots
      || !runtime.can_use_replay_sessions
      || !runtime.can_use_replay_chunks
      || !runtime.can_use_replay_audit
      || !runtime.can_use_replay_project_deletion_jobs
      || !runtime.can_use_replay_project_deletion_artifacts) {
    throw new Error(
      'hosted runtime must use poolstatis_core_runtime without activation, policy-table, or schema-migration access',
    );
  }
}

export interface AuthenticatedProfile extends AuthenticatedAccount {}

export async function getAuthenticatedProfile(
  pool: pg.Pool,
  userId: string,
  orgId: string,
): Promise<AuthenticatedProfile | null> {
  const { rows } = await pool.query(
    `SELECT au.id, au.identity_issuer, au.subject, au.email, au.email_verified,
            au.display_name, au.name, au.picture_url, au.connection_strategy,
            o.id AS org_id, o.name AS org_name, om.role
     FROM auth_users au
     JOIN organization_members om ON om.user_id = au.id
     JOIN organizations o ON o.id = om.org_id
     WHERE au.id = $1 AND o.id = $2
     LIMIT 1`,
    [userId, orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    user: {
      id: row.id,
      identity_issuer: row.identity_issuer,
      subject: row.subject,
      email: row.email,
      email_verified: row.email_verified,
      display_name: row.display_name,
      name: row.name,
      picture_url: row.picture_url,
      connection_strategy: row.connection_strategy,
    },
    organization: { id: row.org_id, name: row.org_name, role: row.role },
  };
}

export async function updateAuthenticatedProfile(
  pool: pg.Pool,
  userId: string,
  displayName: string,
): Promise<void> {
  await pool.query(
    `UPDATE auth_users
     SET display_name = $2, name = $2, updated_at = now()
     WHERE id = $1`,
    [userId, displayName],
  );
}

export async function getBillingSummary(pool: pg.Pool, orgId: string): Promise<BillingSummary> {
  await pool.query(
    `INSERT INTO organization_billing (org_id, plan_id, status)
     VALUES ($1, 'free', 'free')
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId],
  );
  const { rows } = await pool.query(
    `SELECT ob.status, ob.billing_limit_cents, ob.current_period_start, ob.current_period_end,
       bp.id, bp.name, bp.price_cents, bp.currency, bp.billing_interval,
       bp.included_events_monthly, bp.included_mtu_monthly, bp.included_projects,
       bp.included_retention_months, bp.included_seats, bp.pricing_stage, bp.features
     FROM organization_billing ob
     JOIN billing_plans bp ON bp.id = ob.plan_id
     WHERE ob.org_id = $1`,
    [orgId],
  );
  const plan = rows[0];
  if (!plan) throw new ApiError(500, 'billing_not_initialized', 'free billing plan was not initialized');

  const { rows: entitlements } = await pool.query<{ hard_limit: string | null; warning_thresholds: string[] }>(
    `SELECT hard_limit, warning_thresholds FROM organization_entitlements
     WHERE org_id = $1 AND meter_key = 'events_stored'`,
    [orgId],
  );

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      price_cents: plan.price_cents,
      currency: plan.currency,
      billing_interval: plan.billing_interval,
      included_events_monthly: Number(plan.included_events_monthly),
      included_mtu_monthly: Number(plan.included_mtu_monthly),
      included_projects: plan.included_projects,
      included_retention_months: plan.included_retention_months,
      included_seats: plan.included_seats,
      pricing_stage: plan.pricing_stage,
      features: plan.features,
    },
    status: plan.status,
    billing_limit_cents: plan.billing_limit_cents,
    current_period_start: plan.current_period_start,
    current_period_end: plan.current_period_end,
    meters: [{
      key: 'events_stored',
      name: 'Accepted events stored',
      unit: 'event',
      aggregation: 'sum',
      hard_limit: entitlements[0]?.hard_limit === null || entitlements[0]?.hard_limit === undefined
        ? null : Number(entitlements[0].hard_limit),
      warning_thresholds: (entitlements[0]?.warning_thresholds ?? []).map(Number),
    }],
  };
}

export async function organizationHasProjects(pool: pg.Pool, orgId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM projects WHERE org_id = $1 LIMIT 1', [orgId]);
  return Boolean(rowCount);
}

export async function completeHostedOnboarding(
  pool: pg.Pool,
  orgId: string,
  userId: string,
  input: OnboardingInput,
  publicUrl: string,
  mcpRunner: McpRunnerConfig,
): Promise<OnboardingResult> {
  const projectSlug = cleanText(input.project_slug, '');
  const projectName = cleanText(input.project_name, projectSlug);
  if (!/^[a-z][a-z0-9-]*$/.test(projectSlug)) {
    throw badRequest('invalid_slug', 'project_slug must be lowercase letters, digits and hyphens, starting with a letter');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`onboarding:${orgId}`]);
    const { rowCount } = await client.query('SELECT 1 FROM projects WHERE org_id = $1 LIMIT 1', [orgId]);
    if (rowCount) {
      throw new ApiError(
        409,
        'onboarding_complete',
        'this workspace already has a project',
        'use the Projects and Keys screens to manage additional resources or issue a new MCP token',
      );
    }
    const { rows: orgRows } = await client.query(
      'SELECT id, name FROM organizations WHERE id = $1',
      [orgId],
    );
    if (!orgRows[0]) throw new ApiError(404, 'organization_not_found', 'organization not found');

    let project: Project;
    try {
      project = await createProject(client as unknown as pg.Pool, orgId, projectSlug, projectName);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError(409, 'slug_taken', `a project with slug "${projectSlug}" already exists in this org`);
      }
      throw err;
    }
    const personal = input.issue_personal_token === false
      ? null
      : await createApiKey(client as unknown as pg.Pool, {
          orgId,
          projectId: null,
          kind: 'personal',
          label: 'hosted onboarding MCP',
          issuedByUserId: userId,
        });
    const ingest = await createApiKey(client as unknown as pg.Pool, {
      orgId,
      projectId: project.id,
      kind: 'ingest',
      env: 'prod',
      label: 'hosted onboarding prod ingest',
    });
    const hasIntent = input.project_mode !== undefined;
    const intent = hasIntent
      ? await upsertProjectIntent(client as unknown as pg.Pool, project.id, projectIntentInputSchema.parse({
          project_mode: input.project_mode!,
          website_domain: input.website_domain ?? null,
          goal_ids: input.goal_ids!,
          custom_goal: input.custom_goal ?? null,
          primary_goal_id: input.primary_goal_id!,
        }))
      : null;
    await client.query('COMMIT');

    return {
      organization: { id: orgRows[0].id, name: orgRows[0].name },
      project: { slug: project.slug, name: project.name, timezone: project.timezone },
      intent,
      tokens: { personal: personal?.token ?? null, ingest_prod: ingest.token },
      mcp: {
        command: mcpRunner.command,
        args: mcpRunner.args,
        package_status: mcpRunner.packageStatus,
        note: mcpRunner.note,
        env: {
          POOLSTATIS_URL: publicUrl.replace(/\/$/, ''),
          POOLSTATIS_TOKEN: personal?.token ?? null,
        },
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
