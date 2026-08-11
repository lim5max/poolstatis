import type { PropertyFilter } from '../schemas.js';

/** A validated event ready for storage. */
export interface StorableEvent {
  id?: string;
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
  /** How this fact entered the current store materialization. */
  origin?: 'live' | 'backfill';
  backfillBatchId?: string | null;
  revision?: number;
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

export interface AcceptedIngestTrendQuery {
  projectId: string;
  env: string;
  from: Date;
  to: Date;
  interval: 'hour' | 'day';
}

export interface AcceptedIngestTrendPoint {
  bucket: string;
  accepted: number;
}

export interface WebAnalyticsQuery {
  projectId: string;
  env: string;
  event: string;
  filters: PropertyFilter[];
  from: Date;
  to: Date;
  dimensions: Array<{
    key: string;
    property: string;
    missingValue: string;
    allowedValues?: string[];
  }>;
  keyMetric?: FunnelStepQuery;
}

export interface WebAnalyticsCounts {
  visitors: number;
  sessions: number;
  page_views: number;
}

export interface WebAnalyticsResult {
  summary: WebAnalyticsCounts & { average_session_duration_ms: number | null };
  engagement: WebEngagementSummary;
  breakdowns: Record<string, Array<WebAnalyticsCounts & { value: string }>>;
  truncatedDimensions: string[];
}

export interface WebEngagementSummary {
  measured_sessions: number;
  incomplete_sessions: number;
  unknown_sessions: number;
  engaged_sessions: number;
  bounce_sessions: number;
  measured_session_coverage: number | null;
  engaged_rate: number | null;
  bounce_rate: number | null;
  single_page_sessions: number;
  timed_page_views: number;
  total_page_views: number;
  timed_page_coverage: number | null;
  foreground_ms: number;
  session_span_ms: number;
}

export interface WebEngagementBaseQuery {
  projectId: string;
  env: string;
  event: string;
  filters: PropertyFilter[];
  from: Date;
  to: Date;
  keyMetric?: FunnelStepQuery;
}

export interface WebSessionsQuery extends WebEngagementBaseQuery {
  limit: number;
}

export interface WebSessionQuery extends WebEngagementBaseQuery {
  sessionId: string;
  actorId?: string;
  pageLimit: number;
}

export interface PageEngagementQuery extends WebEngagementBaseQuery {
  pageViewId: string;
  actorId?: string;
  sessionId?: string;
}

export interface WebPageEngagement {
  page_view_id: string;
  session_id: string;
  actor_id: string;
  route: string;
  viewed_at: string;
  last_snapshot_at: string | null;
  sequence: number | null;
  foreground_ms: number | null;
  elapsed_ms: number | null;
  max_scroll_pct: number | null;
  interaction_count: number | null;
  reason: string | null;
  timed: boolean;
  complete: boolean;
}

export interface WebSessionSummary {
  session_id: string;
  actor_id: string;
  started_at: string;
  ended_at: string;
  page_views: number;
  timed_page_views: number;
  foreground_ms: number;
  session_span_ms: number;
  engaged: boolean | null;
  bounce: boolean | null;
  single_page: boolean;
  complete: boolean;
}

export interface WebSessionsResult {
  sessions: WebSessionSummary[];
  total: number;
}

export interface WebSessionResult {
  summary: WebSessionSummary | null;
  pages: WebPageEngagement[];
  total: number;
  ambiguous_actor: boolean;
}

export interface WebPageEngagementResult {
  page: WebPageEngagement | null;
  ambiguous_actor: boolean;
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

export type ActorIdentityStatus = 'stable' | 'linked' | 'anonymous' | 'ambiguous' | 'unknown';
export type ActorOrder = 'interesting_desc' | 'last_seen_desc' | 'first_seen_desc' | 'events_desc';

export type ActorRankReason =
  | 'recently_observed'
  | 'stalled_after_activity'
  | 'sustained_activity'
  | 'recent_activity';

export interface ActorListItem {
  distinct_id: string;
  raw_actor_count: number;
  first_seen: string;
  last_seen: string;
  total_events: number;
  active_days: number;
  session_count: number | null;
  top_events: Array<{ event: string; count: number }>;
  pinned_properties: Record<string, unknown>;
  identity_status: ActorIdentityStatus;
  interesting_score: number;
  rank_reasons: ActorRankReason[];
}

/** Internal detail fields retained for Person compatibility, not Actors DSL output. */
export interface ActorListRecord extends ActorListItem {
  distinct_events: number;
  registered_share: number;
}

export interface ActorsKeyset {
  value: string | number;
  distinctId: string;
}

export interface ActorsQuery {
  projectId: string;
  env: string;
  from: Date;
  to: Date;
  snapshotIngestedAt: Date;
  limit: number;
  order: ActorOrder;
  cursor?: ActorsKeyset;
  searchExactId?: string;
  activity?: FunnelStepQuery;
  trustedBrowserSessions: boolean;
}

export interface ActorsResult {
  actors: ActorListRecord[];
  hasMore: boolean;
}

export interface ActorActivityKeyset {
  timestamp: string;
  ingestedAt: string;
  event: string;
  rawDistinctId: string;
  sessionId: string;
  propertiesHash: string;
  duplicateOrdinal: number;
}

export interface ActorActivityQuery {
  projectId: string;
  env: string;
  distinctId: string;
  from: Date;
  to: Date;
  snapshotIngestedAt: Date;
  limit: number;
  cursor?: ActorActivityKeyset;
}

export interface ActorActivityEvent {
  event: string;
  timestamp: string;
  distinct_id: string;
  raw_distinct_id: string;
  session_id: string | null;
  properties: Record<string, unknown>;
  registered: true;
  env: string;
}

export interface ActorActivityResult {
  events: ActorActivityEvent[];
  hasMore: boolean;
  lastKey?: ActorActivityKeyset;
}

export interface RawEvent {
  id: string;
  event: string;
  timestamp: string;
  distinct_id: string;
  session_id: string | null;
  properties: Record<string, unknown>;
  registered: boolean;
  env: string;
  revision: number;
  origin: 'live' | 'backfill';
  backfill_batch_id: string | null;
  ingested_at: string;
  editable: boolean;
}

export interface HistoricalBackfill {
  projectId: string;
  env: string;
  batchId: string;
  payloadSha256: string;
  reason: string;
  actor: string;
  events: StorableEvent[];
}

export interface BackfillRecord {
  id: string;
  env: string;
  batch_id: string;
  payload_sha256: string;
  reason: string;
  actor: string;
  event_count: number;
  registered_count: number;
  unregistered_count: number;
  min_timestamp: string;
  max_timestamp: string;
  created_at: string;
}

export interface BackfillResult {
  batch: BackfillRecord;
  inserted: number;
  duplicate?: boolean;
  warnings?: UsageWarning[];
}

export interface EventRevisionInput {
  projectId: string;
  env: string;
  eventId: string;
  expectedRevision: number;
  actor: string;
  reason: string;
  event: StorableEvent;
}

export interface EventRevisionRecord {
  id: string;
  event_id: string;
  revision: number;
  actor: string;
  reason: string;
  previous_snapshot: RawEvent;
  snapshot: RawEvent;
  created_at: string;
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

/** Bounded event evidence used by the organization project portfolio. */
export interface ProjectPortfolioEventStats {
  project_id: string;
  events_24h: number;
  events_7d: number;
  events_30d: number;
  registered_events_30d: number;
  last_event_at: string | null;
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
  actorId?: string;
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
  click_cells: Array<{ x: number; y: number; count: number; sessions: number; actors: number }>;
  click_labels: Array<{ label: string; count: number; sessions: number; actors: number }>;
  click_labels_truncated: boolean;
  scroll_coverage: Array<{ depth: number; sessions: number; actors: number; percentage: number }>;
  sections: Array<{
    section: string;
    top: number;
    sessions: number;
    actors: number;
    percentage: number;
    dropoff_percentage: number;
  }>;
  sections_truncated: boolean;
}

export interface ExperienceSessionResult {
  events: ExperienceSessionEvent[];
  actorIds: string[];
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
  /** Accepted physical event volume by durable ingest time, never event time. */
  acceptedIngestTrend(q: AcceptedIngestTrendQuery): Promise<AcceptedIngestTrendPoint[]>;
  trend(q: TrendQuery): Promise<TrendPoint[]>;
  webAnalytics(q: WebAnalyticsQuery): Promise<WebAnalyticsResult>;
  webSessions(q: WebSessionsQuery): Promise<WebSessionsResult>;
  webSession(q: WebSessionQuery): Promise<WebSessionResult>;
  pageEngagement(q: PageEngagementQuery): Promise<WebPageEngagementResult>;
  funnel(q: FunnelQuery): Promise<number[]>; // actor count per step
  retention(q: RetentionQuery): Promise<RetentionCohort[]>;
  lifecycle(q: IntervalActivityQuery): Promise<LifecyclePoint[]>;
  stickiness(q: IntervalActivityQuery): Promise<StickinessBin[]>;
  experimentResults(q: ExperimentResultsQuery): Promise<ExperimentVariantOutcome[]>;
  interactionMap(q: InteractionMapQuery): Promise<InteractionMapResult>;
  experienceSession(q: ExperienceSessionQuery): Promise<ExperienceSessionResult>;
  experienceLastCaptures(projectId: string, env: string, surfaces: string[]): Promise<Record<string, string>>;
  visualExperience(q: VisualExperienceQuery): Promise<VisualExperienceResult>;
  sample(q: SampleQuery): Promise<RawEvent[]>;
  getEvent(projectId: string, env: string, eventId: string): Promise<RawEvent | null>;
  backfill(batch: HistoricalBackfill): Promise<BackfillResult>;
  reviseEvent(input: EventRevisionInput): Promise<EventRevisionRecord>;
  eventHistory(projectId: string, env: string, eventId: string): Promise<{
    event: RawEvent;
    revisions: EventRevisionRecord[];
  } | null>;
  listBackfills(projectId: string, env: string, limit: number): Promise<BackfillRecord[]>;
  eventNames(projectId: string, env: string, sinceDays: number): Promise<EventNameStat[]>;
  eventStats(q: EventStatsQuery): Promise<EventNameStat[]>;
  measurementCoverage(q: MeasurementCoverageQuery): Promise<MeasurementCoverage>;
  metricAggregate(q: MetricAggregateQuery): Promise<MetricAggregate>;
  entityStatusEvidence(q: EntityStatusEvidenceQuery): Promise<{
    issues: EntityStatusEvidence[];
    matchedEntities: number;
  }>;
  projectPortfolioStats(projectIds: string[]): Promise<ProjectPortfolioEventStats[]>;
  /**
   * Hard-delete events for a project. Optionally scope to one env and/or a
   * single actor (distinct_id) — the latter powers person-level deletion.
   * Returns rows removed.
   */
  purge(projectId: string, env?: string, distinctId?: string): Promise<number>;
  /** Engagement summary for one actor — powers the person page. */
  actorSummary(projectId: string, env: string, distinctId: string): Promise<ActorSummary>;
  actors(q: ActorsQuery): Promise<ActorsResult>;
  actorActivity(q: ActorActivityQuery): Promise<ActorActivityResult>;
}
