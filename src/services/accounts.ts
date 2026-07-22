import type pg from 'pg';
import { ApiError, badRequest } from '../errors.js';
import { createApiKey, createProject, type Project } from './projects.js';

export interface AuthUserInput {
  issuer: string;
  subject: string;
  email?: string | null;
  emailVerified: boolean;
  displayName?: string | null;
  pictureUrl?: string | null;
  connectionStrategy: string;
  legacyIssuer?: string | null;
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
    free_quantity: number;
    overage_unit_quantity: number;
    overage_price_cents: string;
    pricing_stage: string;
    source_note: string;
  }>;
}

export interface OnboardingInput {
  workspace_name: string;
  project_slug: string;
  project_name: string;
}

export interface OnboardingResult {
  organization: { id: string; name: string };
  project: Pick<Project, 'slug' | 'name' | 'timezone'>;
  tokens: {
    personal: string;
    ingest_prod: string;
  };
  mcp: {
    command: string;
    args: string[];
    package_status: 'published' | 'publish_pending';
    note: string;
    env: {
      POOLSTATIS_URL: string;
      POOLSTATIS_TOKEN: string;
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

  const { rows: meters } = await pool.query(
    `SELECT key, name, unit, aggregation, free_quantity, overage_unit_quantity,
       overage_price_cents::text, pricing_stage, source_note
     FROM billing_meters
     WHERE active = true
     ORDER BY sort_order, key`,
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
    meters: meters.map((m) => ({
      ...m,
      free_quantity: Number(m.free_quantity),
      overage_unit_quantity: Number(m.overage_unit_quantity),
    })),
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
  const workspaceName = cleanText(input.workspace_name, 'Poolstatis workspace');
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
      'UPDATE organizations SET name = $2 WHERE id = $1 RETURNING id, name',
      [orgId, workspaceName],
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
    const personal = await createApiKey(client as unknown as pg.Pool, {
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
    await client.query('COMMIT');

    return {
      organization: { id: orgRows[0].id, name: orgRows[0].name },
      project: { slug: project.slug, name: project.name, timezone: project.timezone },
      tokens: { personal: personal.token, ingest_prod: ingest.token },
      mcp: {
        command: mcpRunner.command,
        args: mcpRunner.args,
        package_status: mcpRunner.packageStatus,
        note: mcpRunner.note,
        env: {
          POOLSTATIS_URL: publicUrl.replace(/\/$/, ''),
          POOLSTATIS_TOKEN: personal.token,
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
