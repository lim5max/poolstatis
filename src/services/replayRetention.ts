import type pg from 'pg';
import type { ReplayService } from './replay.js';
import { purgeExpiredReplays } from './replay.js';

export interface ReplayRetentionResult {
  deleted: number;
  errors: number;
}

/** Retryable bounded deletion for expired or previously tombstoned recordings. */
export function startReplayRetention(
  service: ReplayService,
  pool: pg.Pool,
  options: {
    intervalMs: number;
    batchSize?: number;
    onResult?: (result: ReplayRetentionResult) => void;
    onError?: (error: unknown) => void;
  },
): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = purgeExpiredReplays(service, pool, options.batchSize ?? 100)
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
