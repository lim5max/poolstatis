import type { PropertyFilter } from '../schemas.js';

/** A validated event ready for storage. */
export interface StorableEvent {
  projectId: string;
  env: string;
  event: string;
  timestamp: Date;
  distinctId: string;
  sessionId: string | null;
  properties: Record<string, unknown>;
  registered: boolean;
  /** Set only by trusted server-side platform code (for example flag exposure). */
  isSystem?: boolean;
  /** Physical ingest route that accepted the event; never a user-defined property. */
  eventSource?: 'ingest' | 'experience' | 'system';
}

/** A transport batch whose idempotency must cover the event write itself. */
export interface IdempotentAppend {
  dedupe: 'ingest_24h' | 'experience';
  projectId: string;
  env: string;
  batchId: string;
  events: StorableEvent[];
}

/** Durable append outcome. `inserted` is the exact number of event rows committed. */
export interface AppendResult {
  inserted: number;
  duplicate?: boolean;
  warnings?: UsageWarning[];
}

export interface UsageWarning {
  meter: 'events_stored';
  threshold: number;
  quantity: number;
}

export interface TrendQuery {
  projectId: string;
  env: string;
  event: string;
  filters: PropertyFilter[];
  agg:
    | { kind: 'count' }
    | { kind: 'unique_actors' }
    | { kind: 'value'; property: string; fn: 'sum' | 'avg' | 'min' | 'max' | 'p90' };
  from: Date;
  to: Date;
  interval: 'hour' | 'day' | 'week' | 'month';
  breakdownProperty?: string;
}

export interface TrendPoint {
  bucket: string; // ISO timestamp of bucket start
  value: number;
  breakdown_value?: string;
}

export interface FunnelStepQuery {
  event: string;
  filters: PropertyFilter[];
}

export interface FunnelQuery {
  projectId: string;
  env: string;
  steps: FunnelStepQuery[];
  windowSeconds: number;
  from: Date;
  to: Date;
}

export interface SampleQuery {
  projectId: string;
  env?: string;
  event?: string;
  registered?: boolean;
  distinct_id?: string;
  filters?: PropertyFilter[];
  from?: Date;
  to?: Date;
  limit: number;
}

/** Server-native engagement summary for one actor, derived from their events. */
export interface ActorSummary {
  first_seen: string | null;
  last_seen: string | null;
  total_events: number;
  distinct_events: number;
  active_days: number;
  sessions: number;
  registered_share: number;
  top_events: Array<{ event: string; count: number }>;
}

export interface RawEvent {
  event: string;
  timestamp: string;
  distinct_id: string;
  session_id: string | null;
  properties: Record<string, unknown>;
  registered: boolean;
  env: string;
}

export interface EventNameStat {
  event: string;
  count: number;
  registered_share: number;
  last_seen: string;
}

export interface EventStatsQuery {
  projectId: string;
  env: string;
  events: string[];
  sinceDays: number;
}

export interface MeasurementCoverageQuery {
  projectId: string;
  env: string;
  event: string;
  filters: PropertyFilter[];
  properties: string[];
  sinceDays: number;
}

export interface MeasurementCoverage {
  events: number;
  actors: number;
  rawActors: number;
  registeredCoverage: number;
  distinctIdCoverage: number;
  propertyCoverage: Record<string, number>;
}

export interface MetricAggregateQuery {
  projectId: string;
  env: string;
  event: string;
  filters: PropertyFilter[];
  properties: string[];
  agg: TrendQuery['agg'];
  from: Date;
  to: Date;
}

export interface MetricAggregate extends MeasurementCoverage {
  value: number;
}

export interface EntityStatusEvidenceSpec {
  event: string;
  entity_type: string;
  expected_status: string;
}

export interface EntityStatusEvidence {
  entity_type: string;
  entity_id: string;
  current_status: string;
  event: string;
  expected_status: string;
  last_event_at: string;
  evidence_events: number;
  entity_updated_at: string;
}

export interface EntityStatusEvidenceQuery {
  projectId: string;
  env: string;
  specs: EntityStatusEvidenceSpec[];
  sinceDays: number;
  limit: number;
}

export type Interval = 'hour' | 'day' | 'week' | 'month';

export interface RetentionQuery {
  projectId: string;
  env: string;
  startEvent: string;
  startFilters: PropertyFilter[];
  returnEvent: string;
  returnFilters: PropertyFilter[];
  interval: 'day' | 'week' | 'month';
  periods: number;
  from: Date;
  to: Date;
}

export interface RetentionCohort {
  cohort: string; // ISO bucket start
  size: number;
  // retained[p] = actors from this cohort active in period p (p=0 is the cohort itself)
  retained: number[];
  // How many leading periods have fully elapsed by the query's `to` bound. Periods
  // beyond this are right-censored — their 0s mean "not observed yet", not "churned".
  mature_periods: number;
}

