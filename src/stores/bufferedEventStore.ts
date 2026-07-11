import { ApiError } from '../errors.js';
import type {
  ActorSummary,
  EntityStatusEvidence,
  EntityStatusEvidenceQuery,
  ExperimentResultsQuery,
  ExperimentVariantOutcome,
  EventNameStat,
  EventStatsQuery,
  EventStore,
  FunnelQuery,
  IntervalActivityQuery,
  LifecyclePoint,
  RawEvent,
  RetentionCohort,
  RetentionQuery,
  SampleQuery,
  StickinessBin,
  StorableEvent,
  TrendPoint,
  TrendQuery,
} from './eventStore.js';

export interface BufferedEventStoreOptions {
  maxEvents: number;
  maxDelayMs: number;
  maxPendingEvents: number;
}

interface PendingAppend {
  events: StorableEvent[];
  resolve: () => void;
  reject: (err: unknown) => void;
}

export const DEFAULT_BUFFERED_EVENT_STORE_OPTIONS: BufferedEventStoreOptions = {
  maxEvents: 1000,
  maxDelayMs: 10,
  maxPendingEvents: 50_000,
};

/**
 * Coalesces concurrent small ingest writes into fewer DB inserts while keeping
 * request acknowledgement durable: callers resolve only after the delegate
 * append has completed.
 */
export class BufferedEventStore implements EventStore {
  private readonly options: BufferedEventStoreOptions;
  private pending: PendingAppend[] = [];
  private pendingEvents = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private readonly inner: EventStore, options: BufferedEventStoreOptions) {
    this.options = validateOptions(options);
  }

  async append(events: StorableEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.pendingEvents + events.length > this.options.maxPendingEvents) {
      throw new ApiError(
        503,
        'ingest_backpressure',
        'ingest queue is full; retry this batch shortly',
        'retry with the same batch_id so Poolstatis can deduplicate a later replay',
      );
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ events, resolve, reject });
      this.pendingEvents += events.length;

      if (this.pendingEvents >= this.options.maxEvents) {
        this.requestFlush();
      } else {
        this.scheduleFlush();
      }
    });
  }

  trend(q: TrendQuery): Promise<TrendPoint[]> {
    return this.inner.trend(q);
  }

  funnel(q: FunnelQuery): Promise<number[]> {
    return this.inner.funnel(q);
  }

  retention(q: RetentionQuery): Promise<RetentionCohort[]> {
    return this.inner.retention(q);
  }

  lifecycle(q: IntervalActivityQuery): Promise<LifecyclePoint[]> {
    return this.inner.lifecycle(q);
  }

  stickiness(q: IntervalActivityQuery): Promise<StickinessBin[]> {
    return this.inner.stickiness(q);
  }

  experimentResults(q: ExperimentResultsQuery): Promise<ExperimentVariantOutcome[]> {
    return this.inner.experimentResults(q);
  }

  sample(q: SampleQuery): Promise<RawEvent[]> {
    return this.inner.sample(q);
  }

  eventNames(projectId: string, env: string, sinceDays: number): Promise<EventNameStat[]> {
    return this.inner.eventNames(projectId, env, sinceDays);
  }

  eventStats(q: EventStatsQuery): Promise<EventNameStat[]> {
    return this.inner.eventStats(q);
  }

  entityStatusEvidence(q: EntityStatusEvidenceQuery): Promise<EntityStatusEvidence[]> {
    return this.inner.entityStatusEvidence(q);
  }

  purge(projectId: string, env?: string, distinctId?: string): Promise<number> {
    return this.inner.purge(projectId, env, distinctId);
  }

  actorSummary(projectId: string, env: string, distinctId: string): Promise<ActorSummary> {
    return this.inner.actorSummary(projectId, env, distinctId);
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushPending();
    }, this.options.maxDelayMs);
  }

  private requestFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.flushPending();
  }

  private async flushPending(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];
    this.pendingEvents = 0;
    this.flushing = true;

    try {
      await this.inner.append(batch.flatMap((item) => item.events));
      batch.forEach((item) => item.resolve());
    } catch (err) {
      batch.forEach((item) => item.reject(err));
    } finally {
      this.flushing = false;
      if (this.pending.length > 0) {
        if (this.pendingEvents >= this.options.maxEvents) this.requestFlush();
        else this.scheduleFlush();
      }
    }
  }
}

function validateOptions(options: BufferedEventStoreOptions): BufferedEventStoreOptions {
  const parsed = {
    maxEvents: positiveInt(options.maxEvents, 'maxEvents'),
    maxDelayMs: positiveInt(options.maxDelayMs, 'maxDelayMs'),
    maxPendingEvents: positiveInt(options.maxPendingEvents, 'maxPendingEvents'),
  };
  if (parsed.maxEvents > parsed.maxPendingEvents) {
    throw new Error('maxEvents must be less than or equal to maxPendingEvents');
  }
  return parsed;
}

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
