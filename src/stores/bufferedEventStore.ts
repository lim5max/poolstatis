import { ApiError } from '../errors.js';
import type {
  ActorSummary,
  EntityStatusEvidence,
  EntityStatusEvidenceQuery,
  ExperimentResultsQuery,
  ExperimentVariantOutcome,
  ExperienceSessionEvent,
  ExperienceSessionQuery,
  EventNameStat,
  EventStatsQuery,
  EventStore,
  AppendResult,
  IdempotentAppend,
  FunnelQuery,
  IntervalActivityQuery,
  InteractionMapQuery,
  InteractionMapResult,
  LifecyclePoint,
  MeasurementCoverage,
  MeasurementCoverageQuery,
  MetricAggregate,
  MetricAggregateQuery,
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
  maxConcurrentIdempotentAppends?: number;
}

interface PendingAppend {
  events: StorableEvent[];
  resolve: (result: AppendResult) => void;
  reject: (err: unknown) => void;
}

interface PendingIdempotentAppend {
  batch: IdempotentAppend;
  weight: number;
  resolve: (result: AppendResult) => void;
  reject: (err: unknown) => void;
}

export const DEFAULT_BUFFERED_EVENT_STORE_OPTIONS: BufferedEventStoreOptions = {
  maxEvents: 1000,
  maxDelayMs: 10,
  maxPendingEvents: 50_000,
  maxConcurrentIdempotentAppends: 10,
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
  private inFlightEvents = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private idempotentQueue: PendingIdempotentAppend[] = [];
  private idempotentEvents = 0;
  private idempotentInFlight = 0;

  constructor(private readonly inner: EventStore, options: BufferedEventStoreOptions) {
    this.options = validateOptions(options);
  }

  async append(events: StorableEvent[]): Promise<AppendResult> {
    if (events.length === 0) return { inserted: 0 };
    if (events.length > this.options.maxEvents) {
      throw new ApiError(
        413,
        'ingest_batch_too_large',
        `one append cannot exceed ${this.options.maxEvents} events`,
        'split the request into smaller batches and reuse batch_id only for an exact retry',
      );
    }
    if (this.queuedEvents() + events.length > this.options.maxPendingEvents) {
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

  appendIdempotent(batch: IdempotentAppend): Promise<AppendResult> {
    if (batch.events.length > this.options.maxEvents) {
      return Promise.reject(new ApiError(
        413,
        'ingest_batch_too_large',
        `one append cannot exceed ${this.options.maxEvents} events`,
        'split the request into smaller batches and reuse batch_id only for an exact retry',
      ));
    }
    const weight = Math.max(1, batch.events.length);
    if (this.queuedEvents() + weight > this.options.maxPendingEvents) {
      return Promise.reject(new ApiError(
        503,
        'ingest_backpressure',
        'ingest queue is full; retry this batch shortly',
        'retry with the same batch_id so Poolstatis can deduplicate a later replay',
      ));
    }
    return new Promise((resolve, reject) => {
      this.idempotentQueue.push({ batch, weight, resolve, reject });
      this.idempotentEvents += weight;
      this.pumpIdempotentQueue();
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

  interactionMap(q: InteractionMapQuery): Promise<InteractionMapResult> {
    return this.inner.interactionMap(q);
  }

  experienceSession(q: ExperienceSessionQuery): Promise<ExperienceSessionEvent[]> {
    return this.inner.experienceSession(q);
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

  measurementCoverage(q: MeasurementCoverageQuery): Promise<MeasurementCoverage> {
    return this.inner.measurementCoverage(q);
  }

  metricAggregate(q: MetricAggregateQuery): Promise<MetricAggregate> {
    return this.inner.metricAggregate(q);
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

  private pumpIdempotentQueue(): void {
    const limit = this.options.maxConcurrentIdempotentAppends ?? 10;
    while (this.idempotentInFlight < limit && this.idempotentQueue.length > 0) {
      const item = this.idempotentQueue.shift()!;
      this.idempotentInFlight += 1;
      void this.inner.appendIdempotent(item.batch).then(item.resolve, item.reject).finally(() => {
        this.idempotentInFlight -= 1;
        this.idempotentEvents -= item.weight;
        this.pumpIdempotentQueue();
      });
    }
  }

  private queuedEvents(): number {
    return this.pendingEvents + this.inFlightEvents + this.idempotentEvents;
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
    this.flushing = true;
    try {
      while (this.pending.length > 0) {
        const batch: PendingAppend[] = [];
        let batchEvents = 0;
        while (this.pending.length > 0) {
          const next = this.pending[0]!;
          if (batchEvents + next.events.length > this.options.maxEvents) break;
          this.pending.shift();
          this.pendingEvents -= next.events.length;
          batchEvents += next.events.length;
          batch.push(next);
        }

        this.inFlightEvents += batchEvents;
        try {
          const result = await this.inner.append(batch.flatMap((item) => item.events));
          let offset = 0;
          batch.forEach((item) => {
            const expected = item.events.length;
            const inserted = Math.max(0, Math.min(expected, result.inserted - offset));
            offset += expected;
            item.resolve({ inserted });
          });
        } catch (err) {
          batch.forEach((item) => item.reject(err));
        } finally {
          this.inFlightEvents -= batchEvents;
        }
      }
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
    maxConcurrentIdempotentAppends: positiveInt(
      options.maxConcurrentIdempotentAppends ?? 10,
      'maxConcurrentIdempotentAppends',
    ),
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
