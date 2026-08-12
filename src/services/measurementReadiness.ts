import type pg from 'pg';
import type { PropertyFilter } from '../schemas.js';
import type { EventStore } from '../stores/eventStore.js';
import {
  analysisViewMetricKeys, analysisViewPropertyKeys, listAnalysisViews, type AnalysisView,
} from './analysisViews.js';
import { ACQUISITION_UTM_PROPERTIES } from './acquisitionAttribution.js';
import { BROWSER_ANALYTICS_PROPERTIES } from './browserAnalytics.js';
import { getProjectIntent, type StoredProjectIntent } from './projectIntents.js';
import { listPropertyDefinitions } from './properties.js';
import { listSourceConnections } from './posthog.js';
import { listFunnels, listMetrics, type Funnel, type Metric } from './registry.js';

export type ReadinessSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'none';
export type ReadinessGroupKey = 'tracking_plan' | 'properties' | 'identity' | 'data_sources';

export interface ReadinessRepairAction {
  action_code: 'activate_metric' | 'repair_funnel' | 'review_property' | 'verify_identity' | 'connect_data_source' | 'verify_data_source';
  kind: 'navigate';
  label: string;
  href: string;
}

export interface MeasurementReadinessGap {
  code:
    | 'metric_inactive'
    | 'funnel_definition_incomplete'
    | 'property_untrusted'
    | 'identity_evidence_unavailable'
    | 'identity_coverage_incomplete'
    | 'data_source_missing'
    | 'data_source_unverified';
  severity: Exclude<ReadinessSeverity, 'none'>;
  definition_ref: string | null;
  affected_answer_ids: string[];
  repair_action: ReadinessRepairAction;
}

export interface MeasurementReadinessGroup {
  key: ReadinessGroupKey;
  label: string;
  healthy_count: number;
  incomplete_count: number;
  highest_severity: ReadinessSeverity;
  gaps: MeasurementReadinessGap[];
  repair_action: ReadinessRepairAction | null;
  evidence: Record<string, number>;
}

export interface MeasurementReadinessResult {
  schema_version: 1;
  generated_at: string;
  project: string;
  env: string;
  summary: {
    healthy_count: number;
    incomplete_count: number;
    highest_severity: ReadinessSeverity;
  };
  answer_dependencies: MeasurementAnswerDependency[];
  groups: MeasurementReadinessGroup[];
  fix_next: (ReadinessRepairAction & {
    group: ReadinessGroupKey;
    gap_code: MeasurementReadinessGap['code'];
    severity: Exclude<ReadinessSeverity, 'none'>;
    affected_answer_ids: string[];
  }) | null;
}

export interface MeasurementAnswerDependency {
  answer_id: string;
  surface: 'home' | 'web' | 'product' | 'funnel' | 'saved';
  label: string;
  href: string;
  metric_keys: string[];
  property_keys: string[];
  funnel_key: string | null;
}

interface ProjectScope { id: string; slug: string }

const GROUP_ORDER: ReadinessGroupKey[] = ['tracking_plan', 'properties', 'identity', 'data_sources'];
const SEVERITY_RANK: Record<ReadinessSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
  none: 0,
};
const GAP_CODE_ORDER: Record<MeasurementReadinessGap['code'], number> = {
  data_source_missing: 0,
  metric_inactive: 1,
  funnel_definition_incomplete: 2,
  property_untrusted: 3,
  identity_coverage_incomplete: 4,
  data_source_unverified: 5,
  identity_evidence_unavailable: 6,
};

