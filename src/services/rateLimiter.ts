export type RateLimitLane = 'ingest' | 'api';
export type RateLimitScope = 'key' | 'project';

export interface BucketLimit {
  ratePerSecond: number;
  burst: number;
}

export interface LaneLimits {
  key: BucketLimit;
  project: BucketLimit;
}

export interface TenantRateLimitOptions {
  ingest: LaneLimits;
  api: LaneLimits;
  /** Maximum live buckets in each independent lane/scope store. */
  maxEntries: number;
  /** Admission cap for one organization inside each lane/scope store. */
  maxEntriesPerTenant: number;
  idleTtlMs: number;
}

export interface RateLimitRequest {
  lane: RateLimitLane;
  tenantId: string;
  keyId: string;
  projectId: string;
  cost: number;
}

export interface RateLimitDecision {
  limit: number;
  remaining: number;
}

interface BucketState {
  tokens: number;
  refilledAt: number;
  lastSeenAt: number;
  limit: BucketLimit;
}

interface BucketRecord {
  id: string;
  tenantId: string;
  state: BucketState;
}

interface BucketStore {
  all: Map<string, BucketRecord>;
  tenants: Map<string, Map<string, BucketRecord>>;
}

export class RateLimitExceeded extends Error {
  constructor(
    public readonly scope: RateLimitScope,
    public readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = 'RateLimitExceeded';
  }
}

/**
 * Per-process hierarchical token buckets. Each lane/scope has independent
 * capacity, with per-organization admission caps so one tenant or ingest-key
 * churn cannot crowd MCP/custom-dashboard state out of memory.
 */
export class TenantRateLimiter {
  private readonly stores: Record<RateLimitLane, Record<RateLimitScope, BucketStore>> = {
    ingest: { key: store(), project: store() },
    api: { key: store(), project: store() },
  };

  constructor(private readonly options: TenantRateLimitOptions) {
    validateOptions(options);
  }

  consume(request: RateLimitRequest, nowMs = Date.now()): RateLimitDecision {
    if (!Number.isFinite(request.cost) || request.cost <= 0) {
      throw new Error('rate-limit cost must be a positive finite number');
    }
    const limits = this.options[request.lane];
    if (request.cost > limits.key.burst) {
      throw new RateLimitExceeded('key', 0, 'request cost exceeds the API-key burst limit');
    }
    if (request.cost > limits.project.burst) {
      throw new RateLimitExceeded('project', 0, 'request cost exceeds the project burst limit');
    }

    const projectStore = this.stores[request.lane].project;
    const keyStore = this.stores[request.lane].key;
    const projectId = `${request.tenantId}:${request.projectId}`;
    const keyId = `${request.tenantId}:${request.keyId}`;
    const existingProject = this.touch(projectStore, projectId, nowMs);
    const existingKey = this.touch(keyStore, keyId, nowMs);

    if (!existingProject) this.ensureRoom(projectStore, request.tenantId, 'project', nowMs);
    const projectBucket = existingProject?.state ?? freshBucket(limits.project, nowMs);
    refill(projectBucket, nowMs);
    if (projectBucket.tokens < request.cost) {
      throw new RateLimitExceeded(
        'project',
        retryDelay(request.cost, projectBucket.tokens, limits.project.ratePerSecond),
        'project rate limit exceeded',
      );
    }

    if (!existingKey) this.ensureRoom(keyStore, request.tenantId, 'key', nowMs);
    const keyBucket = existingKey?.state ?? freshBucket(limits.key, nowMs);
    refill(keyBucket, nowMs);
    if (keyBucket.tokens < request.cost) {
      throw new RateLimitExceeded(
        'key',
        retryDelay(request.cost, keyBucket.tokens, limits.key.ratePerSecond),
        'API-key rate limit exceeded',
      );
    }

    if (!existingProject) this.insert(projectStore, projectId, request.tenantId, projectBucket);
    if (!existingKey) this.insert(keyStore, keyId, request.tenantId, keyBucket);
    keyBucket.tokens -= request.cost;
    projectBucket.tokens -= request.cost;
    return {
      limit: Math.min(limits.key.burst, limits.project.burst),
      remaining: Math.max(0, Math.floor(Math.min(keyBucket.tokens, projectBucket.tokens))),
    };
  }

  get size(): number {
    return (['ingest', 'api'] as const).reduce((total, lane) =>
      total + this.stores[lane].key.all.size + this.stores[lane].project.all.size, 0);
  }

  private touch(storeState: BucketStore, id: string, nowMs: number): BucketRecord | undefined {
    const record = storeState.all.get(id);
    if (!record) return undefined;
    record.state.lastSeenAt = nowMs;
    moveToEnd(storeState.all, id, record);
    const tenant = storeState.tenants.get(record.tenantId);
    if (tenant) moveToEnd(tenant, id, record);
    return record;
  }

