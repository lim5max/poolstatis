import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('production protection config', () => {
  it('uses the approved hosted-claim namespace and safe CORS defaults', () => {
    const hosted = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
    });
    const production = loadConfig({ NODE_ENV: 'production' });

    expect(hosted.auth).toMatchObject({
      claims: {
        email: 'https://poolstatis.xyz/email',
        emailVerified: 'https://poolstatis.xyz/email_verified',
        displayName: 'https://poolstatis.xyz/name',
        picture: 'https://poolstatis.xyz/picture',
      },
    });
    expect(hosted.corsOrigins).toEqual([
      'http://localhost:5273',
      'http://127.0.0.1:5273',
      'http://[::1]:5273',
    ]);
    expect(production.corsOrigins).toEqual([]);
  });

  it('requires an explicit hosted opt-in before enforcing external organization policy', () => {
    const selfHost = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
    });
    const hosted = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      HOSTED_POLICY_REQUIRED: 'true',
    });

    expect(selfHost.auth?.requireOrganizationPolicy).toBe(false);
    expect(hosted.auth?.requireOrganizationPolicy).toBe(true);
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      HOSTED_POLICY_REQUIRED: 'yes',
    })).toThrow('HOSTED_POLICY_REQUIRED must be true or false');
  });

  it('normalizes a comma-separated exact-origin CORS allowlist and rejects unsafe entries', () => {
    expect(loadConfig({
      POOLSTATIS_CORS_ORIGINS: 'https://console.example/, https://console.example, http://localhost:5273',
    }).corsOrigins).toEqual(['https://console.example', 'http://localhost:5273']);

    for (const origin of [
      'ftp://console.example',
      'https://user:pass@console.example',
      'https://console.example/path',
      'https://console.example?query=true',
    ]) {
      expect(() => loadConfig({ POOLSTATIS_CORS_ORIGINS: origin })).toThrow('POOLSTATIS_CORS_ORIGINS');
    }
  });

  it('rejects an explicitly empty hosted-auth claim name', () => {
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      AUTH_JWT_EMAIL_CLAIM: ' ',
    })).toThrow('AUTH_JWT_EMAIL_CLAIM must not be empty');
  });

  it('fails fast when legacy issuer adoption is configured for a different issuer', () => {
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      AUTH_JWT_LEGACY_ISSUER: 'https://another-issuer.example/',
    })).toThrow('AUTH_JWT_LEGACY_ISSUER must equal AUTH_JWT_ISSUER');

    expect(loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      AUTH_JWT_LEGACY_ISSUER: 'https://issuer.example/',
    }).auth?.legacyIssuer).toBe('https://issuer.example/');
  });

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
      OUTBOUND_ALLOW_LOCAL_HTTP: 'true',
    });
    expect(config.rateLimit).toBe(false);
    expect(config.outboundPolicy).toEqual({ allowLocalHttp: true });
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
