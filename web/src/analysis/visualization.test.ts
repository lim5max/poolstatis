import { describe, expect, it } from 'vitest';
import {
  resolveRenderState,
  validateVisualizationSpec,
  type VisualizationSpec,
} from './visualization';

const validSpec: VisualizationSpec = {
  schemaVersion: 1,
  id: 'trend:activated_users:prod',
  kind: 'trend',
  title: 'Activated users',
  question: 'Are more users reaching activation?',
  purpose: 'Tracks whether users reach the first meaningful product outcome.',
  project: 'demo',
  env: 'prod',
  range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-30T00:00:00.000Z', timezone: 'UTC' },
  source: {
    kind: 'metric',
    key: 'activated_users',
    query: {
      kind: 'trend',
      metric: 'activated_users',
      date_from: '2026-07-01T00:00:00.000Z',
      date_to: '2026-07-30T00:00:00.000Z',
      interval: 'day',
      filters: [],
      env: 'prod',
    },
  },
  trust: { status: 'trusted', reason: 'No blockers in the selected window.', blockers: [] },
  evidence: {
    aggregation: 'unique actors per day',
    denominator: null,
    sampleSize: 42,
    coverage: 'complete',
    source: 'native',
    computedAt: '2026-07-30T10:00:00.000Z',
    comparisonBasis: 'Current exact period only; previous-period comparison is unavailable.',
  },
  display: {
    valueFormat: 'number',
    granularity: 'day',
    compare: 'none',
    series: [{ key: 'value', label: 'Activated users', colorToken: '--chart-1' }],
  },
  actions: [{ kind: 'open_query', query: {
    kind: 'trend',
    metric: 'activated_users',
    date_from: '2026-07-01T00:00:00.000Z',
    date_to: '2026-07-30T00:00:00.000Z',
    interval: 'day',
    filters: [],
    env: 'prod',
  } }],
};

describe('VisualizationSpec contract', () => {
  it('accepts a complete, registry-backed and reproducible spec', () => {
    expect(validateVisualizationSpec(validSpec)).toEqual({ valid: true, errors: [] });
  });

  it('rejects unversioned and non-registry query sources', () => {
    const invalid = {
      ...validSpec,
      schemaVersion: 2,
      source: { kind: 'metric', key: 'activated_users', query: { kind: 'sql', sql: 'select 1' } },
    };
    const result = validateVisualizationSpec(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/schemaVersion|query/i);
  });

  it('rejects unknown sources and actions fail-closed', () => {
    const invalid = {
      ...validSpec,
      source: { kind: 'raw_event', key: 'signup' },
      actions: [{ kind: 'run_sql', sql: 'select 1' }],
    };
    const result = validateVisualizationSpec(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/source|action/i);
  });

  it('rejects incomplete query branches and contradictory scope contracts', () => {
    const incomplete = {
      ...validSpec,
      source: {
        kind: 'metric',
        key: 'activated_users',
        query: {
          kind: 'trend',
          metric: 'activated_users',
          date_from: validSpec.range.from,
          date_to: validSpec.range.to,
          env: 'prod',
        },
      },
    };
    expect(validateVisualizationSpec(incomplete).errors.join(' ')).toMatch(/query/i);

    const mismatched = {
      ...validSpec,
      source: {
        ...validSpec.source,
        key: 'other_metric',
        query: { ...('query' in validSpec.source ? validSpec.source.query : {}), env: 'staging' },
      },
    };
    expect(validateVisualizationSpec(mismatched).errors.join(' ')).toMatch(/scope|source key/i);
  });

  it('mirrors registry key and property-value constraints from the backend DSL', () => {
    const booleanFilter = {
      ...validSpec,
      source: {
        ...validSpec.source,
        query: {
          ...('query' in validSpec.source ? validSpec.source.query : {}),
          filters: [{ property: 'is_paid', op: 'eq', value: true }],
        },
      },
      actions: [{
        kind: 'open_query',
        query: {
          ...('query' in validSpec.source ? validSpec.source.query : {}),
          filters: [{ property: 'is_paid', op: 'eq', value: true }],
        },
      }],
    };
    expect(validateVisualizationSpec(booleanFilter)).toEqual({ valid: true, errors: [] });

    const invalidKey = {
      ...validSpec,
      source: {
        ...validSpec.source,
        key: 'signup event',
        query: {
          ...('query' in validSpec.source ? validSpec.source.query : {}),
          metric: 'signup event',
        },
      },
      actions: [{
        kind: 'open_query',
        query: {
          ...('query' in validSpec.source ? validSpec.source.query : {}),
          metric: 'signup event',
        },
      }],
    };
    expect(validateVisualizationSpec(invalidKey).errors.join(' ')).toMatch(/query/i);
  });

  it('rejects funnel payloads with both branches or an invalid present branch', () => {
    const funnelQuery = {
      kind: 'funnel' as const,
      funnel: 'activation',
      date_from: validSpec.range.from,
      date_to: validSpec.range.to,
      env: 'prod',
    };
    const funnelSpec = {
      ...validSpec,
      kind: 'funnel' as const,
      source: { kind: 'funnel' as const, key: 'activation', query: funnelQuery },
      actions: [{ kind: 'open_query' as const, query: funnelQuery }],
    };
    expect(validateVisualizationSpec(funnelSpec)).toEqual({ valid: true, errors: [] });

    for (const query of [
      { ...funnelQuery, steps: [] },
      { ...funnelQuery, steps: [{ metric: 'signup' }] },
      {
        kind: 'funnel',
        funnel: 'invalid key',
        steps: [{ metric: 'signup' }, { metric: 'activation' }],
        date_from: validSpec.range.from,
        date_to: validSpec.range.to,
        env: 'prod',
      },
    ]) {
      const invalid = {
        ...funnelSpec,
        source: { ...funnelSpec.source, query },
        actions: [{ kind: 'open_query', query }],
      };
      expect(validateVisualizationSpec(invalid).errors.join(' ')).toMatch(/query/i);
    }
  });

  it('maps each retention spec kind to one unambiguous renderer', async () => {
    const { resolveManualRenderer } = await import('./visualization');
    expect(resolveManualRenderer('retention_matrix', 'retention')).toBe('retention_matrix');
    expect(resolveManualRenderer('retention_curve', 'retention')).toBe('retention_curve');
    expect(resolveManualRenderer('trend', 'retention')).toBeNull();
  });
});

describe('render state mapping', () => {
  it('distinguishes unavailable, error, empty and ready states', () => {
    expect(resolveRenderState({ capability: false, loading: false, error: null, pointCount: 0 })).toBe('unavailable');
    expect(resolveRenderState({ capability: true, loading: false, error: 'network', pointCount: 0 })).toBe('error');
    expect(resolveRenderState({ capability: true, loading: false, error: null, pointCount: 0 })).toBe('empty');
    expect(resolveRenderState({ capability: true, loading: false, error: null, pointCount: 3 })).toBe('ready');
    expect(resolveRenderState({ capability: true, loading: true, error: null, pointCount: 0 })).toBe('loading');
  });
});
