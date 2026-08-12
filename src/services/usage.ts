import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  controlTowerResultSchema,
  orderAttentionItems,
  type AttentionItem,
  type EvidenceBlock,
} from './controlTower.js';

export interface OrganizationUsage {
  meter: 'events_stored';
  period: string;
  quantity: number;
  hard_limit: number | null;
  warning_thresholds: number[];
  warnings: Array<{ threshold: number; quantity: number }>;
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    quantity: number;
    environments: Array<{ env: string; quantity: number }>;
  }>;
}

export interface OrganizationUsageActivity {
  meter: 'events_stored';
  date_from: string;
  date_to: string;
  quantity: string;
  source: 'usage_ledger';
  timezone: 'UTC';
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    quantity: string;
    environments: Array<{ env: string; quantity: string }>;
  }>;
}

export interface OrganizationUsageRangeProject {
  id: string;
  slug: string;
  name: string;
  quantity: string;
  environments: Array<{ env: string; quantity: string }>;
}

export interface OrganizationUsageRangePeriod {
  period: string;
  quantity: string;
  unattributed_quantity: string;
  warnings: Array<{ threshold: number; quantity: number }>;
  projects: OrganizationUsageRangeProject[];
}

export interface OrganizationUsageRange {
  meter: 'events_stored';
  from: string;
  to: string;
  timezone: 'UTC';
  granularity: 'month';
  usage_basis: 'ingest_time';
  quantity: string;
  current_entitlement: {
    period: string;
    hard_limit: number | null;
    warning_thresholds: number[];
    basis: 'current_configuration';
  };
  periods: OrganizationUsageRangePeriod[];
}

export const usageControlResultSchema = controlTowerResultSchema.extend({
  meter: z.literal('events_stored'),
  cycle: z.object({ from: z.string().datetime(), to: z.string().datetime(), timezone: z.literal('UTC') }).strict(),
  cap: z.object({
    state: z.enum(['finite', 'not_configured']),
    value: z.number().nullable(),
    remaining: z.number().nullable(),
    consequence_at_100_percent: z.string().nullable(),
  }).strict(),
  pace: z.object({
    observed_days: z.number().int().nonnegative(),
    events_per_day_7d: z.number().nullable(),
    projected_cycle_end: z.number().nullable(),
    confidence: z.enum(['sufficient', 'insufficient']),
  }).strict(),
  threshold_forecasts: z.array(z.object({
    percent: z.union([z.literal(50), z.literal(75), z.literal(90), z.literal(100)]),
    state: z.enum(['reached', 'projected', 'not_projected', 'not_applicable']),
    reached_or_projected_at: z.string().datetime().nullable(),
    configured_threshold: z.number().int().nonnegative().nullable(),
    notification_state: z.enum(['not_configured', 'armed', 'recorded']),
    audit_source: z.enum(['usage_ledger', 'organization_entitlement', 'usage_warning']),
  }).strict()),
  contributors: z.array(z.object({
    project_slug: z.string(),
    project_name: z.string(),
    environment: z.string(),
    accepted_events: z.number(),
    share: z.number().nullable(),
    change_7d: z.number().nullable(),
    last_ingest_at: z.string().datetime().nullable(),
  }).strict()),
  reconciliation: z.object({
    metered_quantity: z.number().int().nonnegative(),
    attributed_quantity: z.number().int().nonnegative(),
    difference: z.number().int(),
    unattributed_quantity: z.number().int().nonnegative(),
    overattributed_quantity: z.number().int().nonnegative(),
    state: z.enum(['reconciled', 'partial']),
  }).strict(),
}).strict();

export type UsageControlResult = z.infer<typeof usageControlResultSchema>;

const DAY_MS = 86_400_000;

function safeUsageNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('usage value cannot be represented as a non-negative safe integer');
  }
  return parsed;
}

