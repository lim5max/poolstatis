export interface QueryCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface CacheEntry<T> {
  projectId: string;
  promise: Promise<T>;
  expiresAt: number;
}

/** Small process-local cache for repeated dashboard/MCP reads.
 * Cross-instance freshness is bounded by the short TTL; same-process writes
 * invalidate the affected tenant immediately. */
export class QueryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: QueryCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  async getOrLoad<T>(projectId: string, key: string, loader: () => Promise<T>): Promise<T> {
    const cacheKey = `${projectId}:${key}`;
    const existing = this.entries.get(cacheKey) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > this.now()) return existing.promise;
    if (existing) this.entries.delete(cacheKey);

    this.evictForInsert();
    const entry: CacheEntry<T> = {
      projectId,
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve().then(loader),
    };
    this.entries.set(cacheKey, entry as CacheEntry<unknown>);

    entry.promise.then(
      () => {
        if (this.entries.get(cacheKey) === entry) entry.expiresAt = this.now() + this.options.ttlMs;
      },
      () => {
        if (this.entries.get(cacheKey) === entry) this.entries.delete(cacheKey);
      },
    );
    return entry.promise;
  }

  invalidateProject(projectId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.projectId === projectId) this.entries.delete(key);
    }
  }

  private evictForInsert(): void {
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

export function canonicalQueryKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQueryKey).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalQueryKey(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
