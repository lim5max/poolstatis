export function analysisViewInput(
  project: string,
  env = 'prod',
  metric = 'activation_completed',
  property?: string,
) {
  const from = '2026-08-01T00:00:00.000Z';
  const to = '2026-08-08T00:00:00.000Z';
  const query = {
    kind: 'trend' as const,
    metric,
    date_from: from,
    date_to: to,
    interval: 'day' as const,
    filters: property ? [{ property, op: 'eq' as const, value: 'pro' }] : [],
    env,
  };
  return {
    title: 'Activation completion',
    description: 'A saved activation answer with reproducible evidence.',
    template_key: 'product_health',
    schema_version: 1 as const,
    visualization_spec: {
      schemaVersion: 1 as const,
      id: 'activation-completion-trend',
      kind: 'trend' as const,
      title: 'Activation completion',
      question: 'How often do people complete activation?',
      purpose: 'Shows whether people reach the first meaningful product outcome.',
      project,
      env,
      range: { from, to, timezone: 'UTC' as const },
      source: { kind: 'metric' as const, key: metric, query },
      trust: {
        status: 'trusted' as const,
        reason: 'The active registry metric has complete observed coverage.',
        blockers: [],
      },
      evidence: {
        aggregation: 'count',
        denominator: null,
        sampleSize: 42,
        coverage: '100%',
        source: 'native' as const,
        computedAt: to,
        comparisonBasis: 'previous_period',
      },
      display: {
        valueFormat: 'number' as const,
        granularity: 'day' as const,
        compare: 'previous_period' as const,
        series: [{ key: 'value', label: 'Completed activation', colorToken: '--chart-1' }],
      },
      actions: [
        { kind: 'open_metric' as const, key: metric },
        { kind: 'open_query' as const, query },
        { kind: 'save_view' as const },
      ],
    },
    answer: {
      state: 'ready' as const,
      headline: 'Activation completions are measurable',
      takeaway: '42 activation completions were observed in the selected window.',
      primary_value: { value: 42, unit: 'count' as const, formatted: '42' },
      delta: {
        value: 5,
        unit: 'count' as const,
        direction: 'up' as const,
        comparison_label: 'vs previous period',
      },
      why_it_matters: 'Activation is the first protected product outcome.',
    },
    evidence: {
      state: 'trusted' as const,
      as_of: to,
      freshness: 'fresh' as const,
      source_refs: [{
        kind: 'metric' as const,
        key: metric,
        purpose: 'Shows whether people reach the first meaningful product outcome.',
      }],
      aggregation: 'count',
      denominator: { label: 'Eligible actors', value: 50 },
      sample: { eligible: 50, observed: 42, coverage: 0.84 },
      warnings: [],
      unavailable_reasons: [],
      reproducible_query: query,
    },
  };
}
