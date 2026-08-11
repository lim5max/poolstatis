import type pg from 'pg';

export type WarningKind = 'rejected' | 'unregistered' | 'clock_skew';

export interface IngestWarning {
  signature_id: string;
  kind: WarningKind;
  event: string;
  detail: string;
  sample: unknown;
  count: number;
  first_seen: string;
  last_seen: string;
}

/** One accumulated warning to upsert (count is how many occurred in this batch). */
export interface WarningDelta {
  kind: WarningKind;
  event: string;
  detail: string;
  sample?: unknown;
  count: number;
}

/**
 * Upsert a batch of warnings, deduped by (project, env, kind, event): a repeat
 * bumps `count` and `last_seen` rather than inserting a new row, so the table
 * stays bounded to one row per distinct (kind, event) regardless of volume.
 */
export async function recordWarnings(
  pool: pg.Pool,
  projectId: string,
  env: string,
  deltas: WarningDelta[],
): Promise<void> {
  if (deltas.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const warningParams: unknown[] = [projectId, env];
    const warningValues = deltas.map((delta) => {
      warningParams.push(
        delta.kind,
        delta.event,
        delta.detail,
        delta.sample !== undefined ? JSON.stringify(delta.sample) : null,
        delta.count,
      );
      const base = warningParams.length - 5;
      return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    const warnings = await client.query<{ signature_id: string; kind: WarningKind; event: string }>(
      `INSERT INTO ingest_warnings (project_id, env, kind, event, detail, sample, count)
       VALUES ${warningValues.join(', ')}
       ON CONFLICT (project_id, env, kind, event) DO UPDATE
         SET count = ingest_warnings.count + EXCLUDED.count,
             detail = EXCLUDED.detail,
             sample = COALESCE(EXCLUDED.sample, ingest_warnings.sample),
             last_seen = now()
       RETURNING signature_id, kind, event`,
      warningParams,
    );
    const deltaCounts = new Map(deltas.map((delta) => [`${delta.kind}:${delta.event}`, delta.count]));
    const occurrenceParams: unknown[] = [];
    const occurrenceValues = warnings.rows.map((warning) => {
      occurrenceParams.push(warning.signature_id, deltaCounts.get(`${warning.kind}:${warning.event}`)!);
      const base = occurrenceParams.length - 2;
      return `($${base + 1}, date_trunc('hour', now()), $${base + 2})`;
    });
    await client.query(
      `INSERT INTO ingest_warning_occurrences (signature_id, bucket, count)
       VALUES ${occurrenceValues.join(', ')}
       ON CONFLICT (signature_id, bucket) DO UPDATE
         SET count = ingest_warning_occurrences.count + EXCLUDED.count`,
      occurrenceParams,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listIngestWarnings(
  pool: pg.Pool,
  projectId: string,
  filter: { env?: string; kind?: WarningKind } = {},
): Promise<IngestWarning[]> {
  const params: unknown[] = [projectId];
  let sql = `SELECT signature_id, kind, event, detail, sample, count, first_seen, last_seen
             FROM ingest_warnings WHERE project_id = $1`;
  if (filter.env) { params.push(filter.env); sql += ` AND env = $${params.length}`; }
  if (filter.kind) { params.push(filter.kind); sql += ` AND kind = $${params.length}`; }
  const { rows } = await pool.query(`${sql} ORDER BY last_seen DESC LIMIT 200`, params);
  return rows.map((r) => ({
    signature_id: r.signature_id, kind: r.kind, event: r.event, detail: r.detail, sample: r.sample,
    count: Number(r.count), first_seen: new Date(r.first_seen).toISOString(), last_seen: new Date(r.last_seen).toISOString(),
  }));
}

export async function clearIngestWarnings(pool: pg.Pool, projectId: string, env?: string): Promise<number> {
  const params: unknown[] = [projectId];
  let sql = 'DELETE FROM ingest_warnings WHERE project_id = $1';
  if (env) { params.push(env); sql += ` AND env = $${params.length}`; }
  const { rowCount } = await pool.query(sql, params);
  return rowCount ?? 0;
}
