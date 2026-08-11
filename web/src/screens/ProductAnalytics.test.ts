import { describe, expect, it } from 'vitest';
import { ANALYSIS_TEMPLATES, CORE_ANALYZE_CAPABILITIES } from '../analysis/templates';
import {
  buildProductQuery,
  safeQueryError,
  comparisonControl,
  scenarioPickerOptions,
  visualizationTitle,
} from '../analysis/product';

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
});
