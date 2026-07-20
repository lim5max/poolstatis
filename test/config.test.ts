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
    expect(config.releaseMonitor).toEqual({
      enabled: true,
      intervalMs: 60_000,
      batchSize: 25,
      maxAttempts: 8,
      baseRetryMs: 60_000,
      maxRetryMs: 3_600_000,
      leaseMs: 300_000,
    });
    expect(config.webhookOutbox).toEqual({
      enabled: true,
      intervalMs: 5_000,
      batchSize: 25,
      maxAttempts: 8,
      baseRetryMs: 5_000,
      maxRetryMs: 3_600_000,
      leaseMs: 300_000,
      requestTimeoutMs: 10_000,
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
      RELEASE_MONITOR_ENABLED: 'false',
      RELEASE_MONITOR_INTERVAL_MS: '2222',
      RELEASE_MONITOR_BATCH_SIZE: '7',
      RELEASE_MONITOR_MAX_ATTEMPTS: '4',
      RELEASE_MONITOR_BASE_RETRY_MS: '333',
      RELEASE_MONITOR_MAX_RETRY_MS: '4444',
      RELEASE_MONITOR_LEASE_MS: '5555',
      WEBHOOK_OUTBOX_ENABLED: 'false',
      WEBHOOK_OUTBOX_INTERVAL_MS: '111',
      WEBHOOK_OUTBOX_BATCH_SIZE: '6',
      WEBHOOK_OUTBOX_MAX_ATTEMPTS: '3',
      WEBHOOK_OUTBOX_BASE_RETRY_MS: '222',
      WEBHOOK_OUTBOX_MAX_RETRY_MS: '3333',
      WEBHOOK_OUTBOX_LEASE_MS: '4444',
      WEBHOOK_REQUEST_TIMEOUT_MS: '555',
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
    expect(config.releaseMonitor).toEqual({
      enabled: false,
      intervalMs: 2222,
      batchSize: 7,
      maxAttempts: 4,
      baseRetryMs: 333,
      maxRetryMs: 4444,
      leaseMs: 5555,
    });
    expect(config.webhookOutbox).toEqual({
      enabled: false,
      intervalMs: 111,
      batchSize: 6,
      maxAttempts: 3,
      baseRetryMs: 222,
      maxRetryMs: 3333,
      leaseMs: 4444,
      requestTimeoutMs: 555,
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
