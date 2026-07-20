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
} from '../schemas.js';
import { parseDateInput } from '../dates.js';
import { badRequest } from '../errors.js';
import { getFunnel, getMetric, type Metric } from './registry.js';
import { countEntities, queryEntities } from './entities.js';
import { getExperienceSurface } from './experience.js';
import { canonicalQueryKey, type QueryCache } from './queryCache.js';
import type { PostHogAdapter } from './posthog.js';

export interface QueryMeta {
  computed_at: string;
  date_range?: { from: string; to: string };
  sampling: null;
  note?: string;
  source?: 'native' | 'posthog';
}

export type QueryResult =
  | { kind: 'trend'; series: Array<{ bucket: string; value: number; breakdown_value?: string }>; meta: QueryMeta }
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
        timestamp: string; kind: 'page_viewed' | 'element_clicked' | 'scroll_depth' | 'client_error';
        route: string; sequence: number; label?: string; x?: number; y?: number; depth?: number;
        error_type?: 'error' | 'unhandled_rejection';
      }>;
      summary: { page_views: number; clicks: number; max_scroll_depth: number; client_errors: number };
      meta: QueryMeta;
    };

export class QueryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventStore: EventStore,
    private readonly cache?: QueryCache,
    private readonly posthog?: PostHogAdapter,
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
      return { kind: 'trend', series, meta: meta({ source: 'posthog' }) };
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
    return { kind: 'trend', series, meta: meta({ source: 'native' }) };
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
}

function ratio(num: number, denom: number): number {
  return denom === 0 ? 0 : Number((num / denom).toFixed(4));
}
