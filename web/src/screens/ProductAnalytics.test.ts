import { describe, expect, it } from 'vitest';
import { ANALYSIS_TEMPLATES, CORE_ANALYZE_CAPABILITIES } from '../analysis/templates';
import {
  buildProductQuery,
  safeQueryError,
  comparisonControl,
  scenarioPickerOptions,
  visualizationTitle,
} from '../analysis/product';
import { biggestFunnelLoss, previousPeriodQuery } from './ProductAnalytics';

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

  it('finds the largest actor loss and compares the same step with the adjacent period', () => {
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
    const summary = biggestFunnelLoss(
      { kind: 'funnel', steps: [step('Visited', 'visited', 100), step('Started', 'started', 60), step('Completed', 'completed', 15)], meta },
      { kind: 'funnel', steps: [step('Visited', 'visited', 80), step('Started', 'started', 64), step('Completed', 'completed', 32)], meta },
    );

    expect(summary).toMatchObject({
      fromLabel: 'Started', toLabel: 'Completed', lostActors: 45,
      dropRate: 0.75, previousLostActors: 32, previousDropRate: 0.5,
      dropRateDelta: 0.25, overallConversion: 0.15, previousOverallConversion: 0.4,
    });
  });

  it('builds an exact adjacent previous-period funnel query', () => {
    expect(previousPeriodQuery({
      kind: 'funnel', funnel: 'signup', env: 'prod',
      date_from: '2026-08-01T00:00:00.000Z', date_to: '2026-08-08T00:00:00.000Z',
    })).toMatchObject({
      date_from: '2026-07-24T23:59:59.999Z',
      date_to: '2026-07-31T23:59:59.999Z',
    });
  });
});
