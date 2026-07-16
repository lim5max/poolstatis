import type pg from 'pg';
import type { EventStore } from '../stores/eventStore.js';
import { PostgresEventStore } from '../stores/postgresEventStore.js';
import {
  BufferedEventStore,
  DEFAULT_BUFFERED_EVENT_STORE_OPTIONS,
  type BufferedEventStoreOptions,
} from '../stores/bufferedEventStore.js';
import { IngestService } from '../services/ingest.js';
import { QueryService } from '../services/query.js';
import { QueryCache, type QueryCacheOptions } from '../services/queryCache.js';

/** Shared service wiring for the HTTP server, CLI, and tests. */
export interface AppContext {
  pool: pg.Pool;
  eventStore: EventStore;
  ingest: IngestService;
  query: QueryService;
}

export interface CreateContextOptions {
  ingestBuffer?: BufferedEventStoreOptions | false;
  queryCache?: QueryCacheOptions | false;
}

export function createContext(pool: pg.Pool, options: CreateContextOptions = {}): AppContext {
  const rawEventStore = new PostgresEventStore(pool);
  const eventStore = options.ingestBuffer === false
    ? rawEventStore
    : new BufferedEventStore(rawEventStore, options.ingestBuffer ?? DEFAULT_BUFFERED_EVENT_STORE_OPTIONS);
  const queryCache = options.queryCache === false
    ? undefined
    : new QueryCache(options.queryCache ?? { ttlMs: 1_000, maxEntries: 1_000 });
  return {
    pool,
    eventStore,
    ingest: new IngestService(pool, eventStore),
    query: new QueryService(pool, eventStore, queryCache),
  };
}
