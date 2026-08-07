import type pg from 'pg';

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
