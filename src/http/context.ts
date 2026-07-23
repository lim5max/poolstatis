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
import { PostHogAdapter } from '../services/posthog.js';
import { WebhookService } from '../services/webhooks.js';
import type { OutboundPolicyOptions } from '../security/outbound.js';

/** Shared service wiring for the HTTP server, CLI, and tests. */
export interface AppContext {
  pool: pg.Pool;
  eventStore: EventStore;
  ingest: IngestService;
  query: QueryService;
  posthog: PostHogAdapter;
  webhooks: WebhookService;
}

export interface CreateContextOptions {
  ingestBuffer?: BufferedEventStoreOptions | false;
  manageEventPartitions?: boolean;
  queryCache?: QueryCacheOptions | false;
  connectorEncryptionKey?: string;
  outboundPolicy?: OutboundPolicyOptions;
}

export function createContext(pool: pg.Pool, options: CreateContextOptions = {}): AppContext {
  const rawEventStore = new PostgresEventStore(pool, {
    managePartitions: options.manageEventPartitions ?? true,
  });
  const eventStore = options.ingestBuffer === false
    ? rawEventStore
    : new BufferedEventStore(rawEventStore, options.ingestBuffer ?? DEFAULT_BUFFERED_EVENT_STORE_OPTIONS);
  const queryCache = options.queryCache === false
    ? undefined
    : new QueryCache(options.queryCache ?? { ttlMs: 1_000, maxEntries: 1_000 });
  const posthog = new PostHogAdapter(pool, options.connectorEncryptionKey, options.outboundPolicy);
  return {
    pool,
    eventStore,
    ingest: new IngestService(pool, eventStore),
    query: new QueryService(pool, eventStore, queryCache, posthog),
    posthog,
    webhooks: new WebhookService(pool, options.connectorEncryptionKey, options.outboundPolicy),
  };
}