  private insert(
    storeState: BucketStore,
    id: string,
    tenantId: string,
    bucketState: BucketState,
  ): void {
    const record = { id, tenantId, state: bucketState };
    storeState.all.set(id, record);
    let tenant = storeState.tenants.get(tenantId);
    if (!tenant) {
      tenant = new Map();
      storeState.tenants.set(tenantId, tenant);
    }
    tenant.set(id, record);
  }

  private ensureRoom(
    storeState: BucketStore,
    tenantId: string,
    scope: RateLimitScope,
    nowMs: number,
  ): void {
    const tenant = storeState.tenants.get(tenantId);
    if (tenant && tenant.size >= this.options.maxEntriesPerTenant) {
      this.evictRecoveredOldest(storeState, tenant, scope, nowMs, 'tenant');
    }
    if (storeState.all.size >= this.options.maxEntries) {
      this.evictRecoveredOldest(storeState, storeState.all, scope, nowMs, 'global');
    }
  }

  private evictRecoveredOldest(
    storeState: BucketStore,
    queue: Map<string, BucketRecord>,
    scope: RateLimitScope,
    nowMs: number,
    capacity: 'tenant' | 'global',
  ): void {
    const oldest = queue.values().next().value as BucketRecord | undefined;
    if (!oldest) return;
    const idleFor = Math.max(0, nowMs - oldest.state.lastSeenAt);
    refill(oldest.state, nowMs, false);
    const recovered = oldest.state.tokens >= oldest.state.limit.burst;
    if (idleFor < this.options.idleTtlMs || !recovered) {
      const idleWait = Math.max(0, this.options.idleTtlMs - idleFor);
      const refillWait = retryDelay(
        oldest.state.limit.burst,
        oldest.state.tokens,
        oldest.state.limit.ratePerSecond,
      );
      throw new RateLimitExceeded(
        scope,
        Math.max(1, idleWait, refillWait),
        `${scope} rate-limit ${capacity} capacity is saturated`,
      );
    }
    this.remove(storeState, oldest);
  }

  private remove(storeState: BucketStore, record: BucketRecord): void {
    storeState.all.delete(record.id);
    const tenant = storeState.tenants.get(record.tenantId);
    tenant?.delete(record.id);
    if (tenant?.size === 0) storeState.tenants.delete(record.tenantId);
  }
}

function store(): BucketStore {
  return { all: new Map(), tenants: new Map() };
}

function moveToEnd(map: Map<string, BucketRecord>, id: string, record: BucketRecord): void {
  map.delete(id);
  map.set(id, record);
}

function freshBucket(limit: BucketLimit, nowMs: number): BucketState {
  return { tokens: limit.burst, refilledAt: nowMs, lastSeenAt: nowMs, limit };
}

function refill(bucket: BucketState, nowMs: number, markSeen = true): void {
  const elapsedMs = Math.max(0, nowMs - bucket.refilledAt);
  if (elapsedMs > 0) {
    bucket.tokens = Math.min(
      bucket.limit.burst,
      bucket.tokens + (elapsedMs / 1_000) * bucket.limit.ratePerSecond,
    );
    bucket.refilledAt = nowMs;
  }
  if (markSeen) bucket.lastSeenAt = nowMs;
}

function retryDelay(cost: number, tokens: number, ratePerSecond: number): number {
  return Math.ceil(((cost - tokens) / ratePerSecond) * 1_000);
}

function validateOptions(options: TenantRateLimitOptions): void {
  if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
    throw new Error('rate-limit maxEntries must be a positive integer');
  }
  if (!Number.isInteger(options.maxEntriesPerTenant) || options.maxEntriesPerTenant < 1) {
    throw new Error('rate-limit maxEntriesPerTenant must be a positive integer');
  }
  if (options.maxEntriesPerTenant > options.maxEntries) {
    throw new Error('rate-limit maxEntriesPerTenant cannot exceed maxEntries');
  }
  if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs <= 0) {
    throw new Error('rate-limit idleTtlMs must be positive');
  }
  for (const lane of ['ingest', 'api'] as const) {
    for (const scope of ['key', 'project'] as const) {
      const limit = options[lane][scope];
      if (!Number.isFinite(limit.ratePerSecond) || limit.ratePerSecond <= 0) {
        throw new Error(`${lane}.${scope}.ratePerSecond must be positive`);
      }
      if (!Number.isFinite(limit.burst) || limit.burst <= 0) {
        throw new Error(`${lane}.${scope}.burst must be positive`);
      }
    }
  }
}
