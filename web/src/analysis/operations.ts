import type { ActorLink, Metric } from '../api/types';
import type { PropertyFilter, TrendQueryResult } from './visualization';

export type AnalyticsRange = '7d' | '30d' | '90d';
export type WebDimension =
  | 'route'
  | 'source'
  | 'medium'
  | 'campaign'
  | 'term'
  | 'content'
  | 'device'
  | 'browser'
  | 'os'
  | 'language'
  | 'timezone'
  | 'country';
export type ActorOrder = 'last_seen_desc' | 'first_seen_desc' | 'events_desc';
export type ActorIdentityStatus = 'stable' | 'linked' | 'anonymous' | 'ambiguous' | 'unknown';

interface WebQueryBase {
  metric: string;
  key_metric?: string;
  date_from: string;
  date_to?: string | null;
  filters: PropertyFilter[];
  env: string;
}

export interface WebAnalyticsQueryInput extends WebQueryBase {
  kind: 'web_analytics';
  dimensions: WebDimension[];
}

export interface WebSessionsQueryInput extends WebQueryBase {
  kind: 'web_sessions';
  limit: number;
}

export interface WebSessionQueryInput extends WebQueryBase {
  kind: 'web_session';
  session_id: string;
  actor_id?: string;
  page_limit: number;
}

export interface ActorsQueryInput {
  kind: 'actors';
  env: string;
  from?: string;
  to?: string | null;
  limit: number;
  cursor?: string;
  order: ActorOrder;
  search?: { kind: 'exact_id'; value: string };
  propertyFilters: PropertyFilter[];
  activityMetric?: string;
}

export type OperationalQueryInput =
  | WebAnalyticsQueryInput
  | WebSessionsQueryInput
  | WebSessionQueryInput
  | ActorsQueryInput;

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

interface OperationalMeta {
  computed_at: string;
  date_range: { from: string; to: string };
  sampling: null;
  source: 'native';
}

export interface WebAnalyticsResult {
  kind: 'web_analytics';
  summary: {
    visitors: number;
    sessions: number;
    page_views: number;
    average_session_duration_ms: number | null;
  };
  engagement: {
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
  };
  breakdowns: Record<string, Array<{
    value: string;
    visitors: number;
    sessions: number;
    page_views: number;
    percentage: number | null;
  }>>;
  meta: OperationalMeta & {
    truncated_dimensions: string[];
    unavailable_dimensions: Record<string, {
      code: string;
      reason: string;
      next_action: string;
    }>;
    definitions: Record<string, string>;
    accepted_event_accounting: string;
    privacy: string;
  };
}

export interface WebSessionsResult {
  kind: 'web_sessions';
  sessions: WebSessionSummary[];
  meta: OperationalMeta & {
    total: number;
    truncated: boolean;
    definitions: Record<string, string>;
  };
}

export interface WebSessionResult {
  kind: 'web_session';
  summary: WebSessionSummary | null;
  pages: WebPageEngagement[];
  meta: OperationalMeta & {
    no_data_reason?: string;
    privacy: string;
    total_pages: number;
    truncated: boolean;
  };
}

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
}

export interface ActorsResult {
  kind: 'actors';
  actors: ActorListItem[];
  meta: OperationalMeta & {
    limit: number;
    order: ActorOrder;
    next_cursor: string | null;
    activity_metric: { key: string; source: 'native'; population_filter: true } | null;
    capabilities: {
      property_filters: { available: false; reason: string };
      pinned_properties: { available: false; reason: string };
      session_count: {
        source: 'canonical_browser_sessions';
        unavailable_value: null;
        project_capability: boolean;
      };
    };
    provenance: {
      identity_status: string;
      top_events: { registered_only: true; limit: 8 };
      pinned_properties: { source: null; fail_closed: true };
    };
  };
}

export type OperationalQueryResult =
  | WebAnalyticsResult
  | WebSessionsResult
  | WebSessionResult
  | ActorsResult;

export interface PersonResult {
  requested_distinct_id: string;
  distinct_id: string;
  env: string;
  window: { from: string; to: string };
  summary: {
    first_seen: string | null;
    last_seen: string | null;
    total_events: number;
    distinct_events: number;
    active_days: number;
    sessions: number | null;
    session_count: number | null;
    registered_share: number;
    top_events: Array<{ event: string; count: number }>;
  };
  identity: {
    status: ActorIdentityStatus;
    raw_actor_count: number;
    raw_distinct_ids: string[];
    raw_distinct_ids_truncated: boolean;
    links: ActorLink[];
    links_truncated: boolean;
  };
  entity: null;
  activity: {
    events: Array<{
      event: string;
      timestamp: string;
      distinct_id: string;
      raw_distinct_id: string;
      session_id: string | null;
      properties: Record<string, never>;
      registered: true;
      env: string;
    }>;
    next_cursor: string | null;
    registered_only: true;
    properties_masked: true;
  };
  capabilities: {
    identity_entity: Capability;
    activity_properties: Capability;
    pinned_properties: Capability;
    session_count: {
      source: 'canonical_browser_sessions';
      unavailable_value: null;
      project_capability: boolean;
    };
    purge: {
      scope: 'exact_raw_distinct_id';
      canonical_expansion: false;
      warning: string;
    };
  };
}

interface Capability {
  available: false;
  reason: string;
  source: null;
}

export interface WebWorkspaceResult {
  metric: Metric;
  overview: WebAnalyticsResult;
  sessions: WebSessionsResult;
  trend: TrendQueryResult;
}

export const WEB_PAGE_VIEW_METRIC = 'web_page_views';

export function rangeDateFrom(range: AnalyticsRange): string {
  return `-${range}`;
}

export function webPageMetric(metrics: Metric[]): Metric | null {
  return metrics.find((metric) => metric.key === WEB_PAGE_VIEW_METRIC && metric.status === 'active') ?? null;
}

export function engagementLabel(value: boolean | null): string {
  if (value === null) return 'Unknown';
  return value ? 'Engaged' : 'Not engaged';
}

export function formatPercent(value: number | null): string {
  return value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
}

export function formatDurationMs(value: number | null): string {
  if (value === null) return 'Unavailable';
  if (value < 1_000) return `${Math.round(value)} ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function actorStatusLabel(status: ActorIdentityStatus): string {
  return status === 'linked' ? 'Linked'
    : status === 'ambiguous' ? 'Ambiguous'
      : status === 'unknown' ? 'Unknown'
        : status === 'stable' ? 'Stable'
          : 'Anonymous';
}
