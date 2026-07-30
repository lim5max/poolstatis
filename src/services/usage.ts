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

/** Read a rebuildable monthly projection plus immutable-ledger breakdown. */
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
  const projects = new Map<string, OrganizationUsage['projects'][number]>();
  for (const row of breakdown.rows) {
    const quantity = Number(row.quantity);
    let project = projects.get(row.project_id);
    if (!project) {
      project = { id: row.project_id, slug: row.slug, name: row.name, quantity: 0, environments: [] };
      projects.set(row.project_id, project);
    }
    project.quantity += quantity;
    project.environments.push({ env: row.env, quantity });
  }
  const configured = entitlement.rows[0];
  return {
    meter: 'events_stored',
    period,
    quantity: Number(projection.rows[0]?.quantity ?? 0),
    hard_limit: configured?.hard_limit === null || configured?.hard_limit === undefined ? null : Number(configured.hard_limit),
    warning_thresholds: (configured?.warning_thresholds ?? []).map(Number),
    warnings: warnings.rows.map((warning) => ({ threshold: Number(warning.threshold), quantity: Number(warning.quantity) })),
    projects: [...projects.values()],
  };
}
