import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('production protection config', () => {
  it('enables bounded tenant limits and automatic retention by default', () => {
    const config = loadConfig({});

    expect(config.rateLimit).toEqual(expect.objectContaining({
      ingest: expect.objectContaining({
        key: expect.objectContaining({ ratePerSecond: expect.any(Number), burst: expect.any(Number) }),
        project: expect.objectContaining({ ratePerSecond: expect.any(Number), burst: expect.any(Number) }),
      }),
      api: expect.any(Object),
      maxEntries: expect.any(Number),
      maxEntriesPerTenant: expect.any(Number),
    }));
    expect(config.retentionWorker).toEqual({
      enabled: true,
      intervalMs: 900_000,
      continuationDelayMs: 1_000,
      maxConsecutiveContinuations: 5,
      batchSize: 5_000,
      maxBatchesPerRun: 100,
      maxRowsPerRun: 100_000,
      maxRunMs: 5_000,
    });
  });

  it('supports explicit operational overrides and strict booleans', () => {
    const config = loadConfig({
      RATE_LIMIT_ENABLED: 'false',
      RETENTION_WORKER_ENABLED: 'false',
      RETENTION_INTERVAL_MS: '1234',
      RETENTION_BATCH_SIZE: '321',
      RETENTION_CONTINUATION_DELAY_MS: '12',
      RETENTION_MAX_CONSECUTIVE_CONTINUATIONS: '2',
      RETENTION_MAX_BATCHES: '8',
      RETENTION_MAX_ROWS_PER_RUN: '999',
      RETENTION_MAX_RUN_MS: '88',
    });
    expect(config.rateLimit).toBe(false);
    expect(config.retentionWorker).toEqual({
      enabled: false,
      intervalMs: 1234,
      continuationDelayMs: 12,
      maxConsecutiveContinuations: 2,
      batchSize: 321,
      maxBatchesPerRun: 8,
      maxRowsPerRun: 999,
      maxRunMs: 88,
    });

    expect(() => loadConfig({ RATE_LIMIT_ENABLED: 'yes' })).toThrow(
      'RATE_LIMIT_ENABLED must be true or false',
    );
    expect(() => loadConfig({ RETENTION_MAX_BATCHES: '3' })).toThrow(
      'RETENTION_MAX_BATCHES must be at least 4',
    );
    expect(() => loadConfig({ RETENTION_MAX_BATCHES: '1001' })).toThrow(
      'RETENTION_MAX_BATCHES must be less than or equal to 1000',
    );
  });
});
