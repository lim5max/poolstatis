import type pg from 'pg';
import type { ArtifactStore } from '../stores/artifactStore.js';

export interface ExperienceArtifactRetentionResult {
  snapshotsDeleted: number;
  artifactErrors: number;
}

/** Delete expired immutable snapshots in small retryable batches. */
export async function purgeExpiredExperienceSnapshots(
  pool: pg.Pool,
  artifacts: ArtifactStore,
  limit = 100,
  now = new Date(),
): Promise<ExperienceArtifactRetentionResult> {
  const { rows } = await pool.query<{ id: string; project_id: string; artifact_key: string }>(
    `SELECT id, project_id, artifact_key
     FROM experience_snapshots
     WHERE expires_at <= $1
     ORDER BY expires_at
     LIMIT $2`,
    [now, limit],
  );
  let snapshotsDeleted = 0;
  let artifactErrors = 0;
  for (const row of rows) {
    try {
      await artifacts.delete(row.artifact_key);
    } catch {
      artifactErrors += 1;
      continue;
    }
    const result = await pool.query(
      'DELETE FROM experience_snapshots WHERE project_id = $1 AND id = $2 AND expires_at <= $3',
      [row.project_id, row.id, now],
    );
    snapshotsDeleted += result.rowCount ?? 0;
  }
  return { snapshotsDeleted, artifactErrors };
}

export function startExperienceArtifactRetention(
  pool: pg.Pool,
  artifacts: ArtifactStore,
  options: {
    intervalMs: number;
    batchSize?: number;
    onResult?: (result: ExperienceArtifactRetentionResult) => void;
    onError?: (error: unknown) => void;
  },
): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = purgeExpiredExperienceSnapshots(pool, artifacts, options.batchSize ?? 100)
      .then((result) => options.onResult?.(result))
      .catch((error) => options.onError?.(error))
      .finally(() => { running = null; });
  };
  run();
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
