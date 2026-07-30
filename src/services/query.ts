import type pg from 'pg';
import type { EventStore, MetricAggregate, RetentionCohort } from '../stores/eventStore.js';
import type {
  EntitiesQueryInput,
  ExperienceSessionQueryInput,
  FunnelQueryInput,
  InteractionMapQueryInput,
  LifecycleQueryInput,
  PropertyFilter,
  QueryInput,
  RetentionQueryInput,
  StickinessQueryInput,
  TrendQueryInput,
  WebSessionsQueryInput,
  WebSessionQueryInput,
  PageEngagementQueryInput,
  VisualExperienceCompareInput,
  VisualExperienceQueryInput,
  WebAnalyticsQueryInput,
} from '../schemas.js';
import { parseDateInput } from '../dates.js';
import { badRequest } from '../errors.js';
import { getFunnel, getMetric, type Metric } from './registry.js';
import { countEntities, queryEntities } from './entities.js';
import { getExactExperienceSnapshot, getExperienceSurface } from './experience.js';
import { canonicalQueryKey, type QueryCache } from './queryCache.js';
import type { PostHogAdapter } from './posthog.js';
import {
  assertRegisteredAcquisitionProperties,
  assertTrustedAcquisitionProperties,
} from './acquisitionAttribution.js';
import { assertTrustedSafeRoute } from './browserAnalytics.js';
import type { CountryResolver } from './country.js';

const SESSION_ATTRIBUTION_NOTE = 'Session landing attribution: this associates events with the tagged landing in the same browser session; it is not causal campaign credit.';
const WEB_DIMENSIONS = {
  route: { property: '$route_key', missingValue: 'unavailable' },
  source: { property: '$utm_source', missingValue: 'direct / unknown' },
  country: { property: '$country', missingValue: 'unknown' },
  device: { property: '$device_class', missingValue: 'unknown' },
  browser: { property: '$browser_family', missingValue: 'unknown' },
  os: { property: '$os_family', missingValue: 'unknown' },
  language: { property: '$language', missingValue: 'unknown' },
  timezone: { property: '$timezone', missingValue: 'unknown' },
} as const;

const WEB_FILTER_PROPERTIES = new Set<string>(
  Object.values(WEB_DIMENSIONS)
    .filter((dimension) => dimension.property !== '$country')
    .map((dimension) => dimension.property),
);

export interface QueryMeta {
  computed_at: string;
  date_range?: { from: string; to: string };
  sampling: null;
  note?: string;
  source?: 'native' | 'posthog';
}

interface VisualEvidenceRef {
  type: 'experience_snapshot';
  id: string;
  evidence_ref: string;
}

interface VisualAgentContext {
  scope: {
    surface: string;
    route: string;
    version: string;
    device: 'desktop' | 'mobile';
    purpose: string;
  };
  sample_size: {
    events: number;
    page_views: number;
    sessions: number;
    actors: number;
    clicks: number;
  };
  section_order: string[];
  largest_section_reach_decreases: Array<{
    from_section: string;
    to_section: string;
    from_sessions: number;
    to_sessions: number;
    session_count_decrease: number;
    percentage_point_decrease: number;
  }>;
  click_concentration: Array<{
    label: string;
    count: number;
    actors: number;
    percentage_of_all_clicks: number;
  }>;
  scroll_reach: Array<{ depth: number; sessions: number; actors: number; percentage: number }>;
  output_coverage: {
    click_labels_returned: number;
    click_labels_truncated: boolean;
    sections_returned: number;
    sections_truncated: boolean;
  };
  snapshot_coverage: {
    status: 'fresh' | 'stale' | 'future' | 'missing';
    exact_viewport_match: boolean;
    snapshot_id: string | null;
    evidence_ref: string | null;
    captured_at: string | null;
    expires_at: string | null;
    age_seconds: number | null;
  };
  evidence_refs: VisualEvidenceRef[];
  data_quality: {
    status: 'ok' | 'limited' | 'empty';
    caveats: string[];
  };
  suggested_next_actions: Array<{
    action: 'list_versions' | 'compare_explicit_cohorts';
    tool: 'list_visual_experience_versions' | 'compare_visual_experience';
    reason: string;
    known_parameters: Record<string, unknown>;
    requires: string[];
  }>;
}

interface VisualCompareAgentContext {
  scope: { surface: string; route: string; purpose: string };
  sample_sizes: {
    baseline: VisualAgentContext['sample_size'];
    comparison: VisualAgentContext['sample_size'];
  };
  largest_section_changes: Array<{
    section: string;
    baseline_percentage: number;
    comparison_percentage: number;
    percentage_points: number;
  }>;
  section_taxonomy_mismatches: Array<{
    section: string;
    baseline_present: boolean;
    comparison_present: boolean;
  }>;
  evidence_refs: VisualEvidenceRef[];
  data_quality: VisualAgentContext['data_quality'];
  suggested_next_actions: Array<{
    action: 'inspect_baseline_map' | 'inspect_comparison_map';
    tool: 'get_visual_experience_map';
    reason: string;
    query: Omit<VisualExperienceQueryInput, 'kind'>;
  }>;
}