export async function getMeasurementReadiness(
  pool: pg.Pool,
  eventStore: EventStore,
  project: ProjectScope,
  env: string,
): Promise<MeasurementReadinessResult> {
  const [metrics, funnels, properties, sources, views, intent, nativeSources, identityCounts] = await Promise.all([
    listMetrics(pool, project.id),
    listFunnels(pool, project.id),
    listPropertyDefinitions(pool, project.id),
    listSourceConnections(pool, project.id),
    listAnalysisViews(pool, project, { env, status: 'active' }),
    getProjectIntent(pool, project.id),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM api_keys
       WHERE project_id = $1 AND kind = 'ingest' AND env = $2 AND revoked_at IS NULL`,
      [project.id, env],
    ),
    pool.query<{ active_links: number; audit_entries: number }>(
      `SELECT
         (SELECT count(*)::int FROM actor_links
          WHERE project_id = $1 AND env = $2 AND status = 'active') AS active_links,
         (SELECT count(*)::int FROM actor_link_audit
          WHERE project_id = $1 AND env = $2) AS audit_entries`,
      [project.id, env],
    ),
  ]);

  const answerDependencies = buildAnswerDependencies(metrics, funnels, views, intent);
  const affected = dependencyIndexes(answerDependencies);
  const tracking = trackingPlanGroup(metrics, funnels, affected.metrics);
  const propertyGroup = propertiesGroup(properties, affected.properties);
  const identity = await identityGroup(
    project.id,
    env,
    metrics,
    affected.metrics,
    eventStore,
    identityCounts.rows[0] ?? { active_links: 0, audit_entries: 0 },
  );
  const dataSources = dataSourcesGroup(
    env,
    Number(nativeSources.rows[0]?.count ?? 0),
    sources.map((source) => source.status),
    answerDependencies.map((answer) => answer.answer_id),
  );
  const groups = [tracking, propertyGroup, identity, dataSources];
  const ranked = groups.flatMap((group) => group.gaps.map((gap) => ({ group: group.key, gap })))
    .sort(compareRankedGaps);
  const first = ranked[0];
  const highestSeverity = groups.reduce<ReadinessSeverity>(
    (highest, group) => SEVERITY_RANK[group.highest_severity] > SEVERITY_RANK[highest]
      ? group.highest_severity
      : highest,
    'none',
  );

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    project: project.slug,
    env,
    summary: {
      healthy_count: groups.reduce((sum, group) => sum + group.healthy_count, 0),
      incomplete_count: groups.reduce((sum, group) => sum + group.incomplete_count, 0),
      highest_severity: highestSeverity,
    },
    answer_dependencies: answerDependencies,
    groups,
    fix_next: first ? {
      group: first.group,
      gap_code: first.gap.code,
      severity: first.gap.severity,
      affected_answer_ids: first.gap.affected_answer_ids,
      ...first.gap.repair_action,
    } : null,
  };
}

function trackingPlanGroup(
  metrics: Metric[],
  funnels: Funnel[],
  affected: Map<string, string[]>,
): MeasurementReadinessGroup {
  const activeMetrics = new Set(metrics.filter((metric) => metric.status === 'active').map((metric) => metric.key));
  const gaps: MeasurementReadinessGap[] = metrics
    .filter((metric) => metric.status !== 'active')
    .map((metric) => ({
      code: 'metric_inactive',
      severity: 'high',
      definition_ref: metric.key,
      affected_answer_ids: affected.get(metric.key) ?? [],
      repair_action: {
        action_code: 'activate_metric',
        kind: 'navigate',
        label: 'Review and activate metric',
        href: `/registry?metric=${encodeURIComponent(metric.key)}`,
      },
    }));
  let healthyFunnels = 0;
  for (const funnel of funnels) {
    const missing = funnel.steps.filter((step) => !activeMetrics.has(step.metric_key));
    if (missing.length === 0) {
      healthyFunnels += 1;
      continue;
    }
    const answerIds = uniqueSorted(missing.flatMap((step) => affected.get(step.metric_key) ?? []));
    gaps.push({
      code: 'funnel_definition_incomplete',
      severity: 'high',
      definition_ref: funnel.key,
      affected_answer_ids: answerIds,
      repair_action: {
        action_code: 'repair_funnel',
        kind: 'navigate',
        label: 'Repair funnel definitions',
        href: `/registry?funnel=${encodeURIComponent(funnel.key)}`,
      },
    });
  }
  return group(
    'tracking_plan',
    'Tracking plan',
    metrics.filter((metric) => metric.status === 'active').length + healthyFunnels,
    metrics.filter((metric) => metric.status !== 'active').length + (funnels.length - healthyFunnels),
    gaps,
    { metrics: metrics.length, funnels: funnels.length },
  );
}

function propertiesGroup(
  properties: Array<{ key: string; scope: string; status: string }>,
  affected: Map<string, string[]>,
): MeasurementReadinessGroup {
  const eventProperties = properties.filter((property) => property.scope === 'event');
  const gaps: MeasurementReadinessGap[] = eventProperties
    .filter((property) => property.status !== 'trusted')
    .map((property) => ({
      code: 'property_untrusted',
      severity: property.status === 'untrusted' ? 'high' : 'medium',
      definition_ref: property.key,
      affected_answer_ids: affected.get(property.key) ?? [],
      repair_action: {
        action_code: 'review_property',
        kind: 'navigate',
        label: 'Review property meaning',
        href: `/measurement?property=${encodeURIComponent(property.key)}`,
      },
    }));
  const known = new Set(eventProperties.map((property) => property.key));
  for (const [key, answerIds] of affected) {
    if (known.has(key)) continue;
    gaps.push({
      code: 'property_untrusted',
      severity: 'high',
      definition_ref: key,
      affected_answer_ids: answerIds,
      repair_action: {
        action_code: 'review_property',
        kind: 'navigate',
        label: 'Register property meaning',
        href: `/measurement?property=${encodeURIComponent(key)}`,
      },
    });
  }
  return group(
    'properties',
    'Properties',
    eventProperties.filter((property) => property.status === 'trusted').length,
    gaps.length,
    gaps,
    { event_properties: eventProperties.length },
  );
}

async function identityGroup(
  projectId: string,
  env: string,
  metrics: Metric[],
  affected: Map<string, string[]>,
  eventStore: EventStore,
  identityCounts: { active_links: number; audit_entries: number },
): Promise<MeasurementReadinessGroup> {
  const dependencies = metrics.filter((metric) =>
    metric.status === 'active'
    && (metric.type === 'unique_actors' || metric.type === 'conversion'));
  const gaps: MeasurementReadinessGap[] = [];
  let healthy = 0;
  for (const metric of dependencies) {
    const sources = identityEventSources(metric);
    if (sources === null) {
      gaps.push(identityGap(metric.key, 'identity_evidence_unavailable', 'low', affected.get(metric.key) ?? []));
      continue;
    }
    if (sources.length === 0) {
      healthy += 1;
      continue;
    }
    const coverage = await Promise.all(sources.map((source) => eventStore.measurementCoverage({
      projectId,
      env,
      event: source.event,
      filters: source.filters,
      properties: [],
      sinceDays: 30,
    })));
    const observed = coverage.reduce((sum, item) => sum + item.events, 0);
    if (observed === 0) {
      gaps.push(identityGap(metric.key, 'identity_evidence_unavailable', 'low', affected.get(metric.key) ?? []));
    } else if (coverage.some((item) => item.distinctIdCoverage < 1)) {
      gaps.push(identityGap(metric.key, 'identity_coverage_incomplete', 'high', affected.get(metric.key) ?? []));
    } else {
      healthy += 1;
    }
  }
  return group(
    'identity',
    'Identity',
    healthy,
    gaps.length,
    gaps,
    {
      assessed_answer_metrics: dependencies.length,
      active_links: Number(identityCounts.active_links),
      audit_entries: Number(identityCounts.audit_entries),
    },
  );
}

function identityGap(
  key: string,
  code: 'identity_evidence_unavailable' | 'identity_coverage_incomplete',
  severity: 'low' | 'high',
  answerIds: string[],
): MeasurementReadinessGap {
  return {
    code,
    severity,
    definition_ref: key,
    affected_answer_ids: answerIds,
    repair_action: {
      action_code: 'verify_identity',
      kind: 'navigate',
      label: 'Verify identity evidence',
      href: '/measurement?group=identity',
    },
  };
}

function dataSourcesGroup(
  env: string,
  nativeCount: number,
  externalStatuses: string[],
  answerIds: string[],
): MeasurementReadinessGroup {
  const verified = externalStatuses.filter((status) => status === 'verified').length;
  const unverified = externalStatuses.length - verified;
  const gaps: MeasurementReadinessGap[] = [];
  if (nativeCount + verified === 0) {
    gaps.push({
      code: 'data_source_missing',
      severity: 'critical',
      definition_ref: null,
      affected_answer_ids: uniqueSorted(answerIds),
      repair_action: {
        action_code: 'connect_data_source',
        kind: 'navigate',
        label: 'Connect a data source',
        href: `/setup?env=${encodeURIComponent(env)}`,
      },
    });
  }
  if (unverified > 0) {
    gaps.push({
      code: 'data_source_unverified',
      severity: nativeCount + verified === 0 ? 'high' : 'medium',
      definition_ref: null,
      affected_answer_ids: uniqueSorted(answerIds),
      repair_action: {
        action_code: 'verify_data_source',
        kind: 'navigate',
        label: 'Verify configured data source',
        href: '/measurement?group=data_sources',
      },
    });
  }
  return group(
    'data_sources',
    'Data sources',
    nativeCount + verified,
    Math.max(unverified, nativeCount + verified === 0 ? 1 : 0),
    gaps,
    { native_ingest_keys: nativeCount, verified_external_sources: verified, unverified_external_sources: unverified },
  );
}

function identityEventSources(metric: Metric): Array<{ event: string; filters: PropertyFilter[] }> | null {
  if (metric.type === 'state') return [];
  const source = metric.source as Record<string, unknown>;
  if (metric.type === 'conversion') {
    const endpoints = [source.from, source.to] as Array<Record<string, unknown> | undefined>;
    if (endpoints.some((endpoint) => endpoint?.data_source === 'posthog')) return null;
    return endpoints.flatMap((endpoint) => typeof endpoint?.event === 'string'
      ? [{ event: endpoint.event, filters: Array.isArray(endpoint.filters) ? endpoint.filters as PropertyFilter[] : [] }]
      : []);
  }
  if (source.data_source === 'posthog') return null;
  return typeof source.event === 'string'
    ? [{ event: source.event, filters: Array.isArray(source.filters) ? source.filters as PropertyFilter[] : [] }]
    : [];
}

export function buildAnswerDependencies(
  metrics: Metric[],
  funnels: Funnel[],
  views: AnalysisView[],
  intent: StoredProjectIntent | null,
): MeasurementAnswerDependency[] {
  const activeMetrics = metrics.filter((metric) => metric.status === 'active');
  const metricByKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const activePageMetric = activeMetrics.find((metric) => metric.key === 'web_page_views' && metric.type === 'count') ?? null;
  const primaryMetric = pickPrimaryMetric(activeMetrics, intent?.primary_goal_id ?? null);
  const revenueMetric = activeMetrics.find((metric) => metric.category === 'revenue') ?? null;
  const webOutcomeMetrics = activeMetrics.filter((metric) => metric.key !== 'web_page_views'
    && metric.type !== 'state'
    && metric.tags.includes('surface:web'));
  const funnelAnchor = intent?.project_mode === 'website'
    || (intent?.project_mode === 'both' && prefersWebsite(intent.primary_goal_id))
    ? activePageMetric
    : primaryMetric;
  const homeFunnel = pickHomeFunnel(funnels, intent?.primary_goal_id ?? null, funnelAnchor?.key ?? null);
  const homeMetrics = new Set<string>();
  const homeMode = intent?.project_mode ?? null;
  if (homeMode === 'website') {
    if (activePageMetric) homeMetrics.add(activePageMetric.key);
  } else if (homeMode === 'product') {
    if (primaryMetric) homeMetrics.add(primaryMetric.key);
    if (revenueMetric) homeMetrics.add(revenueMetric.key);
  } else if (homeMode === 'both' && intent) {
    const preferred = prefersWebsite(intent.primary_goal_id) ? activePageMetric : primaryMetric;
    if (preferred) homeMetrics.add(preferred.key);
    if (!prefersWebsite(intent.primary_goal_id) && revenueMetric) homeMetrics.add(revenueMetric.key);
  } else {
    // Legacy Home chooses the first successful current answer at runtime. Both
    // candidates are real active semantics, so the dependency graph keeps the
    // fail-closed superset without inferring a project mode from old data.
    if (activePageMetric) homeMetrics.add(activePageMetric.key);
    if (primaryMetric) homeMetrics.add(primaryMetric.key);
    if (revenueMetric) homeMetrics.add(revenueMetric.key);
  }
  homeFunnel?.steps.forEach((step) => homeMetrics.add(step.metric_key));

  const answers: MeasurementAnswerDependency[] = [answerDependency({
    answerId: 'home',
    surface: 'home',
    label: 'Home current answer',
    href: '/',
    metricKeys: [...homeMetrics],
    funnelKey: homeFunnel?.key ?? null,
    metricByKey,
  })];

  const webConfigured = metricByKey.has('web_page_views')
    || webOutcomeMetrics.length > 0
    || intent?.project_mode === 'website'
    || intent?.project_mode === 'both';
  if (webConfigured) {
    const webMetricKeys = new Set<string>(['web_page_views']);
    webOutcomeMetrics.forEach((metric) => webMetricKeys.add(metric.key));
    answers.push(answerDependency({
      answerId: 'web',
      surface: 'web',
      label: 'Web health answer',
      href: '/analyze/web',
      metricKeys: [...webMetricKeys],
      explicitPropertyKeys: [
        ...Object.keys(BROWSER_ANALYTICS_PROPERTIES),
        ...ACQUISITION_UTM_PROPERTIES,
      ],
      funnelKey: null,
      metricByKey,
    }));
  }

  for (const metric of activeMetrics.filter((candidate) => candidate.type !== 'conversion' && candidate.type !== 'state')) {
    answers.push(answerDependency({
      answerId: `product:${metric.key}`,
      surface: 'product',
      label: `Product · ${metric.name}`,
      href: '/analyze/product',
      metricKeys: [metric.key],
      funnelKey: null,
      metricByKey,
    }));
  }
  for (const funnel of funnels) {
    answers.push(answerDependency({
      answerId: `funnel:${funnel.key}`,
      surface: 'funnel',
      label: `Funnel · ${funnel.name}`,
      href: `/analyze/funnels?funnel=${encodeURIComponent(funnel.key)}`,
      metricKeys: funnel.steps.map((step) => step.metric_key),
      funnelKey: funnel.key,
      metricByKey,
    }));
  }
  for (const view of views) {
    const metricKeys = new Set(analysisViewMetricKeys(view));
    const source = view.visualization_spec.source;
    const funnelKeys = new Set<string>();
    if (source.kind === 'funnel') funnelKeys.add(source.key);
    for (const action of view.visualization_spec.actions) {
      if (action.kind === 'open_funnel') funnelKeys.add(action.key);
      if (action.kind === 'open_query' && action.query.kind === 'funnel' && action.query.funnel) {
        funnelKeys.add(action.query.funnel);
      }
    }
    for (const funnelKey of funnelKeys) {
      funnels.find((funnel) => funnel.key === funnelKey)?.steps.forEach((step) => metricKeys.add(step.metric_key));
    }
    answers.push(answerDependency({
      answerId: view.id,
      surface: 'saved',
      label: view.title,
      href: `/analyze/saved?answer=${encodeURIComponent(view.id)}`,
      metricKeys: [...metricKeys],
      explicitPropertyKeys: analysisViewPropertyKeys(view),
      funnelKey: [...funnelKeys].sort()[0] ?? null,
      metricByKey,
    }));
  }
  const surfaceOrder: Record<MeasurementAnswerDependency['surface'], number> = {
    home: 0, web: 1, product: 2, funnel: 3, saved: 4,
  };
  return answers.sort((left, right) => surfaceOrder[left.surface] - surfaceOrder[right.surface]
    || left.answer_id.localeCompare(right.answer_id));
}

function dependencyIndexes(answers: MeasurementAnswerDependency[]): {
  metrics: Map<string, string[]>;
  properties: Map<string, string[]>;
} {
  const metricAnswers = new Map<string, Set<string>>();
  const propertyAnswers = new Map<string, Set<string>>();
  for (const answer of answers) {
    for (const key of answer.metric_keys) addDependency(metricAnswers, key, answer.answer_id);
    for (const key of answer.property_keys) addDependency(propertyAnswers, key, answer.answer_id);
  }
  return {
    metrics: mapSets(metricAnswers),
    properties: mapSets(propertyAnswers),
  };
}

function answerDependency(input: {
  answerId: string;
  surface: MeasurementAnswerDependency['surface'];
  label: string;
  href: string;
  metricKeys: string[];
  explicitPropertyKeys?: string[];
  funnelKey: string | null;
  metricByKey: Map<string, Metric>;
}): MeasurementAnswerDependency {
  const metricKeys = uniqueSorted(input.metricKeys);
  const properties = new Set(input.explicitPropertyKeys ?? []);
  metricKeys.forEach((key) => {
    const metric = input.metricByKey.get(key);
    if (metric) metricPropertyKeys(metric).forEach((property) => properties.add(property));
  });
  return {
    answer_id: input.answerId,
    surface: input.surface,
    label: input.label,
    href: input.href,
    metric_keys: metricKeys,
    property_keys: [...properties].sort(),
    funnel_key: input.funnelKey,
  };
}

function metricPropertyKeys(metric: Metric): string[] {
  const properties = new Set<string>();
  const addSource = (source: Record<string, unknown> | undefined) => {
    if (!source) return;
    if (typeof source.value_property === 'string') properties.add(source.value_property);
    if (Array.isArray(source.filters)) {
      source.filters.forEach((filter) => {
        const property = (filter as { property?: unknown }).property;
        if (typeof property === 'string') properties.add(property);
      });
    }
  };
  if (metric.type === 'conversion') {
    addSource(metric.source.from as Record<string, unknown> | undefined);
    addSource(metric.source.to as Record<string, unknown> | undefined);
  } else {
    addSource(metric.source);
  }
  return [...properties].sort();
}

function pickPrimaryMetric(metrics: Metric[], primaryGoal: string | null): Metric | null {
  if (!primaryGoal) return metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
  const tokens = primaryGoal.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
  return metrics.find((metric) => {
    const haystack = `${metric.key} ${metric.name} ${metric.purpose} ${metric.category ?? ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  }) ?? metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
}

function pickHomeFunnel(funnels: Funnel[], primaryGoal: string | null, anchorMetricKey: string | null): Funnel | null {
  const ordered = [...funnels].sort((left, right) => left.key.localeCompare(right.key));
  if (primaryGoal) {
    const exactGoalFunnel = ordered.find((funnel) => funnel.key === primaryGoal);
    if (exactGoalFunnel) return exactGoalFunnel;
  }
  if (anchorMetricKey) {
    const anchoredFunnel = ordered.find((funnel) => funnel.steps.some((step) => step.metric_key === anchorMetricKey));
    if (anchoredFunnel) return anchoredFunnel;
  }
  return ordered[0] ?? null;
}

function prefersWebsite(primaryGoal: string): boolean {
  return /(website|traffic|page|campaign|referral|content|conversion)/i.test(primaryGoal);
}

function addDependency(map: Map<string, Set<string>>, key: string, answerId: string): void {
  const answerIds = map.get(key) ?? new Set<string>();
  answerIds.add(answerId);
  map.set(key, answerIds);
}

function mapSets(map: Map<string, Set<string>>): Map<string, string[]> {
  return new Map([...map].map(([key, values]) => [key, [...values].sort()]));
}

function group(
  key: ReadinessGroupKey,
  label: string,
  healthyCount: number,
  incompleteCount: number,
  gaps: MeasurementReadinessGap[],
  evidence: Record<string, number>,
): MeasurementReadinessGroup {
  const ranked = [...gaps].sort(compareGaps);
  return {
    key,
    label,
    healthy_count: healthyCount,
    incomplete_count: incompleteCount,
    highest_severity: ranked[0]?.severity ?? 'none',
    gaps: ranked,
    repair_action: ranked[0]?.repair_action ?? null,
    evidence,
  };
}

function compareGaps(left: MeasurementReadinessGap, right: MeasurementReadinessGap): number {
  return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    || right.affected_answer_ids.length - left.affected_answer_ids.length
    || GAP_CODE_ORDER[left.code] - GAP_CODE_ORDER[right.code]
    || (left.definition_ref ?? '').localeCompare(right.definition_ref ?? '');
}

function compareRankedGaps(
  left: { group: ReadinessGroupKey; gap: MeasurementReadinessGap },
  right: { group: ReadinessGroupKey; gap: MeasurementReadinessGap },
): number {
  return compareGaps(left.gap, right.gap)
    || GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
