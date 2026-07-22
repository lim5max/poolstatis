import type pg from 'pg';
import type { UsageWarning } from '../stores/eventStore.js';

export interface PendingUsageWarning extends UsageWarning {
  orgId: string;
  periodStart: string;
}

/** Best-effort notification state; it never participates in accepted writes. */
export async function recordUsageWarnings(pool: pg.Pool, warnings: PendingUsageWarning[]): Promise<void> {
  if (warnings.length === 0) return;
  const params: unknown[] = [];
  const values = warnings.map((warning) => {
    params.push(warning.orgId, warning.periodStart, warning.threshold, warning.quantity);
    const offset = params.length - 4;
    return `($${offset + 1}, 'events_stored', $${offset + 2}::date, $${offset + 3}, $${offset + 4})`;
  });
  await pool.query(
    `INSERT INTO usage_warnings (org_id, meter_key, period_start, threshold, quantity)
     VALUES ${values.join(', ')}
     ON CONFLICT (org_id, meter_key, period_start, threshold) DO NOTHING`,
    params,
  );
}