export type QueryResult =
  | { kind: 'trend'; series: Array<{ bucket: string; value: number; breakdown_value?: string }>; meta: QueryMeta }
  | {
      kind: 'web_analytics';
      summary: {
        visitors: number;
        sessions: number;
        page_views: number;
        average_session_duration_ms: number | null;
      };
      engagement: import('../stores/eventStore.js').WebEngagementSummary;
      breakdowns: Record<string, Array<{
        value: string;
        visitors: number;
        sessions: number;
        page_views: number;
        percentage: number | null;
      }>>;
      meta: QueryMeta & {
        truncated_dimensions: string[];
        definitions: Record<string, string>;
        accepted_event_accounting: string;
        privacy: string;
        country_attribution?: NonNullable<CountryResolver['attribution']>;
      };
    }
  | {
      kind: 'web_sessions';
      sessions: import('../stores/eventStore.js').WebSessionSummary[];
      meta: QueryMeta & {
        total: number;
        truncated: boolean;
        definitions: Record<string, string>;
      };
    }
  | {
      kind: 'web_session';
      summary: import('../stores/eventStore.js').WebSessionSummary | null;
      pages: import('../stores/eventStore.js').WebPageEngagement[];
      meta: QueryMeta & {
        no_data_reason?: string;
        privacy: string;
        total_pages: number;
        truncated: boolean;
      };
    }
  | {
      kind: 'page_engagement';
      page: import('../stores/eventStore.js').WebPageEngagement | null;
      meta: QueryMeta & { no_data_reason?: string };
    }
  | {
      kind: 'funnel';
      steps: Array<{
        label: string;
        metric_key: string;
        purpose: string;
        category: string | null;
        actors: number;
        conversion_from_prev: number;
        conversion_from_start: number;
      }>;
      meta: QueryMeta;
    }
  | { kind: 'entities'; entities: Array<{ entity_id: string; properties: Record<string, unknown>; updated_at: string }>; meta: QueryMeta }
  | {
      kind: 'retention';
      interval: string;
      cohorts: Array<{ cohort: string; size: number; retained: number[]; retained_pct: number[] }>;
      meta: QueryMeta;
    }
  | {
      kind: 'lifecycle';
      interval: string;
      series: Array<{ bucket: string; new: number; returning: number; resurrecting: number; dormant: number }>;
      meta: QueryMeta;
    }
  | {
      kind: 'stickiness';
      interval: string;
      bins: Array<{ intervals_active: number; actors: number }>;
      meta: QueryMeta;
    }
  | {
      kind: 'interaction_map';
      surface: { key: string; name: string; purpose: string; status: 'active' | 'archived' };
      grid: number;
      cells: Array<{ x: number; y: number; count: number; actors: number }>;
      labels: Array<{ label: string; count: number; actors: number }>;
      meta: QueryMeta;
    }
  | {
      kind: 'experience_session';
      surface: { key: string; name: string; purpose: string; status: 'active' | 'archived' };
      session_id: string;
      events: Array<{
        timestamp: string; kind: 'page_viewed' | 'element_clicked' | 'scroll_depth' | 'section_exposed' | 'client_error';
        route: string; sequence: number; label?: string; x?: number; y?: number; depth?: number;
        error_type?: 'error' | 'unhandled_rejection'; section?: string; top?: number;
      }>;
      summary: { page_views: number; clicks: number; max_scroll_depth: number; client_errors: number };
      meta: QueryMeta;
    }
  | {
      kind: 'visual_experience';
      surface: { key: string; name: string; purpose: string; status: 'active' | 'archived' };
      route: string;
      version: string;
      device: 'desktop' | 'mobile';
      grid: number;
      snapshot: Awaited<ReturnType<typeof getExactExperienceSnapshot>>;
      summary: Awaited<ReturnType<EventStore['visualExperience']>>['summary'];
      click_cells: Awaited<ReturnType<EventStore['visualExperience']>>['click_cells'];
      click_labels: Awaited<ReturnType<EventStore['visualExperience']>>['click_labels'];
      click_labels_truncated: boolean;
      scroll_coverage: Awaited<ReturnType<EventStore['visualExperience']>>['scroll_coverage'];
      sections: Awaited<ReturnType<EventStore['visualExperience']>>['sections'];
      sections_truncated: boolean;
      agent_context: VisualAgentContext;
      causality: string;
      meta: QueryMeta;
    }
  | {
      kind: 'visual_experience_compare';
      baseline: Extract<QueryResult, { kind: 'visual_experience' }>;
      comparison: Extract<QueryResult, { kind: 'visual_experience' }>;
      delta: {
        events: number;
        page_views: number;
        sessions: number;
        clicks: number;
        actors: number;
        sections: Array<{
          section: string;
          baseline_present: boolean;
          comparison_present: boolean;
          percentage_points: number | null;
        }>;
      };
      agent_context: VisualCompareAgentContext;
      causality: string;
      meta: QueryMeta;
    };

