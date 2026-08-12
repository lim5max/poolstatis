import type pg from 'pg';
import { ApiError } from '../errors.js';
import type { z } from 'zod';
import type { usageEntitlementUpdateSchema } from '../schemas.js';

const METER = 'events_stored' as const;

type UsageEntitlementUpdate = z.infer<typeof usageEntitlementUpdateSchema>;

export interface UsageEntitlementControl {
  schema_version: 1;
  meter: typeof METER;
  revision: number;
  hard_limit: number | null;
  warning_thresholds: number[];
  current_usage: number;
  remaining: number | null;
  changed: boolean;
  consequences: {
    scope: 'organization_all_projects_and_environments';
    cap_enforcement: 'accepted_batches_exceeding_cap_are_rejected' | 'accepted_events_continue_without_core_cap';
    threshold_recording: 'crossings_recorded_in_core_without_external_delivery' | 'not_configured';
    effective_cycle: string;
  };
  audit: {
    source: 'usage_entitlement_revisions';
    latest: null | {
      revision: number;
      actor_kind: 'personal_token' | 'hosted_user' | 'unknown';
      reason: string;
      created_at: string;
    };
  };
}

interface EntitlementSnapshotRow {
  period: string;
  current_usage: string;
  hard_limit: string | null;
  warning_thresholds: string[] | null;
  revision: number;
  actor: string | null;
  reason: string | null;
  changed_at: Date | string | null;
  audit_revision: number | null;
  audit_hard_limit: string | null;
  audit_warning_thresholds: string[] | null;
}

function safeNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('usage entitlement value cannot be represented as a non-negative safe integer');
  }
  return parsed;
}

function actorKind(actor: string | null): 'personal_token' | 'hosted_user' | 'unknown' {
  if (actor?.startsWith('key:')) return 'personal_token';
  if (actor?.startsWith('user:')) return 'hosted_user';
  return 'unknown';
}

async function readSnapshot(client: pg.Pool | pg.PoolClient, orgId: string): Promise<EntitlementSnapshotRow> {
  const result = await client.query<EntitlementSnapshotRow>(
    `SELECT
       to_char(date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM') AS period,
       COALESCE(usage.quantity, 0)::bigint::text AS current_usage,
       entitlement.hard_limit::text,
       entitlement.warning_thresholds,
       GREATEST(
         COALESCE(entitlement.configuration_revision, 0),
         COALESCE(audit.revision, 0)
       )::int AS revision,
       audit.revision::int AS audit_revision,
       audit.actor,
       audit.reason,
       audit.created_at AS changed_at,
       audit.hard_limit::text AS audit_hard_limit,
       audit.warning_thresholds AS audit_warning_thresholds
     FROM (SELECT 1) AS seed
     LEFT JOIN organization_entitlements entitlement
       ON entitlement.org_id = $1 AND entitlement.meter_key = $2
     LEFT JOIN organization_usage usage
       ON usage.org_id = $1 AND usage.meter_key = $2
      AND usage.period_start = date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date
     LEFT JOIN LATERAL (
       SELECT revision, actor, reason, created_at, hard_limit, warning_thresholds
       FROM usage_entitlement_revisions
       WHERE org_id = $1 AND meter_key = $2
       ORDER BY revision DESC
       LIMIT 1
     ) audit ON true`,
    [orgId, METER],
  );
  return result.rows[0]!;
}

