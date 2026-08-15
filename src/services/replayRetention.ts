import type pg from 'pg';
import type { ReplayService } from './replay.js';
import { purgeExpiredReplays } from './replay.js';

export interface ReplayRetentionResult {
  deleted: number;
  projectsDeleted: number;
  errors: number;
  hasMore: boolean;
}

/** Retryable bounded deletion for expired or previously tombstoned recordings. */
export function startReplayRetention(
  service: ReplayService,
  pool: pg.Pool,
  options: {
    intervalMs: number;
    batchSize?: number;
    maxBatchesPerRun?: number;
    expireRecordings?: boolean;
    onResult?: (result: ReplayRetentionResult) => void;
    onError?: (error: unknown) => void;
  },
): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = (async () => {
      const aggregate: ReplayRetentionResult = {
        deleted: 0, projectsDeleted: 0, errors: 0, hasMore: false,
      };
      const maxBatches = options.maxBatchesPerRun ?? 10;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await purgeExpiredReplays(
          service,
          pool,
          options.batchSize ?? 100,
          new Date(),
          options.expireRecordings ?? true,
        );
        aggregate.deleted += result.deleted;
        aggregate.errors += result.errors;
        aggregate.hasMore = result.hasMore;
        if (!result.hasMore) break;
      }
      const projects = await service.retryProjectDeletionJobs(options.batchSize ?? 100);
      aggregate.projectsDeleted += projects.deleted;
      aggregate.errors += projects.errors;
      aggregate.hasMore ||= projects.hasMore;
      options.onResult?.(aggregate);
    })()
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