export class QueryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventStore: EventStore,
    private readonly cache?: QueryCache,
    private readonly posthog?: PostHogAdapter,
    private readonly countryAttribution?: CountryResolver['attribution'],
  ) {}

  async run(projectId: string, q: QueryInput, now: Date = new Date()): Promise<QueryResult> {
    if (this.cache) {
      return this.cache.getOrLoad(projectId, canonicalQueryKey(q), () => this.runUncached(projectId, q, now));
    }
    return this.runUncached(projectId, q, now);
  }

  invalidateProject(projectId: string): void {
    this.cache?.invalidateProject(projectId);
  }

  async aggregateMetricWindow(
    projectId: string,
    input: {
      metricKey: string;
      env: string;
      filters: PropertyFilter[];
      properties: string[];
      from: Date;
      to: Date;
      windowName: 'baseline' | 'observed';
    },
  ): Promise<{
    metric: Pick<Metric, 'key' | 'name' | 'purpose' | 'category' | 'type'>;
    source: 'native' | 'posthog';
    query: TrendQueryInput;
    aggregation: 'window_total';
    result: MetricAggregate;
  }> {
    const metric = await getMetric(this.pool, projectId, input.metricKey);
    if (metric.status !== 'active' || !['count', 'unique_actors', 'value'].includes(metric.type)) {
      throw badRequest(
        'contract_metric_incompatible',
        `metric "${metric.key}" must be active count, unique_actors or value`,
      );
    }
    const source = metric.source as {
      event: string;
      filters?: PropertyFilter[];
      value_property?: string;
      agg?: 'sum' | 'avg' | 'min' | 'max' | 'p90';
      data_source?: 'native' | 'posthog';
      source_connection_id?: string;
    };
    const filters = [...(source.filters ?? []), ...input.filters];
    const agg = metric.type === 'count'
      ? ({ kind: 'count' } as const)
      : metric.type === 'unique_actors'
        ? ({ kind: 'unique_actors' } as const)
        : ({ kind: 'value', property: source.value_property!, fn: source.agg ?? 'sum' } as const);
    const dataSource = source.data_source ?? 'native';
    let result: MetricAggregate;
    if (dataSource === 'posthog') {
      if (!this.posthog || !source.source_connection_id) {
        throw badRequest('posthog_source_unavailable', 'the contract metric PostHog source is unavailable');
      }
      result = await this.posthog.aggregate({
        projectId,
        connectionId: source.source_connection_id,
        metricKey: metric.key,
        windowName: input.windowName,
        event: source.event,
        filters,
        properties: input.properties,
        agg: metric.type === 'unique_actors' ? 'unique_actors' : metric.type === 'count' ? 'count' : 'value',
        from: input.from,
        to: input.to,
      });
    } else {
      result = await this.eventStore.metricAggregate({
        projectId,
        env: input.env,
        event: source.event,
        filters,
        properties: input.properties,
        agg,
        from: input.from,
        to: input.to,
      });
    }
    return {
      metric: {
        key: metric.key,
        name: metric.name,
        purpose: metric.purpose,
        category: metric.category,
        type: metric.type,
      },
      source: dataSource,
      query: {
        kind: 'trend',
        metric: metric.key,
        date_from: input.from.toISOString(),
        date_to: input.to.toISOString(),
        interval: 'day',
        filters: input.filters,
        env: input.env,
      },
      aggregation: 'window_total',
      result,
    };
  }

  private async runUncached(projectId: string, q: QueryInput, now: Date): Promise<QueryResult> {
    switch (q.kind) {
      case 'trend':
        return this.trend(projectId, q, now);
      case 'web_analytics':
        return this.webAnalytics(projectId, q, now);
      case 'web_sessions':
        return this.webSessions(projectId, q, now);
      case 'web_session':
        return this.webSession(projectId, q, now);
      case 'page_engagement':
        return this.pageEngagement(projectId, q, now);
      case 'funnel':
        return this.funnel(projectId, q, now);
      case 'entities':
        return this.entities(projectId, q, now);
      case 'retention':
        return this.retention(projectId, q, now);
      case 'lifecycle':
        return this.lifecycle(projectId, q, now);
      case 'stickiness':
        return this.stickiness(projectId, q, now);
      case 'interaction_map':
        return this.interactionMap(projectId, q, now);
      case 'experience_session':
        return this.experienceSession(projectId, q, now);
      case 'visual_experience':
        return this.visualExperience(projectId, q, now);
      case 'visual_experience_compare':
        return this.visualExperienceCompare(projectId, q, now);
    }
  }

  private async webAnalytics(
    projectId: string,
    q: WebAnalyticsQueryInput,
    now: Date,
  ): Promise<QueryResult> {
    const source = await this.webPageViewSource(projectId, q.metric);
    const keyMetric = q.key_metric
      ? await this.webKeyMetricSource(projectId, q.key_metric)
      : undefined;
    this.assertWebFilterAllowlist(q.filters);
    if (q.dimensions.includes('country')) {
      throw badRequest(
        'web_analytics_dimension_unavailable',
        'country is unavailable until a separately reviewed trusted proxy or MMDB contract is active',
      );
    }
    const routeVocabulary = q.dimensions.includes('route')
      || q.filters.some((filter) => filter.property === '$route_key')
      ? await assertTrustedSafeRoute(this.pool, projectId)
      : null;
    const requestedProperties = [
      ...q.filters.map((filter) => filter.property),
      ...q.dimensions.map((key) => WEB_DIMENSIONS[key].property),
    ];
    await assertTrustedAcquisitionProperties(this.pool, projectId, requestedProperties);
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    this.assertWebDateRange(from, to);
    const result = await this.eventStore.webAnalytics({
      projectId,
      env: q.env,
      event: source.event,
      filters: [
        ...source.filters,
        ...(routeVocabulary ? [{
          property: '$route_key',
          op: 'in' as const,
          value: [...routeVocabulary],
        }] : []),
        ...q.filters,
      ],
      from,
      to,
      dimensions: q.dimensions.map((key) => ({ key, ...WEB_DIMENSIONS[key] })),
      ...(keyMetric ? { keyMetric } : {}),
    });
    return {
      kind: 'web_analytics',
      summary: result.summary,
      engagement: result.engagement,
      breakdowns: Object.fromEntries(
        Object.entries(result.breakdowns).map(([key, rows]) => [
          key,
          rows.map((row) => ({
            ...row,
            percentage: result.summary.page_views === 0
              ? null
              : Math.round((row.page_views / result.summary.page_views) * 1_000) / 10,
          })),
        ]),
      ),
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
        truncated_dimensions: result.truncatedDimensions,
        definitions: {
          visitors: 'Unique query-time resolved actors with canonical browser page views.',
          sessions: 'Distinct (resolved actor, non-empty session_id) pairs with canonical page views.',
          page_views: 'Accepted canonical page.viewed events carrying $browser_context = "1".',
          measured_sessions: 'Canonical sessions with a known positive or complete negative engagement classification.',
          unknown_sessions: 'Canonical sessions without enough lifecycle evidence for a negative classification.',
          engaged_sessions: 'Measured sessions with at least 10,000 ms foreground time, two page views, or the selected key metric.',
          bounce_sessions: 'Lifecycle-complete measured sessions with one page view and no engagement evidence.',
          measured_session_coverage: 'Known engagement classifications divided by canonical sessions; unavailable without sessions.',
          engaged_rate: 'Engaged sessions divided by measured sessions; unavailable without a measured denominator.',
          bounce_rate: 'Complete negative sessions divided by measured sessions; unavailable without a measured denominator.',
          foreground_ms: 'Monotonic visible-and-focused time from the highest cumulative page snapshot.',
          session_span_ms: 'Wall-clock span from the first page view to the latest trusted lifecycle evidence.',
          average_session_duration_ms: 'Average wall-clock session span across lifecycle-complete sessions only; unavailable without complete-session evidence.',
          source: 'Consent-gated session landing attribution; this is not causal campaign credit.',
        },
        accepted_event_accounting: 'Each accepted page.viewed, page.engagement and key-metric event remains one stored event; reads create no synthetic events.',
        privacy: 'Returns only trusted safe route keys and bounded coarse dimensions. Country is unavailable; raw IP, URL, query, hash, user agent, DOM and text are forbidden.',
      },
    };
  }

  private async webSessions(
    projectId: string,
    q: WebSessionsQueryInput,
    now: Date,
  ): Promise<QueryResult> {
    const source = await this.webPageViewSource(projectId, q.metric);
    const keyMetric = q.key_metric
      ? await this.webKeyMetricSource(projectId, q.key_metric)
      : undefined;
    this.assertWebFilterAllowlist(q.filters);
    const routeVocabulary = await assertTrustedSafeRoute(this.pool, projectId);
    await assertTrustedAcquisitionProperties(
      this.pool,
      projectId,
      q.filters.map((filter) => filter.property),
    );
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    this.assertWebDateRange(from, to);
    const result = await this.eventStore.webSessions({
      projectId,
      env: q.env,
      event: source.event,
      filters: [
        ...source.filters,
        { property: '$route_key', op: 'in', value: [...routeVocabulary] },
        ...q.filters,
      ],
      from,
      to,
      limit: q.limit,
      ...(keyMetric ? { keyMetric } : {}),
    });
    return {
      kind: 'web_sessions',
      sessions: result.sessions,
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
        total: result.total,
        truncated: result.total > result.sessions.length,
        definitions: {
          foreground_ms: 'Monotonic visible and focused time from the latest cumulative snapshot per page.',
          session_span_ms: 'Wall-clock span from first page view to latest page evidence; it is not active time.',
          bounce: 'Known only for lifecycle-complete sessions without engagement evidence.',
        },
      },
    };
  }

  private async webSession(
    projectId: string,
    q: WebSessionQueryInput,
    now: Date,
  ): Promise<QueryResult> {
    const source = await this.webPageViewSource(projectId, q.metric);
    const keyMetric = q.key_metric
      ? await this.webKeyMetricSource(projectId, q.key_metric)
      : undefined;
    this.assertWebFilterAllowlist(q.filters);
    const routeVocabulary = await assertTrustedSafeRoute(this.pool, projectId);
    await assertTrustedAcquisitionProperties(
      this.pool,
      projectId,
      q.filters.map((filter) => filter.property),
    );
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    this.assertWebDateRange(from, to);
    const result = await this.eventStore.webSession({
      projectId,
      env: q.env,
      event: source.event,
      filters: [
        ...source.filters,
        { property: '$route_key', op: 'in', value: [...routeVocabulary] },
        ...q.filters,
      ],
      from,
      to,
      sessionId: q.session_id,
      ...(q.actor_id ? { actorId: q.actor_id } : {}),
      pageLimit: q.page_limit,
      ...(keyMetric ? { keyMetric } : {}),
    });
    if (result.ambiguous_actor) {
      throw badRequest(
        'web_session_actor_ambiguous',
        `session_id "${q.session_id}" belongs to more than one resolved actor in this scope`,
        'list sessions first and repeat with the exact actor_id',
      );
    }
    return {
      kind: 'web_session',
      summary: result.summary,
      pages: result.pages,
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
        total_pages: result.total,
        truncated: result.total > result.pages.length,
        ...(result.summary ? {} : {
          no_data_reason: 'No canonical session matched this project, environment, actor and period.',
        }),
        privacy: 'Returns bounded safe route keys and aggregate timing only; never URL, DOM, text, IP, user agent or replay.',
      },
    };
  }

  private async pageEngagement(
    projectId: string,
    q: PageEngagementQueryInput,
    now: Date,
  ): Promise<QueryResult> {
    const source = await this.webPageViewSource(projectId, q.metric);
    this.assertWebFilterAllowlist(q.filters);
    const routeVocabulary = await assertTrustedSafeRoute(this.pool, projectId);
    await assertTrustedAcquisitionProperties(
      this.pool,
      projectId,
      q.filters.map((filter) => filter.property),
    );
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    this.assertWebDateRange(from, to);
    const result = await this.eventStore.pageEngagement({
      projectId,
      env: q.env,
      event: source.event,
      filters: [
        ...source.filters,
        { property: '$route_key', op: 'in', value: [...routeVocabulary] },
        ...q.filters,
      ],
      from,
      to,
      pageViewId: q.page_view_id,
      ...(q.actor_id ? { actorId: q.actor_id } : {}),
      ...(q.session_id ? { sessionId: q.session_id } : {}),
    });
    if (result.ambiguous_actor) {
      throw badRequest(
        'page_engagement_actor_ambiguous',
        `page_view_id "${q.page_view_id}" belongs to more than one actor/session identity in this scope`,
        'list sessions first and repeat with the exact actor_id and session_id',
      );
    }
    return {
      kind: 'page_engagement',
      page: result.page,
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
        ...(result.page ? {} : {
          no_data_reason: 'No canonical page view matched this project, environment, actor and period.',
        }),
      },
    };
  }

  private async webPageViewSource(
    projectId: string,
    metricKey: string,
  ): Promise<{ event: string; filters: PropertyFilter[] }> {
    const metric = await getMetric(this.pool, projectId, metricKey);
    if (metric.status !== 'active') {
      throw badRequest(
        'web_analytics_metric_inactive',
        `metric "${metricKey}" must be active`,
        'activate the reviewed canonical metric or select an active replacement',
      );
    }
    const source = metric.source as {
      event?: string;
      filters?: PropertyFilter[];
      data_source?: 'native' | 'posthog';
    };
    const filters = source.filters ?? [];
    const canonical = filters.length === 1
      && filters[0]?.property === '$browser_context'
      && filters[0]?.op === 'eq'
      && filters[0]?.value === '1';
    if (metric.type !== 'count'
      || source.event !== 'page.viewed'
      || (source.data_source ?? 'native') !== 'native'
      || !canonical) {
      throw badRequest(
        'web_analytics_metric_invalid',
        `metric "${metricKey}" must be the active canonical native page.viewed count`,
        'use web_page_views from atomic browser analytics setup',
      );
    }
    return { event: source.event, filters };
  }

  private async webKeyMetricSource(
    projectId: string,
    metricKey: string,
  ): Promise<{ event: string; filters: PropertyFilter[] }> {
    const metric = await getMetric(this.pool, projectId, metricKey);
    if (metric.status !== 'active') {
      throw badRequest(
        'web_analytics_key_metric_inactive',
        `key metric "${metricKey}" must be active`,
        'activate the reviewed native event metric or omit key_metric',
      );
    }
    const source = await this.eventSource(projectId, metricKey);
    if (source.dataSource !== 'native') {
      throw badRequest(
        'web_analytics_key_metric_invalid',
        `key metric "${metricKey}" must use native stored events`,
      );
    }
    return { event: source.event, filters: source.filters };
  }

  private assertWebFilterAllowlist(filters: PropertyFilter[]): void {
    const unsupported = filters.find((filter) => !WEB_FILTER_PROPERTIES.has(filter.property));
    if (unsupported) {
      throw badRequest(
        'web_analytics_filter_forbidden',
        `property "${unsupported.property}" is not an approved Web analytics filter`,
        'use a typed safe route, acquisition or coarse browser dimension',
      );
    }
  }

  private assertWebDateRange(from: Date, to: Date): void {
    const duration = to.getTime() - from.getTime();
    if (duration <= 0) {
      throw badRequest('web_analytics_range_invalid', 'date_to must be later than date_from');
    }
    if (duration > 366 * 24 * 60 * 60_000) {
      throw badRequest(
        'web_analytics_range_too_large',
        'Web analytics queries are bounded to at most 366 days',
        'split the analysis into smaller typed windows',
      );
    }
  }

  /** Resolve a registry metric to an event-based source, or fail with a teaching hint. */
  private async eventSource(
    projectId: string,
    key: string,
  ): Promise<{
    event: string;
    filters: PropertyFilter[];
    dataSource: 'native' | 'posthog';
    connectionId?: string;
    metricKey: string;
  }> {
    const metric = await getMetric(this.pool, projectId, key);
    if (metric.type === 'conversion' || metric.type === 'state') {
      throw badRequest(
        'metric_not_event_based',
        `metric "${key}" has type=${metric.type}; retention/lifecycle/stickiness need an event-based metric`,
        'use a count / unique_actors / value metric',
      );
    }
    const source = metric.source as {
      event: string;
      filters?: PropertyFilter[];
      data_source?: 'native' | 'posthog';
      source_connection_id?: string;
    };
    return {
      event: source.event,
      filters: source.filters ?? [],
      dataSource: source.data_source ?? 'native',
      ...(source.source_connection_id ? { connectionId: source.source_connection_id } : {}),
      metricKey: metric.key,
    };
  }

  private async trend(projectId: string, q: TrendQueryInput, now: Date): Promise<QueryResult> {
    const queryProperties = [...q.filters.map((filter) => filter.property), ...(q.breakdown ? [q.breakdown.property] : [])];
    await assertRegisteredAcquisitionProperties(
      this.pool,
      projectId,
      queryProperties,
    );
    const attributionNote = queryProperties.some((property) => property.startsWith('$utm_'))
      ? SESSION_ATTRIBUTION_NOTE
      : undefined;
    const metric = await getMetric(this.pool, projectId, q.metric);
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    const meta = (extra?: Partial<QueryMeta>): QueryMeta => ({
      computed_at: now.toISOString(),
      date_range: { from: from.toISOString(), to: to.toISOString() },
      sampling: null,
      ...extra,
    });

    if (metric.type === 'conversion') {
      throw badRequest(
        'metric_not_trendable',
        `metric "${metric.key}" has type=conversion`,
        'query it as a funnel: define metrics for its from/to events and use kind=funnel with inline steps',
      );
    }

    if (metric.type === 'state') {
      const source = metric.source as { entity_type: string; filters?: PropertyFilter[] };
      const count = await countEntities(
        this.pool, projectId, q.env, source.entity_type, source.filters ?? [],
      );
      return {
        kind: 'trend',
        series: [{ bucket: now.toISOString(), value: count }],
        meta: meta({ source: 'native', note: 'state metrics are snapshots of current entity state, not time series' }),
      };
    }

    const source = metric.source as {
      event: string;
      filters?: PropertyFilter[];
      value_property?: string;
      agg?: 'sum' | 'avg' | 'min' | 'max' | 'p90';
      data_source?: 'native' | 'posthog';
      source_connection_id?: string;
    };
    if (source.data_source === 'posthog') {
      if (!source.source_connection_id || !this.posthog) {
        throw badRequest(
          'posthog_source_unavailable',
          'this metric references a PostHog source that is not available',
          'configure the source connection and server encryption key',
        );
      }
      const series = await this.posthog.trend({
        projectId,
        connectionId: source.source_connection_id,
        metricKey: metric.key,
        event: source.event,
        filters: [...(source.filters ?? []), ...q.filters],
        agg: metric.type === 'unique_actors'
          ? 'unique_actors'
          : metric.type === 'count'
            ? 'count'
            : 'value',
        from,
        to,
        interval: q.interval,
        ...(q.breakdown ? { breakdownProperty: q.breakdown.property } : {}),
      });
      return { kind: 'trend', series, meta: meta({ source: 'posthog', ...(attributionNote ? { note: attributionNote } : {}) }) };
    }
    const agg =
      metric.type === 'count'
        ? ({ kind: 'count' } as const)
        : metric.type === 'unique_actors'
          ? ({ kind: 'unique_actors' } as const)
          : ({ kind: 'value', property: source.value_property!, fn: source.agg ?? 'sum' } as const);

    const series = await this.eventStore.trend({
      projectId,
      env: q.env,
      event: source.event,
      filters: [...(source.filters ?? []), ...q.filters],
      agg,
      from,
      to,
      interval: q.interval,
      ...(q.breakdown ? { breakdownProperty: q.breakdown.property } : {}),
    });
    return { kind: 'trend', series, meta: meta({ source: 'native', ...(attributionNote ? { note: attributionNote } : {}) }) };
  }

  private async funnel(projectId: string, q: FunnelQueryInput, now: Date): Promise<QueryResult> {
    if (Boolean(q.funnel) === Boolean(q.steps)) {
      throw badRequest(
        'invalid_funnel_query',
        'pass either a saved funnel key or inline steps, not both and not neither',
        'use {funnel: "<key>"} for a saved funnel, or {steps: [{metric: "..."}, ...]} for ad-hoc',
      );
    }
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;

    let stepDefs: Array<{ label: string; metric: Metric }>;
    let windowSeconds: number;

    if (q.funnel) {
      const funnel = await getFunnel(this.pool, projectId, q.funnel);
      windowSeconds = funnel.window_seconds;
      stepDefs = await Promise.all(
        funnel.steps.map(async (s) => ({
          label: s.label,
          metric: await getMetric(this.pool, projectId, s.metric_key),
        })),
      );
    } else {
      windowSeconds = 604800;
      stepDefs = await Promise.all(
        q.steps!.map(async (s) => {
          const metric = await getMetric(this.pool, projectId, s.metric);
          return { label: metric.name, metric };
        }),
      );
    }

    for (const { metric } of stepDefs) {
      if (metric.type === 'conversion' || metric.type === 'state') {
        throw badRequest(
          'invalid_step_metric',
          `funnel step "${metric.key}" has type=${metric.type}; steps must be event-based`,
        );
      }
    }

    const sources = stepDefs.map(({ metric }) => {
      const source = metric.source as {
        event: string;
        filters?: PropertyFilter[];
        data_source?: 'native' | 'posthog';
        source_connection_id?: string;
      };
      return {
        event: source.event,
        filters: source.filters ?? [],
        dataSource: source.data_source ?? 'native',
        connectionId: source.source_connection_id,
      };
    });
    const sourceKinds = new Set(sources.map((source) => source.dataSource));
    if (sourceKinds.size > 1) {
      throw badRequest(
        'mixed_funnel_sources',
        'a funnel cannot mix native and PostHog event stores',
        'map every step to the same source before comparing actors',
      );
    }
    let counts: number[];
    let resultSource: 'native' | 'posthog' = 'native';
    if (sources[0]?.dataSource === 'posthog') {
      const connectionIds = new Set(sources.map((source) => source.connectionId));
      const connectionId = sources[0].connectionId;
      if (!this.posthog || !connectionId || connectionIds.size !== 1) {
        throw badRequest(
          'posthog_source_unavailable',
          'all PostHog funnel metrics must use one available connection',
        );
      }
      counts = await this.posthog.funnel({
        projectId,
        connectionId,
        metricKeys: stepDefs.map(({ metric }) => metric.key),
        steps: sources.map(({ event, filters }) => ({ event, filters })),
        windowSeconds,
        from,
        to,
      });
      resultSource = 'posthog';
    } else {
      counts = await this.eventStore.funnel({
        projectId,
        env: q.env,
        windowSeconds,
        from,
        to,
        steps: sources.map(({ event, filters }) => ({ event, filters })),
      });
    }

    const first = counts[0] ?? 0;
    return {
      kind: 'funnel',
      steps: counts.map((actors, i) => ({
        label: stepDefs[i]!.label,
        metric_key: stepDefs[i]!.metric.key,
        purpose: stepDefs[i]!.metric.purpose,
        category: stepDefs[i]!.metric.category,
        actors,
        conversion_from_prev: i === 0 ? 1 : ratio(actors, counts[i - 1]!),
        conversion_from_start: i === 0 ? 1 : ratio(actors, first),
      })),
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: resultSource,
      },
    };
  }

  private async entities(projectId: string, q: EntitiesQueryInput, now: Date): Promise<QueryResult> {
    const entities = await queryEntities(this.pool, projectId, q);
    return {
      kind: 'entities',
      entities,
      meta: { computed_at: now.toISOString(), sampling: null, source: 'native' },
    };
  }

  private async retention(projectId: string, q: RetentionQueryInput, now: Date): Promise<QueryResult> {
    // The two metric lookups are independent — resolve them together.
    const [start, ret] = await Promise.all([
      this.eventSource(projectId, q.start_metric),
      q.return_metric ? this.eventSource(projectId, q.return_metric) : Promise.resolve(null),
    ]);
    const returnSource = ret ?? start;
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;

    if (start.dataSource !== returnSource.dataSource) {
      throw badRequest(
        'mixed_retention_sources',
        'retention start and return metrics must use the same event store',
      );
    }
    let cohorts: RetentionCohort[];
    let resultSource: 'native' | 'posthog' = 'native';
    if (start.dataSource === 'posthog') {
      if (!this.posthog || !start.connectionId || start.connectionId !== returnSource.connectionId) {
        throw badRequest(
          'posthog_source_unavailable',
          'PostHog retention metrics must use one available connection',
        );
      }
      cohorts = await this.posthog.retention({
        projectId,
        connectionId: start.connectionId,
        startMetricKey: start.metricKey,
        returnMetricKey: returnSource.metricKey,
        start: { event: start.event, filters: start.filters },
        returning: { event: returnSource.event, filters: returnSource.filters },
        interval: q.interval,
        periods: q.periods,
        from,
        to,
      });
      resultSource = 'posthog';
    } else {
      cohorts = await this.eventStore.retention({
        projectId, env: q.env,
        startEvent: start.event, startFilters: start.filters,
        returnEvent: returnSource.event, returnFilters: returnSource.filters,
        interval: q.interval, periods: q.periods, from, to,
      });
    }

    const censored = cohorts.some((c) => c.mature_periods < q.periods);
    const baseNote = q.return_metric && q.return_metric !== q.start_metric
      ? `returning actors are measured by "${q.return_metric}"`
      : 'classic retention (start metric is also the return action)';
    return {
      kind: 'retention',
      interval: q.interval,
      cohorts: cohorts.map((c) => ({
        ...c,
        retained_pct: c.retained.map((n) => (c.size === 0 ? 0 : Number((n / c.size).toFixed(4)))),
      })),
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: resultSource,
        note: censored
          ? `${baseNote}. Recent cohorts are right-censored: only the first \`mature_periods\` of each are fully observed — later periods read 0 because that time hasn't elapsed yet, not because actors churned.`
          : baseNote,
      },
    };
  }

  private async lifecycle(projectId: string, q: LifecycleQueryInput, now: Date): Promise<QueryResult> {
    const src = await this.eventSource(projectId, q.metric);
    if (src.dataSource === 'posthog') {
      throw badRequest(
        'posthog_capability_unsupported',
        'the P0 PostHog adapter does not support lifecycle queries',
        'use trend, funnel or basic retention',
      );
    }
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    const series = await this.eventStore.lifecycle({
      projectId, env: q.env, event: src.event, filters: src.filters, interval: q.interval, from, to,
    });
    return {
      kind: 'lifecycle',
      interval: q.interval,
      series,
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
        note: 'actors first seen inside the window count as "new" (no pre-window lookback)',
      },
    };
  }

  private async stickiness(projectId: string, q: StickinessQueryInput, now: Date): Promise<QueryResult> {
    const src = await this.eventSource(projectId, q.metric);
    if (src.dataSource === 'posthog') {
      throw badRequest(
        'posthog_capability_unsupported',
        'the P0 PostHog adapter does not support stickiness queries',
        'use trend, funnel or basic retention',
      );
    }
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    const bins = await this.eventStore.stickiness({
      projectId, env: q.env, event: src.event, filters: src.filters, interval: q.interval, from, to,
    });
    return {
      kind: 'stickiness',
      interval: q.interval,
      bins,
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
      },
    };
  }

  private async interactionMap(projectId: string, q: InteractionMapQueryInput, now: Date): Promise<QueryResult> {
    const [surface] = await Promise.all([getExperienceSurface(this.pool, projectId, q.surface)]);
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    const result = await this.eventStore.interactionMap({
      projectId, env: q.env, surface: q.surface, from, to, grid: q.grid,
    });
    return {
      kind: 'interaction_map',
      surface: { key: surface.key, name: surface.name, purpose: surface.purpose, status: surface.status },
      grid: q.grid,
      ...result,
      meta: { computed_at: now.toISOString(), date_range: { from: from.toISOString(), to: to.toISOString() }, sampling: null, source: 'native' },
    };
  }

  private async experienceSession(projectId: string, q: ExperienceSessionQueryInput, now: Date): Promise<QueryResult> {
    const surface = await getExperienceSurface(this.pool, projectId, q.surface);
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    const events = await this.eventStore.experienceSession({
      projectId, env: q.env, surface: q.surface, sessionId: q.session_id, from, to, limit: q.limit,
    });
    return {
      kind: 'experience_session',
      surface: { key: surface.key, name: surface.name, purpose: surface.purpose, status: surface.status },
      session_id: q.session_id,
      events,
      summary: {
        page_views: events.filter((event) => event.kind === 'page_viewed').length,
        clicks: events.filter((event) => event.kind === 'element_clicked').length,
        max_scroll_depth: events.reduce((max, event) => event.kind === 'scroll_depth' ? Math.max(max, event.depth ?? 0) : max, 0),
        client_errors: events.filter((event) => event.kind === 'client_error').length,
      },
      meta: { computed_at: now.toISOString(), date_range: { from: from.toISOString(), to: to.toISOString() }, sampling: null, source: 'native' },
    };
  }

  private async visualExperience(
    projectId: string,
    q: VisualExperienceQueryInput,
    now: Date,
  ): Promise<Extract<QueryResult, { kind: 'visual_experience' }>> {
    const surface = await getExperienceSurface(this.pool, projectId, q.surface);
    const from = parseDateInput(q.date_from, now);
    const to = q.date_to ? parseDateInput(q.date_to, now) : now;
    const snapshot = await getExactExperienceSnapshot(
      this.pool,
      projectId,
      {
        surface: q.surface,
        route: q.route,
        env: q.env,
        version: q.version,
        device: q.device,
      },
      now,
    );
    const result = await this.eventStore.visualExperience({
      projectId,
      env: q.env,
      surface: q.surface,
      route: q.route,
      version: q.version,
      device: q.device,
      ...(snapshot
        ? {
            viewportWidth: snapshot.viewport_width,
            viewportHeight: snapshot.viewport_height,
            documentWidth: snapshot.document_width,
            documentHeight: snapshot.document_height,
          }
        : {}),
      from,
      to,
      grid: q.grid,
    });
    const agentContext = buildVisualAgentContext(surface, q, result, snapshot, from, to, now);
    return {
      kind: 'visual_experience',
      surface: { key: surface.key, name: surface.name, purpose: surface.purpose, status: surface.status },
      route: q.route,
      version: q.version,
      device: q.device,
      grid: q.grid,
      snapshot,
      ...result,
      agent_context: agentContext,
      causality: 'Aggregated interaction evidence shows where observed sessions clicked or reached; it does not prove why users stopped or that a page change caused a difference.',
      meta: {
        computed_at: now.toISOString(),
        date_range: { from: from.toISOString(), to: to.toISOString() },
        sampling: null,
        source: 'native',
        note: snapshot
          ? 'Events match the snapshot viewport exactly. Accepted events may still exclude signals discarded by client consent and rate guards.'
          : 'No immutable snapshot matches these route, version, device and env filters; events are not restricted to one viewport.',
      },
    };
  }

  private async visualExperienceCompare(
    projectId: string,
    q: VisualExperienceCompareInput,
    now: Date,
  ): Promise<Extract<QueryResult, { kind: 'visual_experience_compare' }>> {
    const [baseline, comparison] = await Promise.all([
      this.visualExperience(projectId, {
        kind: 'visual_experience',
        surface: q.surface,
        route: q.route,
        version: q.baseline.version,
        device: q.baseline.device,
        date_from: q.baseline.date_from,
        date_to: q.baseline.date_to,
        grid: q.grid,
        env: q.env,
      }, now),
      this.visualExperience(projectId, {
        kind: 'visual_experience',
        surface: q.surface,
        route: q.route,
        version: q.comparison.version,
        device: q.comparison.device,
        date_from: q.comparison.date_from,
        date_to: q.comparison.date_to,
        grid: q.grid,
        env: q.env,
      }, now),
    ]);
    const baselineSections = new Map(baseline.sections.map((item) => [item.section, item.percentage]));
    const comparisonSections = new Map(comparison.sections.map((item) => [item.section, item.percentage]));
    const sectionKeys = [...new Set([...baselineSections.keys(), ...comparisonSections.keys()])].sort();
    const sectionDeltas = sectionKeys.map((section) => {
      const baselinePresent = baselineSections.has(section);
      const comparisonPresent = comparisonSections.has(section);
      return {
        section,
        baseline_present: baselinePresent,
        comparison_present: comparisonPresent,
        percentage_points: baselinePresent && comparisonPresent
          ? Number((comparisonSections.get(section)! - baselineSections.get(section)!).toFixed(2))
          : null,
      };
    });
    return {
      kind: 'visual_experience_compare',
      baseline,
      comparison,
      delta: {
        events: comparison.summary.events - baseline.summary.events,
        page_views: comparison.summary.page_views - baseline.summary.page_views,
        sessions: comparison.summary.sessions - baseline.summary.sessions,
        clicks: comparison.summary.clicks - baseline.summary.clicks,
        actors: comparison.summary.actors - baseline.summary.actors,
        sections: sectionDeltas,
      },
      agent_context: buildVisualCompareAgentContext(q, baseline, comparison, sectionDeltas),
      causality: 'This is a descriptive comparison across selected cohorts. Traffic mix, instrumentation, seasonality and concurrent changes can explain differences.',
      meta: { computed_at: now.toISOString(), sampling: null, source: 'native' },
    };
  }
}

