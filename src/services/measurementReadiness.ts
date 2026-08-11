import type pg from 'pg';
import type { PropertyFilter } from '../schemas.js';
import type { EventStore } from '../stores/eventStore.js';
import {
  analysisViewMetricKeys, analysisViewPropertyKeys, listAnalysisViews, type AnalysisView,
} from './analysisViews.js';
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
  groups: MeasurementReadinessGroup[];
  fix_next: (ReadinessRepairAction & {
    group: ReadinessGroupKey;
    gap_code: MeasurementReadinessGap['code'];
    severity: Exclude<ReadinessSeverity, 'none'>;
    affected_answer_ids: string[];
  }) | null;
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

export async function getMeasurementReadiness(
  pool: pg.Pool,
  eventStore: EventStore,
  project: ProjectScope,
  env: string,
): Promise<MeasurementReadinessResult> {
  const [metrics, funnels, properties, sources, views, nativeSources, identityCounts] = await Promise.all([
    listMetrics(pool, project.id),
    listFunnels(pool, project.id),
    listPropertyDefinitions(pool, project.id),
    listSourceConnections(pool, project.id),
    listAnalysisViews(pool, project, { env, status: 'active' }),
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

  const affected = answerDependencies(views, funnels);
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
    views.map((view) => view.id),
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

function answerDependencies(views: AnalysisView[], funnels: Funnel[]): {
  metrics: Map<string, string[]>;
  properties: Map<string, string[]>;
} {
  const metricAnswers = new Map<string, Set<string>>();
  const propertyAnswers = new Map<string, Set<string>>();
  const funnelByKey = new Map(funnels.map((funnel) => [funnel.key, funnel]));
  for (const view of views) {
    const metricKeys = new Set(analysisViewMetricKeys(view));
    const source = view.visualization_spec.source;
    if (source.kind === 'funnel') {
      funnelByKey.get(source.key)?.steps.forEach((step) => metricKeys.add(step.metric_key));
    }
    for (const action of view.visualization_spec.actions) {
      const funnelKey = action.kind === 'open_funnel'
        ? action.key
        : action.kind === 'open_query' && action.query.kind === 'funnel'
          ? action.query.funnel
          : undefined;
      if (funnelKey) funnelByKey.get(funnelKey)?.steps.forEach((step) => metricKeys.add(step.metric_key));
    }
    for (const key of metricKeys) addDependency(metricAnswers, key, view.id);
    for (const key of analysisViewPropertyKeys(view)) addDependency(propertyAnswers, key, view.id);
  }
  return {
    metrics: mapSets(metricAnswers),
    properties: mapSets(propertyAnswers),
  };
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
    || left.code.localeCompare(right.code)
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