function utcMonthBounds(period: string): { start: Date; endExclusive: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    endExclusive: new Date(Date.UTC(year, month, 1)),
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function usageEvidence(
  now: Date,
  state: EvidenceBlock['state'],
  observedDays: number,
  paceWindowDays: number,
  warnings: EvidenceBlock['warnings'],
): EvidenceBlock {
  return {
    state,
    as_of: now.toISOString(),
    freshness: 'fresh',
    source_refs: [{ kind: 'usage_ledger', meter: 'events_stored' }],
    aggregation: 'accepted events by immutable usage-ledger ingest time in UTC; seven-day pace includes zero-event calendar days',
    sample: {
      eligible: paceWindowDays,
      observed: observedDays,
      coverage: paceWindowDays > 0 ? observedDays / paceWindowDays : null,
    },
    warnings,
    unavailable_reasons: observedDays < 2
      ? [{
          code: 'insufficient_pace_sample',
          message: 'At least two distinct observed ingest days are required for a pace forecast.',
          prerequisite_action_id: 'review_usage_contributors',
        }]
      : [],
  };
}

/** Server-owned organization usage answer derived only from Core ledger and entitlement facts. */
export async function getOrganizationUsageControl(
  pool: pg.Pool,
  orgId: string,
  period: string,
  now = new Date(),
): Promise<UsageControlResult> {
  const { start, endExclusive } = utcMonthBounds(period);
  const currentPeriod = now >= start && now < endExclusive;
  const anchor = currentPeriod ? now : new Date(endExclusive.getTime() - 1);
  const anchorDay = startOfUtcDay(anchor);
  const paceStart = new Date(Math.max(start.getTime(), anchorDay.getTime() - 6 * DAY_MS));
  const paceWindowDays = Math.floor((anchorDay.getTime() - paceStart.getTime()) / DAY_MS) + 1;
  const previousStart = new Date(paceStart.getTime() - paceWindowDays * DAY_MS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const projection = await client.query<{ quantity: string }>(
        `SELECT quantity::text FROM organization_usage
         WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date`,
        [orgId, `${period}-01`],
      );
    const entitlement = await client.query<{ hard_limit: string | null; warning_thresholds: string[] }>(
        `SELECT hard_limit::text, warning_thresholds FROM organization_entitlements
         WHERE org_id = $1 AND meter_key = 'events_stored'`,
        [orgId],
      );
    const recordedWarnings = await client.query<{ threshold: string }>(
      `SELECT threshold::text
       FROM usage_warnings
       WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date`,
      [orgId, `${period}-01`],
    );
    const daily = await client.query<{ day: string; quantity: string }>(
        `SELECT to_char(date_trunc('day', ingested_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                sum(quantity)::bigint::text AS quantity
         FROM usage_ledger
         WHERE org_id = $1 AND meter_key = 'events_stored'
           AND period_start = $2::date
         GROUP BY date_trunc('day', ingested_at AT TIME ZONE 'UTC')
         ORDER BY day`,
        [orgId, `${period}-01`],
      );
    const contributorRows = await client.query<{
        slug: string; name: string; env: string; quantity: string;
        recent_quantity: string; previous_quantity: string; last_ingest_at: Date | string;
      }>(
        `WITH current_contributors AS (
           SELECT l.project_id, l.env,
                  sum(l.quantity)::bigint AS quantity,
                  max(l.ingested_at) AS last_ingest_at
           FROM usage_ledger l
           WHERE l.org_id = $1 AND l.meter_key = 'events_stored' AND l.period_start = $2::date
           GROUP BY l.project_id, l.env
         ), comparison_windows AS (
           SELECT l.project_id, l.env,
                  COALESCE(sum(l.quantity) FILTER (
                    WHERE l.ingested_at >= $3 AND l.ingested_at < $4
                  ), 0)::bigint AS recent_quantity,
                  COALESCE(sum(l.quantity) FILTER (
                    WHERE l.ingested_at >= $5 AND l.ingested_at < $3
                  ), 0)::bigint AS previous_quantity
           FROM usage_ledger l
           WHERE l.org_id = $1 AND l.meter_key = 'events_stored'
             AND l.ingested_at >= $5 AND l.ingested_at < $4
           GROUP BY l.project_id, l.env
         )
         SELECT p.slug, p.name, current.env,
                current.quantity::text AS quantity,
                COALESCE(windows.recent_quantity, 0)::text AS recent_quantity,
                COALESCE(windows.previous_quantity, 0)::text AS previous_quantity,
                current.last_ingest_at
         FROM current_contributors current
         JOIN projects p ON p.id = current.project_id AND p.org_id = $1
         LEFT JOIN comparison_windows windows
           ON windows.project_id = current.project_id AND windows.env = current.env
         ORDER BY current.quantity DESC, p.slug, current.env`,
        [orgId, `${period}-01`, paceStart, new Date(anchorDay.getTime() + DAY_MS), previousStart],
      );
    const quantity = safeUsageNumber(projection.rows[0]?.quantity ?? '0');
    const hardLimitRaw = entitlement.rows[0]?.hard_limit;
    const hardLimit = hardLimitRaw === null || hardLimitRaw === undefined
      ? null
      : safeUsageNumber(hardLimitRaw);
    const configuredWarnings = new Set((entitlement.rows[0]?.warning_thresholds ?? []).map(safeUsageNumber));
    const recordedWarningSet = new Set(recordedWarnings.rows.map((row) => safeUsageNumber(row.threshold)));
    const dailyFacts = daily.rows.map((row) => ({
      day: row.day,
      at: Date.parse(`${row.day}T00:00:00.000Z`),
      quantity: safeUsageNumber(row.quantity),
    }));
    const paceFacts = dailyFacts.filter((row) => row.at >= paceStart.getTime()
      && row.at < anchorDay.getTime() + DAY_MS);
    const observedDays = paceFacts.filter((row) => row.quantity > 0).length;
    const pace = observedDays >= 2
      ? paceFacts.reduce((sum, row) => sum + row.quantity, 0) / paceWindowDays
      : null;
    const remainingDays = currentPeriod
      ? Math.max(0, Math.floor((endExclusive.getTime() - anchorDay.getTime()) / DAY_MS) - 1)
      : 0;
    const projectedCycleEnd = currentPeriod && pace !== null
      ? quantity + pace * remainingDays
      : null;
    const ledgerQuantity = dailyFacts.reduce((sum, row) => sum + row.quantity, 0);
    const evidenceWarnings: EvidenceBlock['warnings'] = ledgerQuantity === quantity
      ? []
      : [{
          code: 'ledger_attribution_gap',
          message: `Current projection is ${quantity}, while retained contributor ledger facts total ${ledgerQuantity}.`,
          remediation_action_id: 'review_usage_contributors',
        }];
    const evidence = usageEvidence(
      now,
      evidenceWarnings.length > 0 || observedDays < 2 ? 'partial' : 'trusted',
      observedDays,
      paceWindowDays,
      evidenceWarnings,
    );
    const percents = [50, 75, 90, 100] as const;
    let cumulative = 0;
    const cumulativeFacts = dailyFacts.map((row) => {
      cumulative += row.quantity;
      return { ...row, cumulative };
    });
    const thresholdForecasts: UsageControlResult['threshold_forecasts'] = percents.map((percent) => {
      const configuredThreshold = hardLimit === null ? null : Math.ceil(hardLimit * percent / 100);
      const configured = configuredThreshold !== null && configuredWarnings.has(configuredThreshold);
      const recorded = configuredThreshold !== null && recordedWarningSet.has(configuredThreshold);
      const notification = configured
        ? recorded
          ? {
              configured_threshold: configuredThreshold,
              notification_state: 'recorded' as const,
              audit_source: 'usage_warning' as const,
            }
          : {
              configured_threshold: configuredThreshold,
              notification_state: 'armed' as const,
              audit_source: 'organization_entitlement' as const,
            }
        : {
            configured_threshold: null,
            notification_state: 'not_configured' as const,
            audit_source: 'usage_ledger' as const,
          };
      if (hardLimit === null) {
        return { percent, state: 'not_applicable', reached_or_projected_at: null, ...notification };
      }
      const target = hardLimit * percent / 100;
      if (hardLimit === 0) {
        return { percent, state: 'reached', reached_or_projected_at: start.toISOString(), ...notification };
      }
      if (quantity >= target) {
        const crossing = cumulativeFacts.find((row) => row.cumulative >= target);
        return {
          percent,
          state: 'reached',
          reached_or_projected_at: crossing ? new Date(crossing.at).toISOString() : null,
          ...notification,
        };
      }
      if (!currentPeriod || pace === null || pace <= 0 || projectedCycleEnd === null || projectedCycleEnd < target) {
        return { percent, state: 'not_projected', reached_or_projected_at: null, ...notification };
      }
      const daysUntil = Math.ceil((target - quantity) / pace);
      const projectedAt = new Date(anchorDay.getTime() + daysUntil * DAY_MS);
      return projectedAt < endExclusive
        ? { percent, state: 'projected', reached_or_projected_at: projectedAt.toISOString(), ...notification }
        : { percent, state: 'not_projected', reached_or_projected_at: null, ...notification };
    });
    const contributors = contributorRows.rows.map((row) => {
      const accepted = safeUsageNumber(row.quantity);
      const recent = safeUsageNumber(row.recent_quantity);
      const previous = safeUsageNumber(row.previous_quantity);
      return {
        project_slug: row.slug,
        project_name: row.name,
        environment: row.env,
        accepted_events: accepted,
        share: quantity > 0 ? accepted / quantity : null,
        change_7d: previous > 0 ? (recent - previous) / previous : null,
        last_ingest_at: row.last_ingest_at ? new Date(row.last_ingest_at).toISOString() : null,
      };
    });
    const attributedQuantity = contributors.reduce((sum, contributor) => sum + contributor.accepted_events, 0);
    const difference = quantity - attributedQuantity;
    const reconciliation: UsageControlResult['reconciliation'] = {
      metered_quantity: quantity,
      attributed_quantity: attributedQuantity,
      difference,
      unattributed_quantity: Math.max(0, difference),
      overattributed_quantity: Math.max(0, -difference),
      state: difference === 0 ? 'reconciled' : 'partial',
    };
    const actionable = thresholdForecasts
      .filter((forecast) => forecast.percent >= 75
        && (forecast.state === 'reached' || forecast.state === 'projected'));
    const attention = orderAttentionItems(actionable.map<AttentionItem>((forecast) => ({
      id: `usage.threshold.${forecast.percent}`,
      rule_id: `usage.threshold.${forecast.percent}`,
      rule_version: 1,
      severity: forecast.percent === 100 && forecast.state === 'reached'
        ? 'critical'
        : forecast.percent >= 90 ? 'high' : 'medium',
      state: 'open',
      title: forecast.state === 'reached'
        ? `${forecast.percent}% of the configured event cap is reached`
        : `${forecast.percent}% of the configured event cap is projected`,
      reason: forecast.reached_or_projected_at
        ? `Threshold time: ${forecast.reached_or_projected_at}.`
        : 'The threshold state is derived from the current accepted-event quantity.',
      impact: forecast.percent === 100
        ? 'At the configured hard limit, new accepted-event writes are rejected until the cycle resets or the limit changes.'
        : 'Approaching the cap can put measurement continuity at risk.',
      affected: [{ kind: 'customer', ref: orgId }],
      evidence,
      priority: {
        blocking_now: forecast.percent === 100 && forecast.state === 'reached',
        forecasted_at: forecast.state === 'projected' ? forecast.reached_or_projected_at : null,
      },
      primary_action: { id: 'review_usage_contributors', kind: 'navigate', label: 'Review usage contributors', href: '/usage' },
    })));
    const remaining = hardLimit === null ? null : Math.max(0, hardLimit - quantity);
    const formattedQuantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(quantity);
    const result: UsageControlResult = {
      schema_version: 1,
      request_id: randomUUID(),
      generated_at: now.toISOString(),
      scope: {
        organization_id: orgId,
        window: { from: start.toISOString(), to: new Date(endExclusive.getTime() - 1).toISOString(), timezone: 'UTC' },
      },
      answer: {
        state: attention.length > 0 || evidence.state === 'partial' ? 'partial' : quantity === 0 ? 'empty' : 'ready',
        headline: hardLimit === 0
          ? 'No events can be accepted'
          : `${formattedQuantity} accepted events this UTC cycle`,
        takeaway: hardLimit === 0
          ? 'The configured hard limit is zero; every non-empty billable batch is rejected.'
          : hardLimit === null
          ? 'No Core hard limit is configured for this organization.'
          : `${new Intl.NumberFormat('en-US').format(remaining ?? 0)} events remain before the configured hard limit.`,
        primary_value: { value: quantity, unit: 'count', formatted: formattedQuantity },
        why_it_matters: 'Accepted-event continuity determines whether product answers remain complete.',
      },
      attention,
      evidence,
      primary_action: attention[0]?.primary_action
        ?? { id: 'review_usage_contributors', kind: 'navigate', label: 'Review usage contributors', href: '/usage' },
      secondary_actions: [],
      meter: 'events_stored',
      cycle: { from: start.toISOString(), to: new Date(endExclusive.getTime() - 1).toISOString(), timezone: 'UTC' },
      cap: hardLimit === null
        ? { state: 'not_configured', value: null, remaining: null, consequence_at_100_percent: null }
        : {
            state: 'finite',
            value: hardLimit,
            remaining,
            consequence_at_100_percent: 'New accepted-event writes are rejected with billing_limit_reached until the UTC cycle resets or the configured limit changes.',
          },
      pace: {
        observed_days: observedDays,
        events_per_day_7d: pace,
        projected_cycle_end: projectedCycleEnd,
        confidence: pace === null ? 'insufficient' : 'sufficient',
      },
      threshold_forecasts: thresholdForecasts,
      contributors,
      reconciliation,
    };
    await client.query('COMMIT');
    return usageControlResultSchema.parse(result);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function groupUsageRows(rows: Array<{
  project_id: string;
  slug: string;
  name: string;
  env: string;
  quantity: string;
}>): OrganizationUsage['projects'] {
  const projects = new Map<string, OrganizationUsage['projects'][number]>();
  for (const row of rows) {
    const quantity = Number(row.quantity);
    let project = projects.get(row.project_id);
    if (!project) {
      project = { id: row.project_id, slug: row.slug, name: row.name, quantity: 0, environments: [] };
      projects.set(row.project_id, project);
    }
    project.quantity += quantity;
    project.environments.push({ env: row.env, quantity });
  }
  return [...projects.values()];
}

/** Read a rebuildable monthly projection plus its current ledger breakdown. */
export async function getOrganizationUsage(
  pool: pg.Pool,
  orgId: string,
  period: string,
): Promise<OrganizationUsage> {
  const periodStart = `${period}-01`;
  const [projection, entitlement, breakdown, warnings] = await Promise.all([
    pool.query<{ quantity: string }>(
      `SELECT quantity FROM organization_usage
       WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date`,
      [orgId, periodStart],
    ),
    pool.query<{ hard_limit: string | null; warning_thresholds: string[] }>(
      `SELECT hard_limit, warning_thresholds FROM organization_entitlements
       WHERE org_id = $1 AND meter_key = 'events_stored'`,
      [orgId],
    ),
    pool.query<{ project_id: string; slug: string; name: string; env: string; quantity: string }>(
      `SELECT l.project_id::text, p.slug, p.name, l.env, sum(l.quantity)::bigint AS quantity
       FROM usage_ledger l
       JOIN projects p ON p.id = l.project_id
       WHERE l.org_id = $1 AND l.meter_key = 'events_stored' AND l.period_start = $2::date
       GROUP BY l.project_id, p.slug, p.name, l.env
       ORDER BY p.slug, l.env`,
      [orgId, periodStart],
    ),
    pool.query<{ threshold: string; quantity: string }>(
      `SELECT threshold, quantity FROM usage_warnings
       WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date
       ORDER BY threshold`,
      [orgId, periodStart],
    ),
  ]);
  const configured = entitlement.rows[0];
  return {
    meter: 'events_stored',
    period,
    quantity: Number(projection.rows[0]?.quantity ?? 0),
    hard_limit: configured?.hard_limit === null || configured?.hard_limit === undefined ? null : Number(configured.hard_limit),
    warning_thresholds: (configured?.warning_thresholds ?? []).map(Number),
    warnings: warnings.rows.map((warning) => ({ threshold: Number(warning.threshold), quantity: Number(warning.quantity) })),
    projects: groupUsageRows(breakdown.rows),
  };
}

function monthIndex(period: string): number {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return year * 12 + month - 1;
}

function periodFromMonthIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function inclusivePeriods(from: string, to: string): string[] {
  const periods: string[] = [];
  for (let index = monthIndex(from); index <= monthIndex(to); index += 1) {
    periods.push(periodFromMonthIndex(index));
  }
  return periods;
}

/** Read authoritative UTC-month projections with the retained ledger attribution available today. */
export async function getOrganizationUsageRange(
  pool: pg.Pool,
  orgId: string,
  from: string,
  to: string,
): Promise<OrganizationUsageRange> {
  const client = await pool.connect();
  try {
    // Projection and retained attribution are updated atomically by ingest, so
    // they must also be observed through one snapshot to avoid false gaps.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const projections = await client.query<{ period: string; quantity: string }>(
      `SELECT to_char(period_start, 'YYYY-MM') AS period, quantity::text
       FROM organization_usage
       WHERE org_id = $1 AND meter_key = 'events_stored'
         AND period_start >= $2::date AND period_start <= $3::date
       ORDER BY period_start`,
      [orgId, `${from}-01`, `${to}-01`],
    );
    const breakdown = await client.query<{
      period: string; project_id: string; slug: string; name: string; env: string; quantity: string;
    }>(
      `SELECT to_char(l.period_start, 'YYYY-MM') AS period,
              l.project_id::text, p.slug, p.name, l.env, sum(l.quantity)::bigint::text AS quantity
       FROM usage_ledger l
       JOIN projects p ON p.id = l.project_id
       WHERE l.org_id = $1 AND l.meter_key = 'events_stored'
         AND l.period_start >= $2::date AND l.period_start <= $3::date
       GROUP BY l.period_start, l.project_id, p.slug, p.name, l.env
       ORDER BY l.period_start, p.slug, l.env`,
      [orgId, `${from}-01`, `${to}-01`],
    );
    const warnings = await client.query<{ period: string; threshold: string; quantity: string }>(
      `SELECT to_char(period_start, 'YYYY-MM') AS period, threshold::text, quantity::text
       FROM usage_warnings
       WHERE org_id = $1 AND meter_key = 'events_stored'
         AND period_start >= $2::date AND period_start <= $3::date
       ORDER BY period_start, threshold`,
      [orgId, `${from}-01`, `${to}-01`],
    );
    const entitlement = await client.query<{
      period: string; hard_limit: string | null; warning_thresholds: string[] | null;
    }>(
      `SELECT to_char(date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM') AS period,
              entitlement.hard_limit, entitlement.warning_thresholds
       FROM (SELECT 1) AS seed
       LEFT JOIN organization_entitlements entitlement
         ON entitlement.org_id = $1 AND entitlement.meter_key = 'events_stored'`,
      [orgId],
    );

    const periods = new Map<string, OrganizationUsageRangePeriod>();
    const projectMaps = new Map<string, Map<string, OrganizationUsageRangeProject>>();
    for (const period of inclusivePeriods(from, to)) {
      periods.set(period, {
        period, quantity: '0', unattributed_quantity: '0', warnings: [], projects: [],
      });
      projectMaps.set(period, new Map());
    }

    let total = 0n;
    for (const row of projections.rows) {
      const period = periods.get(row.period);
      if (!period) continue;
      period.quantity = row.quantity;
      total += BigInt(row.quantity);
    }
    for (const row of breakdown.rows) {
      const projects = projectMaps.get(row.period);
      if (!projects) continue;
      let project = projects.get(row.project_id);
      if (!project) {
        project = { id: row.project_id, slug: row.slug, name: row.name, quantity: '0', environments: [] };
        projects.set(row.project_id, project);
      }
      project.quantity = (BigInt(project.quantity) + BigInt(row.quantity)).toString();
      project.environments.push({ env: row.env, quantity: row.quantity });
    }
    for (const row of warnings.rows) {
      periods.get(row.period)?.warnings.push({ threshold: Number(row.threshold), quantity: Number(row.quantity) });
    }
    for (const [periodKey, period] of periods) {
      period.projects = [...projectMaps.get(periodKey)!.values()];
      const attributed = period.projects.reduce((sum, project) => sum + BigInt(project.quantity), 0n);
      const projected = BigInt(period.quantity);
      if (attributed > projected) {
        throw new Error(`usage ledger attribution exceeds the ${periodKey} organization projection`);
      }
      period.unattributed_quantity = (projected - attributed).toString();
    }

    const configured = entitlement.rows[0]!;
    const result: OrganizationUsageRange = {
      meter: 'events_stored',
      from,
      to,
      timezone: 'UTC',
      granularity: 'month',
      usage_basis: 'ingest_time',
      quantity: total.toString(),
      current_entitlement: {
        period: configured.period,
        hard_limit: configured.hard_limit === null ? null : Number(configured.hard_limit),
        warning_thresholds: (configured.warning_thresholds ?? []).map(Number),
        basis: 'current_configuration',
      },
      periods: [...periods.values()],
    };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Read retained accepted-event activity by ledger ingestion time, inclusive in UTC. */
export async function getOrganizationUsageActivity(
  pool: pg.Pool,
  orgId: string,
  dateFrom: string,
  dateTo: string,
): Promise<OrganizationUsageActivity> {
  const breakdown = await pool.query<{
    project_id: string;
    slug: string;
    name: string;
    env: string;
    quantity: string;
  }>(
    `SELECT l.project_id::text, p.slug, p.name, l.env, sum(l.quantity)::bigint AS quantity
     FROM usage_ledger l
     JOIN projects p ON p.id = l.project_id
     WHERE l.org_id = $1
       AND l.meter_key = 'events_stored'
       AND l.period_start >= date_trunc('month', $2::date)::date
       AND l.period_start <= date_trunc('month', $3::date)::date
       AND l.ingested_at >= $2::date
       AND l.ingested_at < ($3::date + interval '1 day')
     GROUP BY l.project_id, p.slug, p.name, l.env
     ORDER BY p.slug, l.env`,
    [orgId, dateFrom, dateTo],
  );
  const projectsById = new Map<string, OrganizationUsageActivity['projects'][number]>();
  let total = 0n;
  for (const row of breakdown.rows) {
    const quantity = BigInt(row.quantity);
    total += quantity;
    let project = projectsById.get(row.project_id);
    if (!project) {
      project = { id: row.project_id, slug: row.slug, name: row.name, quantity: '0', environments: [] };
      projectsById.set(row.project_id, project);
    }
    project.quantity = (BigInt(project.quantity) + quantity).toString();
    project.environments.push({ env: row.env, quantity: quantity.toString() });
  }
  const projects = [...projectsById.values()];
  return {
    meter: 'events_stored',
    date_from: dateFrom,
    date_to: dateTo,
    quantity: total.toString(),
    source: 'usage_ledger',
    timezone: 'UTC',
    projects,
  };
}