function buildVisualAgentContext(
  surface: { key: string; purpose: string },
  q: VisualExperienceQueryInput,
  result: Awaited<ReturnType<EventStore['visualExperience']>>,
  snapshot: Awaited<ReturnType<typeof getExactExperienceSnapshot>>,
  from: Date,
  to: Date,
  now: Date,
): VisualAgentContext {
  const sectionReachDecreases = result.sections.slice(1).map((section, index) => {
    const previous = result.sections[index]!;
    return {
      from_section: previous.section,
      to_section: section.section,
      from_sessions: previous.sessions,
      to_sessions: section.sessions,
      session_count_decrease: previous.sessions - section.sessions,
      percentage_point_decrease: Number((previous.percentage - section.percentage).toFixed(2)),
    };
  }).filter((item) => item.percentage_point_decrease > 0 || item.session_count_decrease > 0)
    .sort((a, b) =>
    b.percentage_point_decrease - a.percentage_point_decrease
    || b.session_count_decrease - a.session_count_decrease
    || a.from_section.localeCompare(b.from_section)
    || a.to_section.localeCompare(b.to_section)
  ).slice(0, 5);
  const labelledClicks = result.click_labels.reduce((sum, item) => sum + item.count, 0);
  const caveats = [
    'Accepted event totals can exclude signals withheld by client consent or discarded by rate guards.',
    'This evidence is descriptive and non-causal; verify instrumentation and cohort differences before acting.',
  ];
  let quality: VisualAgentContext['data_quality']['status'] = 'ok';
  const capturedAt = snapshot ? new Date(snapshot.captured_at).toISOString() : null;
  const expiresAt = snapshot ? new Date(snapshot.expires_at).toISOString() : null;
  const snapshotAgeSeconds = capturedAt === null
    ? null
    : Math.floor((now.getTime() - new Date(capturedAt).getTime()) / 1000);
  const snapshotStatus: VisualAgentContext['snapshot_coverage']['status'] = !snapshot
    ? 'missing'
    : snapshotAgeSeconds !== null && snapshotAgeSeconds < 0
      ? 'future'
      : snapshot.stale
        ? 'stale'
        : 'fresh';
  if (!snapshot) {
    quality = 'limited';
    caveats.push('No exact snapshot matched, so events are not restricted to one viewport and document size.');
  } else if (snapshotStatus === 'future') {
    quality = 'limited';
    caveats.push('The matching snapshot captured_at is in the future; verify capture clock skew before using its coordinates.');
  } else if (snapshotStatus === 'stale') {
    quality = 'limited';
    caveats.push('The matching snapshot is stale; confirm the route still renders this version before interpreting coordinates.');
  }
  if (result.summary.sessions === 0) {
    quality = 'empty';
    caveats.push('No eligible page-view sessions matched this exact scope and period.');
  } else {
    if (result.sections.length === 0) {
      quality = 'limited';
      caveats.push('No stable section exposure labels were observed, so section reach and drop-off are unavailable.');
    }
    if (result.sections_truncated) {
      quality = 'limited';
      caveats.push('Section output reached the 200-label bound; section order and drop-off omit additional labels.');
    }
    if (result.click_labels_truncated) {
      quality = 'limited';
      caveats.push('Click-label output reached the top-100 bound; remaining safe labels are omitted from concentration output.');
    } else if (labelledClicks < result.summary.clicks) {
      quality = 'limited';
      caveats.push(`${result.summary.clicks - labelledClicks} click(s) lacked a safe stable label and are excluded from label concentration.`);
    }
  }
  const evidenceRefs: VisualEvidenceRef[] = snapshot ? [{
    type: 'experience_snapshot',
    id: snapshot.id,
    evidence_ref: snapshot.evidence_ref,
  }] : [];
  return {
    scope: {
      surface: surface.key,
      route: q.route,
      version: q.version,
      device: q.device,
      purpose: surface.purpose,
    },
    sample_size: {
      events: result.summary.events,
      page_views: result.summary.page_views,
      sessions: result.summary.sessions,
      actors: result.summary.actors,
      clicks: result.summary.clicks,
    },
    section_order: result.sections.map((section) => section.section),
    largest_section_reach_decreases: sectionReachDecreases,
    click_concentration: result.click_labels.map((item) => ({
      ...item,
      percentage_of_all_clicks: percentage(item.count, result.summary.clicks),
    })),
    scroll_reach: result.scroll_coverage,
    output_coverage: {
      click_labels_returned: result.click_labels.length,
      click_labels_truncated: result.click_labels_truncated,
      sections_returned: result.sections.length,
      sections_truncated: result.sections_truncated,
    },
    snapshot_coverage: {
      status: snapshotStatus,
      exact_viewport_match: snapshot !== null,
      snapshot_id: snapshot?.id ?? null,
      evidence_ref: snapshot?.evidence_ref ?? null,
      captured_at: capturedAt,
      expires_at: expiresAt,
      age_seconds: snapshotAgeSeconds,
    },
    evidence_refs: evidenceRefs,
    data_quality: { status: quality, caveats },
    suggested_next_actions: [
      {
        action: 'list_versions',
        tool: 'list_visual_experience_versions',
        reason: 'Discover explicit snapshot-backed versions and devices before choosing a comparison cohort.',
        known_parameters: { surface: q.surface, route: q.route, env: q.env },
        requires: [],
      },
      {
        action: 'compare_explicit_cohorts',
        tool: 'compare_visual_experience',
        reason: 'Compare this bounded cohort only after selecting another explicit version, device or period; do not infer causation.',
        known_parameters: {
          surface: q.surface,
          route: q.route,
          env: q.env,
          baseline: {
            version: q.version,
            device: q.device,
            date_from: from.toISOString(),
            date_to: to.toISOString(),
          },
        },
        requires: ['comparison.version', 'comparison.device', 'comparison.date_from'],
      },
    ],
  };
}

