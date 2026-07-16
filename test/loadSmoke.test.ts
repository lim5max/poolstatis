import { describe, expect, it } from 'vitest';
import {
  loadSmokeConfig,
  percentile,
  runConcurrently,
  summarizeLoadSmoke,
} from '../src/cli/loadSmoke.js';

describe('load smoke helpers', () => {
  it('calculates deterministic nearest-rank percentiles', () => {
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('requires credentials without exposing them in the public config', () => {
    expect(() => loadSmokeConfig({})).toThrow('POOLSTATIS_INGEST_TOKEN');
    const config = loadSmokeConfig({
      POOLSTATIS_INGEST_TOKEN: 'pk_secret',
      POOLSTATIS_PLATFORM_TOKEN: 'sk_secret',
      POOLSTATIS_PROJECT: 'demo',
      LOAD_SMOKE_DURATION_MS: '1000',
      LOAD_SMOKE_CONCURRENCY: '3',
    });
    expect(config.concurrency).toBe(3);
    expect(JSON.stringify(config.public)).not.toContain('pk_secret');
    expect(JSON.stringify(config.public)).not.toContain('sk_secret');
  });

  it('never exceeds configured concurrency', async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    await runConcurrently(4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      completed += 1;
      return completed < 12;
    });
    expect(peak).toBe(4);
    expect(completed).toBeGreaterThanOrEqual(12);
  });

  it('fails the smoke when latency or error-rate SLO is exceeded', () => {
    const summary = summarizeLoadSmoke({
      ingest: { latenciesMs: [10, 20, 400], requests: 3, errors: 0, acceptedEvents: 30, durationMs: 1000 },
      query: { latenciesMs: [20, 600], requests: 2, errors: 1, acceptedEvents: 0, durationMs: 1000 },
      queryCached: { latenciesMs: [700], requests: 1, errors: 1, acceptedEvents: 0, durationMs: 1000 },
      thresholds: { ingestP95Ms: 250, queryP95Ms: 500, maxErrorRate: 0.1 },
      publicConfig: { baseUrl: 'http://localhost:3300', project: 'demo', concurrency: 4, durationMs: 1000, batchSize: 10 },
      verifiedEventDelta: { expectedAtLeast: 30, observed: 0 },
    });
    expect(summary.ok).toBe(false);
    expect(summary.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('ingest p95'),
      expect.stringContaining('query p95'),
      expect.stringContaining('error rate'),
      expect.stringContaining('metric event delta'),
      expect.stringContaining('query_cached'),
    ]));
  });
});
