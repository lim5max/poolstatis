import { describe, expect, it } from 'vitest';
import { ANALYSIS_TEMPLATES, CORE_ANALYZE_CAPABILITIES } from '../analysis/templates';
import {
  buildProductQuery,
  safeQueryError,
  comparisonControl,
  scenarioPickerOptions,
  visualizationTitle,
} from '../analysis/product';
import { selectServerFunnelLoss } from './ProductAnalytics';

describe('Product analytics query and copy mapping', () => {
  it('builds registry-backed branches without raw event input', () => {
    const query = buildProductQuery({
      template: ANALYSIS_TEMPLATES[0]!,
      metricView: 'trend',
      selectedKey: 'signup',
      env: 'prod',
      interval: 'day',
      breakdown: 'none',
      dates: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-30T00:00:00.000Z',
      },
    });

    expect(query).toMatchObject({ kind: 'trend', metric: 'signup', env: 'prod' });
    expect(JSON.stringify(query)).not.toMatch(/raw[_ ]?event|sql/i);
  });

  it('does not repeat a template title when the selected definition has the same name', () => {
    expect(visualizationTitle('Activation funnel', 'Activation funnel')).toBe('Activation funnel');
    expect(visualizationTitle('Product health', 'Signups')).toBe('Product health · Signups');
  });

  it('maps query failures to compact safe next actions', () => {
    const message = safeQueryError(new Error('request failed: bearer sk_secret'));
    expect(message).toBe('Query unavailable. Retry, change the range, or inspect the definition.');
    expect(message).not.toContain('sk_secret');
  });

  it('models templates as one compact option set with unavailable scenarios disabled', () => {
    const options = scenarioPickerOptions(ANALYSIS_TEMPLATES, CORE_ANALYZE_CAPABILITIES);
    expect(options).toHaveLength(8);
    expect(options.filter((option) => !option.disabled)).toHaveLength(4);
    expect(options.filter((option) => option.disabled)).toHaveLength(4);
    expect(options.find((option) => option.key === 'web-overview')).toMatchObject({
      disabled: true,
      reason: 'Requires web analytics',
    });
  });

  it('exposes previous-period comparison honestly when the typed DSL cannot execute it', () => {
    expect(comparisonControl()).toEqual({
      label: 'Previous exact period',
      disabled: true,
      reason: 'Runs an adjacent window with identical duration when a safe headline aggregation exists',
    });
  });

  it('uses the server-selected loss instead of recomputing a different transition in the browser', () => {
    const meta = {
      computed_at: '2026-08-08T00:00:00.000Z',
      date_range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' },
      sampling: null,
      source: 'native' as const,
    };
    const step = (label: string, metric_key: string, actors: number) => ({
      label, metric_key, actors, purpose: `${label} is measured for the signup goal.`, category: 'activation',
      conversion_from_prev: null, conversion_from_start: null,
    });
    const result = {
      kind: 'funnel' as const,
      steps: [step('Visited', 'visited', 100), step('Started', 'started', 60), step('Completed', 'completed', 15)],
      summary: {
        overall_conversion: 0.15,
        previous_overall_conversion: 0.4,
        delta_percentage_points: -25,
        biggest_absolute_loss: { from_step: 1, to_step: 2, lost_actors: 45, drop_rate: 0.75 },
        biggest_percentage_loss: { from_step: 0, to_step: 1, lost_actors: 40, drop_rate: 0.4 },
      },
      meta,
    };
    const summary = selectServerFunnelLoss(result, { fromStep: 0, toStep: 1 });

    expect(summary).toMatchObject({
      kind: 'percentage', fromLabel: 'Visited', toLabel: 'Started', lostActors: 40,
      dropRate: 0.4, overallConversion: 0.15, previousOverallConversion: 0.4,
      deltaPercentagePoints: -25,
    });
  });

  it('fails closed when the deep-linked transition is not present in the server summary', () => {
    const meta = {
      computed_at: '2026-08-08T00:00:00.000Z',
      date_range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' },
      sampling: null,
      source: 'native' as const,
    };
    const result = {
      kind: 'funnel' as const,
      steps: [
        { label: 'Visited', metric_key: 'visited', actors: 100, purpose: 'Measures visits.', category: 'acquisition', conversion_from_prev: 1, conversion_from_start: 1 },
        { label: 'Started', metric_key: 'started', actors: 60, purpose: 'Measures signup starts.', category: 'activation', conversion_from_prev: 0.6, conversion_from_start: 0.6 },
        { label: 'Completed', metric_key: 'completed', actors: 30, purpose: 'Measures signup completion.', category: 'activation', conversion_from_prev: 0.5, conversion_from_start: 0.3 },
      ],
      summary: {
        overall_conversion: 0.3,
        previous_overall_conversion: null,
        delta_percentage_points: null,
        biggest_absolute_loss: { from_step: 0, to_step: 1, lost_actors: 40, drop_rate: 0.4 },
        biggest_percentage_loss: { from_step: 1, to_step: 2, lost_actors: 30, drop_rate: 0.5 },
      },
      meta,
    };

    expect(selectServerFunnelLoss(result, { fromStep: 0, toStep: 2 })).toBeNull();
  });

});