function present(row: EntitlementSnapshotRow, changed: boolean): UsageEntitlementControl {
  const currentUsage = safeNumber(row.current_usage);
  const hardLimit = row.hard_limit === null ? null : safeNumber(row.hard_limit);
  const warningThresholds = (row.warning_thresholds ?? []).map(safeNumber);
  const auditHardLimit = row.audit_hard_limit === null ? null : safeNumber(row.audit_hard_limit);
  const auditWarningThresholds = (row.audit_warning_thresholds ?? []).map(safeNumber);
  const auditMatchesCurrent = auditHardLimit === hardLimit
    && auditWarningThresholds.length === warningThresholds.length
    && auditWarningThresholds.every((threshold, index) => threshold === warningThresholds[index]);
  return {
    schema_version: 1,
    meter: METER,
    revision: row.revision,
    hard_limit: hardLimit,
    warning_thresholds: warningThresholds,
    current_usage: currentUsage,
    remaining: hardLimit === null ? null : Math.max(0, hardLimit - currentUsage),
    changed,
    consequences: {
      scope: 'organization_all_projects_and_environments',
      cap_enforcement: hardLimit === null
        ? 'accepted_events_continue_without_core_cap'
        : 'accepted_batches_exceeding_cap_are_rejected',
      threshold_recording: warningThresholds.length === 0
        ? 'not_configured'
        : 'crossings_recorded_in_core_without_external_delivery',
      effective_cycle: row.period,
    },
    audit: {
      source: 'usage_entitlement_revisions',
      latest: row.revision === 0 || row.audit_revision !== row.revision || !auditMatchesCurrent
        || row.changed_at === null || row.reason === null
        ? null
        : {
            revision: row.revision,
            actor_kind: actorKind(row.actor),
            reason: row.reason,
            created_at: new Date(row.changed_at).toISOString(),
          },
    },
  };
}

export async function getUsageEntitlementControl(
  pool: pg.Pool,
  orgId: string,
): Promise<UsageEntitlementControl> {
  return present(await readSnapshot(pool, orgId), false);
}

export async function configureUsageEntitlement(
  pool: pg.Pool,
  orgId: string,
  input: UsageEntitlementUpdate,
  actor: string,
): Promise<UsageEntitlementControl> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(poolstatis_usage_config_lock_key($1, $2))',
      [orgId, METER],
    );
    const previous = await readSnapshot(client, orgId);
    if (previous.revision !== input.expected_revision) {
      throw new ApiError(
        409,
        'usage_entitlement_revision_conflict',
        'the usage entitlement changed after it was read',
        'read the entitlement again, review the current usage and consequences, then retry with the new revision',
        { current_revision: previous.revision },
      );
    }
    const currentUsage = safeNumber(previous.current_usage);
    if (input.hard_limit !== null && input.hard_limit < currentUsage) {
      throw new ApiError(
        409,
        'usage_cap_below_current_usage',
        `hard_limit cannot be below the current UTC-cycle usage of ${currentUsage}`,
        'choose a hard limit at or above current_usage, or remove the Core cap',
        { current_usage: currentUsage },
      );
    }
    const previousHardLimit = previous.hard_limit === null ? null : safeNumber(previous.hard_limit);
    const previousThresholds = (previous.warning_thresholds ?? []).map(safeNumber);
    const unchanged = previousHardLimit === input.hard_limit
      && previousThresholds.length === input.warning_thresholds.length
      && previousThresholds.every((threshold, index) => threshold === input.warning_thresholds[index]);
    if (unchanged) {
      await client.query('COMMIT');
      return present(previous, false);
    }
    const revision = previous.revision + 1;
    await client.query(
      `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds, updated_at)
       VALUES ($1, $2, $3, $4::bigint[], now())
       ON CONFLICT (org_id, meter_key) DO UPDATE
       SET hard_limit = EXCLUDED.hard_limit,
           warning_thresholds = EXCLUDED.warning_thresholds,
           updated_at = now()`,
      [orgId, METER, input.hard_limit, input.warning_thresholds],
    );
    await client.query(
      `INSERT INTO usage_entitlement_revisions (
         org_id, meter_key, revision, actor, reason,
         previous_hard_limit, hard_limit,
         previous_warning_thresholds, warning_thresholds, current_usage
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint[], $9::bigint[], $10)`,
      [
        orgId, METER, revision, actor, input.reason,
        previousHardLimit, input.hard_limit,
        previousThresholds, input.warning_thresholds, currentUsage,
      ],
    );
    const current = await readSnapshot(client, orgId);
    await client.query('COMMIT');
    return present(current, true);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
