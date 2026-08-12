import type { StoredProjectIntent } from './projectIntents.js';
import type { Funnel, Metric } from './registry.js';

export type HomeAnswerSurface = 'website' | 'product' | 'legacy';

export interface HomeAnswerSelection {
  surface: HomeAnswerSurface;
  metric: Metric | null;
  pageMetric: Metric | null;
  revenueMetric: Metric | null;
  funnel: Funnel | null;
  requiredMetricKeys: string[];
}

const WEBSITE_GOALS = new Set([
  'website_traffic',
  'website_pages',
  'website_conversion',
  'campaigns_referrals',
  'content_engagement',
]);

/**
 * The one server-owned resolver for the Home answer and its funnel snapshot.
 * Inputs are registry definitions plus explicit project intent; observed data
 * never changes which semantic definition Home selects.
 */
export function resolveHomeAnswer(
  metrics: Metric[],
  funnels: Funnel[],
  intent: StoredProjectIntent | null,
): HomeAnswerSelection {
  const activeMetrics = [...metrics]
    .filter((metric) => metric.status === 'active')
    .sort((left, right) => left.key.localeCompare(right.key));
  const queryableMetrics = activeMetrics.filter(isDirectlyQueryableMetric);
  const pageMetric = activeMetrics.find((metric) => metric.key === 'web_page_views' && metric.type === 'count') ?? null;
  const surface = resolveSurface(intent);
  const metric = surface === 'website'
    ? pageMetric
    : selectProductMetric(queryableMetrics, intent?.primary_goal_id ?? null);
  const revenueMetric = queryableMetrics.find((candidate) => candidate.category === 'revenue') ?? null;
  const anchorMetric = surface === 'website' ? pageMetric : metric;

  return {
    surface,
    metric,
    pageMetric,
    revenueMetric,
    funnel: selectFunnel(funnels, intent?.primary_goal_id ?? null, anchorMetric?.key ?? null),
    requiredMetricKeys: surface === 'website' ? ['web_page_views'] : [],
  };
}

function isDirectlyQueryableMetric(metric: Metric): boolean {
  return metric.type === 'count' || metric.type === 'unique_actors' || metric.type === 'value';
}

function resolveSurface(intent: StoredProjectIntent | null): HomeAnswerSurface {
  if (!intent) return 'legacy';
  if (intent.project_mode === 'website') return 'website';
  if (intent.project_mode === 'product') return 'product';
  return WEBSITE_GOALS.has(intent.primary_goal_id) ? 'website' : 'product';
}

function selectProductMetric(metrics: Metric[], primaryGoal: string | null): Metric | null {
  if (!primaryGoal) return metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
  const tokens = primaryGoal.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
  return metrics.find((metric) => {
    const haystack = `${metric.key} ${metric.name} ${metric.purpose} ${metric.category ?? ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  }) ?? metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
}

function selectFunnel(funnels: Funnel[], primaryGoal: string | null, anchorMetricKey: string | null): Funnel | null {
  const ordered = [...funnels].sort((left, right) => left.key.localeCompare(right.key));
  if (primaryGoal) {
    const exact = ordered.find((funnel) => funnel.key === primaryGoal);
    if (exact) return exact;
    const tokens = primaryGoal.split('_').filter((token) => token.length > 3);
    const ranked = ordered
      .map((funnel) => {
        const haystack = [
          funnel.key,
          funnel.name,
          funnel.goal,
          ...funnel.steps.flatMap((step) => [step.metric_key, step.label]),
        ].join(' ').toLowerCase();
        return { funnel, score: tokens.filter((token) => haystack.includes(token)).length };
      })
      .sort((left, right) => right.score - left.score || left.funnel.key.localeCompare(right.funnel.key));
    if (ranked[0]?.score) return ranked[0].funnel;
  }
  if (anchorMetricKey) {
    const anchored = ordered.find((funnel) => funnel.steps.some((step) => step.metric_key === anchorMetricKey));
    if (anchored) return anchored;
  }
  return ordered[0] ?? null;
}
