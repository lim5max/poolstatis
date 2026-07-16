import { describe, expect, it } from 'vitest';
import {
  RateLimitExceeded,
  TenantRateLimiter,
  type TenantRateLimitOptions,
} from '../src/services/rateLimiter.js';

const options: TenantRateLimitOptions = {
  ingest: {
    key: { ratePerSecond: 10, burst: 2 },
    project: { ratePerSecond: 10, burst: 3 },
  },
  api: {
    key: { ratePerSecond: 10, burst: 2 },
    project: { ratePerSecond: 10, burst: 3 },
  },
  maxEntries: 100,
  maxEntriesPerTenant: 100,
  idleTtlMs: 60_000,
};

describe('TenantRateLimiter', () => {
  it('isolates a noisy key without consuming another key or project capacity on rejection', () => {
    const limiter = new TenantRateLimiter(options);
    const request = { lane: 'ingest' as const, tenantId: 'tenant-a', projectId: 'project-a', cost: 1 };

    expect(limiter.consume({ ...request, keyId: 'key-a' }, 0).remaining).toBe(1);
    expect(limiter.consume({ ...request, keyId: 'key-a' }, 0).remaining).toBe(0);
    expect(() => limiter.consume({ ...request, keyId: 'key-a' }, 0)).toThrowError(
      expect.objectContaining<Partial<RateLimitExceeded>>({ scope: 'key' }),
    );

    // The rejected key request must not burn the project's last token.
    expect(limiter.consume({ ...request, keyId: 'key-b' }, 0).remaining).toBe(0);
    expect(() => limiter.consume({ ...request, keyId: 'key-b' }, 0)).toThrowError(
      expect.objectContaining<Partial<RateLimitExceeded>>({ scope: 'project' }),
    );

    // A different project has an independent budget.
    expect(limiter.consume({ ...request, keyId: 'key-c', projectId: 'project-b' }, 0).remaining).toBe(1);
  });

  it('refills both buckets over time and reports a finite retry delay', () => {
    const limiter = new TenantRateLimiter(options);
    const request = { lane: 'api' as const, tenantId: 'tenant-a', keyId: 'key-a', projectId: 'project-a', cost: 2 };

    limiter.consume(request, 0);
    try {
      limiter.consume({ ...request, cost: 1 }, 0);
      throw new Error('expected limiter to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceeded);
      expect((error as RateLimitExceeded).retryAfterMs).toBe(100);
    }

    expect(limiter.consume({ ...request, cost: 1 }, 100).remaining).toBe(0);
  });

  it('rejects a request whose cost can never fit in the configured burst', () => {
    const limiter = new TenantRateLimiter(options);

    expect(() => limiter.consume({
      lane: 'ingest', tenantId: 'tenant-a', keyId: 'key-a', projectId: 'project-a', cost: 3,
    }, 0)).toThrowError(expect.objectContaining({ scope: 'key', retryAfterMs: 0 }));
  });

  it('does not evict a project bucket when many keys rotate through a bounded cache', () => {
    const limiter = new TenantRateLimiter({ ...options, maxEntries: 3, maxEntriesPerTenant: 3 });
    const base = { lane: 'ingest' as const, tenantId: 'tenant-a', projectId: 'project-a', cost: 1 };
    limiter.consume({ ...base, keyId: 'key-a' }, 0);
    limiter.consume({ ...base, keyId: 'key-b' }, 0);
    limiter.consume({ ...base, keyId: 'key-c' }, 0);

    expect(() => limiter.consume({ ...base, keyId: 'key-d' }, 0)).toThrowError(
      expect.objectContaining<Partial<RateLimitExceeded>>({ scope: 'project' }),
    );
  });

  it('fails closed at capacity without resetting live key or project buckets', () => {
    const limiter = new TenantRateLimiter({ ...options, maxEntries: 2, maxEntriesPerTenant: 2 });
    const request = { lane: 'api' as const, tenantId: 'tenant-a', cost: 1 };
    limiter.consume({ ...request, keyId: 'key-a', projectId: 'project-a' }, 0);
    limiter.consume({ ...request, keyId: 'key-b', projectId: 'project-b' }, 0);

    expect(() => limiter.consume({ ...request, keyId: 'key-c', projectId: 'project-c' }, 0))
      .toThrowError(expect.objectContaining({ scope: 'project' }));

    // Capacity rejection must not consume key-a's second token.
    expect(limiter.consume({ ...request, keyId: 'key-a', projectId: 'project-a' }, 0).remaining).toBe(0);
    expect(() => limiter.consume({ ...request, keyId: 'key-a', projectId: 'project-a' }, 0))
      .toThrowError(expect.objectContaining({ scope: 'key' }));
  });

  it('reclaims only idle buckets after the configured TTL', () => {
    const limiter = new TenantRateLimiter({
      ...options, maxEntries: 2, maxEntriesPerTenant: 2, idleTtlMs: 100,
    });
    limiter.consume({ lane: 'api', tenantId: 'tenant-a', keyId: 'key-a', projectId: 'project-a', cost: 1 }, 0);
    limiter.consume({ lane: 'api', tenantId: 'tenant-a', keyId: 'key-b', projectId: 'project-b', cost: 1 }, 0);

    expect(() => limiter.consume({ lane: 'api', tenantId: 'tenant-a', keyId: 'key-c', projectId: 'project-c', cost: 1 }, 99))
      .toThrowError(RateLimitExceeded);
    expect(limiter.consume({ lane: 'api', tenantId: 'tenant-a', keyId: 'key-c', projectId: 'project-c', cost: 1 }, 100).remaining)
      .toBe(1);
  });

  it('does not evict an idle bucket until its quota has fully refilled', () => {
    const limiter = new TenantRateLimiter({
      ...options,
      api: {
        key: { ratePerSecond: 1, burst: 10 },
        project: { ratePerSecond: 1, burst: 10 },
      },
      maxEntries: 1,
      maxEntriesPerTenant: 1,
      idleTtlMs: 100,
    });
    limiter.consume({
      lane: 'api', tenantId: 'tenant-a', keyId: 'key-a', projectId: 'project-a', cost: 10,
    }, 0);

    expect(() => limiter.consume({
      lane: 'api', tenantId: 'tenant-a', keyId: 'key-b', projectId: 'project-b', cost: 1,
    }, 100)).toThrowError(RateLimitExceeded);
    expect(limiter.consume({
      lane: 'api', tenantId: 'tenant-a', keyId: 'key-b', projectId: 'project-b', cost: 1,
    }, 10_000).remaining).toBe(9);
  });

  it('isolates admission capacity by tenant and lane', () => {
    const limiter = new TenantRateLimiter({
      ...options, maxEntries: 2, maxEntriesPerTenant: 1,
    });
    limiter.consume({ lane: 'ingest', tenantId: 'tenant-a', keyId: 'a-1', projectId: 'a-1', cost: 1 }, 0);
    expect(() => limiter.consume({
      lane: 'ingest', tenantId: 'tenant-a', keyId: 'a-2', projectId: 'a-2', cost: 1,
    }, 0)).toThrowError(RateLimitExceeded);

    expect(limiter.consume({
      lane: 'ingest', tenantId: 'tenant-b', keyId: 'b-1', projectId: 'b-1', cost: 1,
    }, 0).remaining).toBe(1);
    expect(limiter.consume({
      lane: 'api', tenantId: 'tenant-c', keyId: 'c-1', projectId: 'c-1', cost: 1,
    }, 0).remaining).toBe(1);
  });
});
