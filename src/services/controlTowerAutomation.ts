import type pg from 'pg';
import type { QueryService } from './query.js';
import { InsightFeedWorker } from './insightFeedWorker.js';
import { MonitorWorker } from './monitorWorker.js';
import { NotificationWorker } from './notificationWorker.js';
import type { AutomationWorkerOptions } from './automationWorkerShared.js';

export class ControlTowerAutomation {
  private readonly monitors: MonitorWorker;
  private readonly feeds: InsightFeedWorker;
  private readonly notifications: NotificationWorker;

  constructor(pool: pg.Pool, query: QueryService, options: AutomationWorkerOptions) {
    this.monitors = new MonitorWorker(pool, query, options);
    this.feeds = new InsightFeedWorker(pool, query, options);
    this.notifications = new NotificationWorker(pool, options);
  }

  async runOnce(now = new Date()) {
    const monitors = await this.monitors.runOnce(now);
    const feeds = await this.feeds.runOnce(now);
    const notifications = await this.notifications.runOnce(now);
    return { monitors, feeds, notifications };
  }
}

export function startControlTowerAutomation(
  automation: ControlTowerAutomation,
  options: { intervalMs: number; onResult?: (result: Awaited<ReturnType<ControlTowerAutomation['runOnce']>>) => void; onError?: (error: unknown) => void },
): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, options.intervalMs);
    timer.unref();
  };
  const run = () => {
    if (stopped || current) return;
    current = automation.runOnce()
      .then((result) => options.onResult?.(result))
      .catch((error) => options.onError?.(error))
      .finally(() => { current = null; schedule(); });
  };
  run();
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); await current; } };
}