export interface IntervalActivityQuery {
  projectId: string;
  env: string;
  event: string;
  filters: PropertyFilter[];
  interval: 'day' | 'week' | 'month';
  from: Date;
  to: Date;
}

export interface LifecyclePoint {
  bucket: string;
  new: number;
  returning: number;
  resurrecting: number;
  dormant: number; // negative count of actors who went quiet this interval
}

export interface StickinessBin {
  intervals_active: number;
  actors: number;
}

/** First-exposure experiment outcome counts, grouped by the allocated variant. */
export interface ExperimentResultsQuery {
  projectId: string;
  env: string;
  flagKey: string;
  metricEvent: string;
  metricFilters: PropertyFilter[];
  from: Date;
  to: Date;
}

export interface ExperimentVariantOutcome {
  variant: string;
  exposed: number;
  converted: number;
}

export interface InteractionMapQuery {
  projectId: string;
  env: string;
  surface: string;
  from: Date;
  to: Date;
  grid: number;
}

export interface InteractionMapCell {
  x: number;
  y: number;
  count: number;
  actors: number;
}

export interface InteractionMapLabel {
  label: string;
  count: number;
  actors: number;
}

export interface InteractionMapResult {
  cells: InteractionMapCell[];
  labels: InteractionMapLabel[];
}

export interface ExperienceSessionQuery {
  projectId: string;
  env: string;
  surface: string;
  sessionId: string;
  from: Date;
  to: Date;
  limit: number;
}

export interface ExperienceSessionEvent {
  timestamp: string;
  kind: 'page_viewed' | 'element_clicked' | 'scroll_depth' | 'section_exposed' | 'client_error';
  route: string;
  sequence: number;
  label?: string;
  x?: number;
  y?: number;
  depth?: number;
  error_type?: 'error' | 'unhandled_rejection';
  section?: string;
  top?: number;
}

export interface VisualExperienceQuery {
  projectId: string;
  env: string;
  surface: string;
  route: string;
  version: string;
  device: 'desktop' | 'mobile';
  viewportWidth?: number;
  viewportHeight?: number;
  documentWidth?: number;
  documentHeight?: number;
  from: Date;
  to: Date;
  grid: number;
}

export interface VisualExperienceResult {
  summary: {
    events: number;
    page_views: number;
    sessions: number;
    actors: number;
    clicks: number;
    max_document_width: number;
    max_document_height: number;
  };
  click_cells: Array<{ x: number; y: number; count: number; actors: number }>;
  click_labels: Array<{ label: string; count: number; actors: number }>;
  scroll_coverage: Array<{ depth: number; sessions: number; actors: number; percentage: number }>;
  sections: Array<{
    section: string;
    top: number;
    sessions: number;
    actors: number;
    percentage: number;
    dropoff_percentage: number;
  }>;
}

/**
 * The narrow storage interface the whole platform depends on.
 * Every method must be implementable efficiently on both Postgres and
 * ClickHouse — that constraint is what keeps the Query DSL small.
 */
export interface EventStore {
  append(events: StorableEvent[]): Promise<AppendResult>;
  /** Returns `duplicate` when the batch was already durably appended. */
  appendIdempotent(batch: IdempotentAppend): Promise<AppendResult>;
  trend(q: TrendQuery): Promise<TrendPoint[]>;
  funnel(q: FunnelQuery): Promise<number[]>; // actor count per step
  retention(q: RetentionQuery): Promise<RetentionCohort[]>;
  lifecycle(q: IntervalActivityQuery): Promise<LifecyclePoint[]>;
  stickiness(q: IntervalActivityQuery): Promise<StickinessBin[]>;
  experimentResults(q: ExperimentResultsQuery): Promise<ExperimentVariantOutcome[]>;
  interactionMap(q: InteractionMapQuery): Promise<InteractionMapResult>;
  experienceSession(q: ExperienceSessionQuery): Promise<ExperienceSessionEvent[]>;
  visualExperience(q: VisualExperienceQuery): Promise<VisualExperienceResult>;
  sample(q: SampleQuery): Promise<RawEvent[]>;
  eventNames(projectId: string, env: string, sinceDays: number): Promise<EventNameStat[]>;
  eventStats(q: EventStatsQuery): Promise<EventNameStat[]>;
  measurementCoverage(q: MeasurementCoverageQuery): Promise<MeasurementCoverage>;
  metricAggregate(q: MetricAggregateQuery): Promise<MetricAggregate>;
  entityStatusEvidence(q: EntityStatusEvidenceQuery): Promise<EntityStatusEvidence[]>;
  /**
   * Hard-delete events for a project. Optionally scope to one env and/or a
   * single actor (distinct_id) — the latter powers person-level deletion.
   * Returns rows removed.
   */
  purge(projectId: string, env?: string, distinctId?: string): Promise<number>;
  /** Engagement summary for one actor — powers the person page. */
  actorSummary(projectId: string, env: string, distinctId: string): Promise<ActorSummary>;
}