function buildVisualCompareAgentContext(
  q: VisualExperienceCompareInput,
  baseline: Extract<QueryResult, { kind: 'visual_experience' }>,
  comparison: Extract<QueryResult, { kind: 'visual_experience' }>,
  sectionDeltas: Array<{
    section: string;
    baseline_present: boolean;
    comparison_present: boolean;
    percentage_points: number | null;
  }>,
): VisualCompareAgentContext {
  const baselineSections = new Map(baseline.sections.map((item) => [item.section, item.percentage]));
  const comparisonSections = new Map(comparison.sections.map((item) => [item.section, item.percentage]));
  const evidenceRefs = [...baseline.agent_context.evidence_refs, ...comparison.agent_context.evidence_refs]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.evidence_ref === item.evidence_ref) === index);
  const taxonomyMismatches = sectionDeltas.filter((item) =>
    !item.baseline_present || !item.comparison_present
  ).map(({ section, baseline_present, comparison_present }) => ({
    section,
    baseline_present,
    comparison_present,
  }));
  const caveats = [
    ...baseline.agent_context.data_quality.caveats.map((item) => `Baseline: ${item}`),
    ...comparison.agent_context.data_quality.caveats.map((item) => `Comparison: ${item}`),
    'Deltas are descriptive and non-causal; traffic mix, instrumentation, seasonality and concurrent changes may differ.',
    ...(taxonomyMismatches.length > 0
      ? ['Section labels differ between cohorts; unmatched labels are reported as taxonomy mismatches, not behavioral deltas.']
      : []),
  ];
  const statuses = [baseline.agent_context.data_quality.status, comparison.agent_context.data_quality.status];
  const quality = statuses.includes('empty')
    ? 'empty'
    : statuses.includes('limited') || taxonomyMismatches.length > 0
      ? 'limited'
      : 'ok';
  return {
    scope: {
      surface: baseline.surface.key,
      route: q.route,
      purpose: baseline.surface.purpose,
    },
    sample_sizes: {
      baseline: baseline.agent_context.sample_size,
      comparison: comparison.agent_context.sample_size,
    },
    largest_section_changes: sectionDeltas.filter((item) => item.percentage_points !== null).map((item) => ({
      section: item.section,
      baseline_percentage: baselineSections.get(item.section)!,
      comparison_percentage: comparisonSections.get(item.section)!,
      percentage_points: item.percentage_points!,
    })).sort((a, b) =>
      Math.abs(b.percentage_points) - Math.abs(a.percentage_points)
      || a.section.localeCompare(b.section)
    ).slice(0, 5),
    section_taxonomy_mismatches: taxonomyMismatches,
    evidence_refs: evidenceRefs,
    data_quality: { status: quality, caveats: [...new Set(caveats)] },
    suggested_next_actions: [
      {
        action: 'inspect_baseline_map',
        tool: 'get_visual_experience_map',
        reason: 'Inspect the bounded baseline counts, percentages, reach and evidence before interpreting a delta.',
        query: {
          surface: q.surface,
          route: q.route,
          version: q.baseline.version,
          device: q.baseline.device,
          date_from: baseline.meta.date_range!.from,
          date_to: baseline.meta.date_range!.to,
          grid: q.grid,
          env: q.env,
        },
      },
      {
        action: 'inspect_comparison_map',
        tool: 'get_visual_experience_map',
        reason: 'Inspect the bounded comparison counts, percentages, reach and evidence before interpreting a delta.',
        query: {
          surface: q.surface,
          route: q.route,
          version: q.comparison.version,
          device: q.comparison.device,
          date_from: comparison.meta.date_range!.from,
          date_to: comparison.meta.date_range!.to,
          grid: q.grid,
          env: q.env,
        },
      },
    ],
  };
}

function percentage(num: number, denom: number): number {
  return denom === 0 ? 0 : Number((num * 100 / denom).toFixed(2));
}

function ratio(num: number, denom: number): number {
  return denom === 0 ? 0 : Number((num / denom).toFixed(4));
}
