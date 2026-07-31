/**
 * @poolstatis/sdk — tiny browser + Node client for Poolstatis ingest.
 *
 * Design goals: drop-in for any digital product, never lose events.
 * - Batches events and flushes on an interval or when the batch fills.
 * - Retries failed flushes with backoff, re-queuing the batch under the SAME
 *   batch_id (the server dedups by batch_id, so retries are idempotent).
 * - Flushes on page hide/unload via `fetch(..., { keepalive: true })`, the
 *   modern replacement for sendBeacon that still allows the auth header.
 * - Zero dependencies. Works wherever `fetch` exists (Node >=18, modern browsers);
 *   inject a `fetch` impl otherwise.
 */

export interface PoolstatisOptions {
  /** Platform base URL, e.g. "https://analytics.example.com" (no trailing slash needed). */
  url: string;
  /** Ingest key (`pk_…`). Write-only; safe to ship in client code. */
  ingestKey: string;
  /** Auto-flush cadence in ms (default 5000). */
  flushIntervalMs?: number;
  /** Max events per request (default 100; the server hard-caps at 500). */
  maxBatchSize?: number;
  /** Drop-oldest cap on the in-memory queue to bound memory (default 10_000). */
  maxQueue?: number;
  /** Injected fetch (for tests or non-standard runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Called when a flush ultimately fails after retries. */
  onError?: (err: unknown) => void;
}

export interface PoolstatisEvent {
  event: string;
  distinct_id: string;
  timestamp?: string;
  session_id?: string;
  properties?: Record<string, unknown>;
}

export {
  clearBrowserAnalyticsIdentity,
  createBrowserAnalytics,
  BROWSER_CONTEXT_VERSION,
  BROWSER_PAGE_ENGAGEMENT_EVENT,
  BROWSER_PAGE_VIEW_EVENT,
  BROWSER_RESERVED_PROPERTIES,
} from './browser.js';
export type {
  ActorLinkHandoff,
  BrowserAnalyticsOptions,
  BrowserCaptureClient,
  BrowserConsentPolicy,
  BrowserLike,
} from './browser.js';
export {
  ACQUISITION_UTM_KEYS,
  acquisitionPropertyDefinitions,
  AttributionClient,
  createAttributionClient,
  snapshotFromBrowser,
} from './attribution.js';
export type {
  AcquisitionUtmKey,
  AttributionClientOptions,
  AttributionSnapshot,
  BrowserAttributionEnvironment,
} from './attribution.js';

export interface ExperienceEventContext {
  distinct_id: string;
  session_id: string;
  route: string;
  version: string;
  device: 'desktop' | 'mobile';
  viewport_width: number;
  viewport_height: number;
  document_width: number;
  document_height: number;
  sequence: number;
}

/** Narrow wire contract consumed by the optional Browser Experience module. */
export type ExperienceCaptureEvent =
  | ({ kind: 'page_viewed' } & ExperienceEventContext)
  | ({ kind: 'element_clicked'; label: string; x: number; y: number; viewport_x: number; viewport_y: number } & ExperienceEventContext)
  | ({ kind: 'scroll_depth'; depth: number } & ExperienceEventContext)
  | ({ kind: 'section_exposed'; section: string; top: number } & ExperienceEventContext)
  | ({ kind: 'client_error'; error_type: 'error' | 'unhandled_rejection' } & ExperienceEventContext);

export interface ExperienceCaptureBatch {
  surface: string;
  batch_id: string;
  events: ExperienceCaptureEvent[];
}

export interface ExperienceCaptureOptions {
  /** Use fetch keepalive so navigation does not cancel the interaction batch. */
  keepalive?: boolean;
}

/** The optional BrowserExperience module uses this to decide whether to retry a whole stable batch. */
export class ExperienceCaptureError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ExperienceCaptureError';
  }
}

/** A stable assignment returned by the Poolstatis feature-delivery service. */
export interface FeatureFlagVariant {
  key: string;
  payload?: Record<string, unknown>;
}

export interface FeatureFlagOptions {
  /** Optional session id copied onto the automatic exposure event. */
  sessionId?: string;
}

interface EntityUpsert {
  entity_type: string;
  entity_id: string;
  properties: Record<string, unknown>;
}

const DEFAULTS = { flushIntervalMs: 5000, maxBatchSize: 100, maxQueue: 10_000 };
// On page unload, fetch(keepalive) bodies are capped (~64KB total across keepalive
// requests), so cap the unload batch small to avoid silently dropping it.
const KEEPALIVE_BATCH = 25;
// Cap how many failed batches we hold for retry, so an unreachable backend can't
// grow memory without bound (each retry batch keeps its original batch_id).
const MAX_RETRY_BATCHES = 100;

/** A formed-but-unsent request, kept verbatim so retries reuse the same batch_id. */
interface PendingBatch { path: string; body: unknown }

function isEventBatch(body: unknown): body is { batch_id?: string; events: PoolstatisEvent[] } {
  return typeof body === 'object' && body !== null
    && Array.isArray((body as { events?: unknown }).events);
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Non-crypto fallback — only used where crypto.randomUUID is unavailable.
  return `b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Poolstatis {
  private readonly url: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueue: number;
  private readonly onError: (err: unknown) => void;

  private events: PoolstatisEvent[] = [];
  private entities: EntityUpsert[] = [];
  private retries: PendingBatch[] = []; // batches that failed transiently, resent with their original id
  private flags = new Map<string, FeatureFlagVariant | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unbindUnload: (() => void) | null = null;
  private flushing = false;

  constructor(opts: PoolstatisOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.key = opts.ingestKey;
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error('no fetch available — pass opts.fetch');
    // Bind to globalThis: a bare `globalThis.fetch` called via a property
    // reference throws "Illegal invocation" in browsers.
    this.fetchImpl = f.bind(globalThis);
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxBatchSize = Math.min(opts.maxBatchSize ?? DEFAULTS.maxBatchSize, 500);
    this.maxQueue = opts.maxQueue ?? DEFAULTS.maxQueue;
    this.onError = opts.onError ?? (() => {});
    this.startTimer();
    this.bindUnload();
  }

  /** Queue an event. The distinct_id must be a stable user id. */
  track(event: string, distinctId: string, properties: Record<string, unknown> = {}): void {
    this.capture({ event, distinct_id: distinctId, properties });
  }

  /** Queue a fully-formed event (e.g. with an explicit timestamp/session_id). */
  capture(e: PoolstatisEvent): void {
    this.events.push(e);
    if (this.events.length > this.maxQueue) this.events.splice(0, this.events.length - this.maxQueue);
    if (this.events.length >= this.maxBatchSize) void this.flush();
  }

  /** Remove locally queued events selected by an explicit privacy boundary. */
  discardQueuedEvents(predicate: (event: PoolstatisEvent) => boolean): void {
    this.events = this.events.filter((event) => !predicate(event));
    this.retries = this.retries.flatMap((batch) => {
      if (batch.path !== '/i/v1/events' || !isEventBatch(batch.body)) return [batch];
      const events = batch.body.events.filter((event) => !predicate(event));
      return events.length > 0 ? [{ ...batch, body: { ...batch.body, events } }] : [];
    });
  }

  /** Upsert mutable entity state (user/account/…). Merge semantics; null deletes a key. */
  identify(entityType: string, entityId: string, properties: Record<string, unknown>): void {
    this.entities.push({ entity_type: entityType, entity_id: entityId, properties });
    if (this.entities.length >= this.maxBatchSize) void this.flush();
  }

  /**
   * Evaluate one remote feature flag for a stable actor. A successful first
   * evaluation records the server-side exposure event; later reads for this
   * client/actor/key use the cached assignment and don't inflate exposure data.
   * A failed evaluation safely resolves to `null` (the product's control path)
   * and reports the error through the standard `onError` hook.
   */
  async getFeatureFlag(
    key: string,
    distinctId: string,
    options: FeatureFlagOptions = {},
  ): Promise<FeatureFlagVariant | null> {
    const cacheKey = `${key}\u0000${distinctId}`;
    if (this.flags.has(cacheKey)) return this.flags.get(cacheKey)!;
    try {
      const response = await this.evaluateFlag({
        key,
        distinct_id: distinctId,
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
      });
      this.flags.set(cacheKey, response.variant);
      return response.variant;
    } catch (err) {
      this.onError(err);
      return null;
    }
  }

  /** Evaluate several flags. Each key follows the same exposure-safe cache path. */
  async getFeatureFlags(
    keys: string[],
    distinctId: string,
    options: FeatureFlagOptions = {},
  ): Promise<Record<string, FeatureFlagVariant | null>> {
    const variants = await Promise.all(keys.map(async (key) => [key, await this.getFeatureFlag(key, distinctId, options)] as const));
    return Object.fromEntries(variants);
  }

  /**
   * Send a typed Browser Experience batch immediately. This is public solely
   * so the optional `@poolstatis/sdk/experience` module can reuse the SDK's
   * configured endpoint, key, retry policy and error hook.
   */
  async captureExperience(batch: ExperienceCaptureBatch, options: ExperienceCaptureOptions = {}): Promise<void> {
    const result = await this.send('/i/v1/experience/events', batch, options.keepalive);
    if (result === 'ok') return;
    throw new ExperienceCaptureError(
      result === 'drop' ? 'browser experience capture rejected' : 'browser experience capture could not be delivered',
      result === 'retry',
    );
  }

  /**
   * Send everything queued now. Safe to call repeatedly; a non-keepalive call made
   * while a flush is in flight returns early because the in-flight loop re-checks the
   * queues and drains anything added meanwhile.
   *
   * A keepalive flush (page unload) is NOT suppressed by an in-flight periodic flush:
   * that in-flight request is non-keepalive and the browser cancels it on navigation,
   * so the unload path must still send whatever is queued, with `keepalive: true`.
   */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (opts.keepalive) { await this.drain(true); return; }
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.drain(false);
    } finally {
      this.flushing = false;
    }
  }

  /** Drain retries, then entities, then events. `splice` is synchronous, so a concurrent
   *  keepalive drain and periodic drain never claim the same queued item. */
  private async drain(keepalive: boolean): Promise<void> {
    const cap = keepalive ? KEEPALIVE_BATCH : this.maxBatchSize;
    // 1) Retry the batches that previously failed — verbatim, so they keep their
    //    original batch_id and the server dedups any that actually landed.
    const pending = this.retries;
    this.retries = [];
    for (const b of pending) {
      if ((await this.send(b.path, b.body, keepalive)) === 'retry') this.requeue(b);
    }
    // 2) Entities, then 3) events — forming each batch's id exactly once.
    while (this.entities.length > 0) {
      const batch: PendingBatch = { path: '/i/v1/entities', body: { entities: this.entities.splice(0, cap) } };
      if ((await this.send(batch.path, batch.body, keepalive)) === 'retry') this.requeue(batch);
    }
    while (this.events.length > 0) {
      const batch: PendingBatch = { path: '/i/v1/events', body: { batch_id: uuid(), events: this.events.splice(0, cap) } };
      if ((await this.send(batch.path, batch.body, keepalive)) === 'retry') this.requeue(batch);
    }
  }

  /** Flush, stop the timer, and remove unload listeners (call on graceful shutdown). */
  async shutdown(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.unbindUnload?.();
    this.unbindUnload = null;
    await this.flush();
  }

  private requeue(b: PendingBatch): void {
    this.retries.push(b);
    if (this.retries.length > MAX_RETRY_BATCHES) this.retries.splice(0, this.retries.length - MAX_RETRY_BATCHES);
  }

  /** One request with bounded retry. Returns ok (sent / accepted), drop (client bug), retry (transient). */
  private async send(path: string, body: unknown, keepalive?: boolean): Promise<'ok' | 'drop' | 'retry'> {
    const attempts = keepalive ? 1 : 4; // on unload there's no time to retry
    const payload = JSON.stringify(body);
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.fetchImpl(`${this.url}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
          body: payload,
          keepalive,
        });
        // 2xx and 207 are accepted (207 = per-event validation errors, which are
        // logged server-side and won't pass on retry). 4xx is a client bug — drop.
        if (res.ok || res.status === 207) return 'ok';
        if (res.status < 500) { this.onError(new Error(`ingest rejected: ${res.status}`)); return 'drop'; }
      } catch (err) {
        if (i === attempts - 1) this.onError(err);
      }
      if (i < attempts - 1) await delay(250 * 2 ** i);
    }
    return 'retry';
  }

  private async evaluateFlag(body: { key: string; distinct_id: string; session_id?: string }): Promise<{ variant: FeatureFlagVariant | null }> {
    const res = await this.fetchImpl(`${this.url}/i/v1/flags/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null) as { variant?: unknown } | null;
    if (!res.ok) throw new Error(`feature flag evaluation rejected: ${res.status}`);
    if (!payload || !('variant' in payload)) throw new Error('feature flag evaluation returned an invalid response');
    if (payload.variant === null) return { variant: null };
    if (typeof payload.variant !== 'object' || typeof (payload.variant as { key?: unknown }).key !== 'string') {
      throw new Error('feature flag evaluation returned an invalid variant');
    }
    const variant = payload.variant as { key: string; payload?: unknown };
    if (variant.payload !== undefined && (typeof variant.payload !== 'object' || variant.payload === null || Array.isArray(variant.payload))) {
      throw new Error('feature flag evaluation returned an invalid variant payload');
    }
    return {
      variant: {
        key: variant.key,
        ...(variant.payload ? { payload: variant.payload as Record<string, unknown> } : {}),
      },
    };
  }

  private startTimer(): void {
    // Node's unref keeps the timer from holding the process open.
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private bindUnload(): void {
    const doc = (globalThis as { document?: Document }).document;
    const g = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    if (!doc?.addEventListener) return;
    const onHide = () => { if (doc.visibilityState === 'hidden') void this.flush({ keepalive: true }); };
    const onPageHide = () => void this.flush({ keepalive: true });
    doc.addEventListener('visibilitychange', onHide);
    g.addEventListener?.('pagehide', onPageHide);
    this.unbindUnload = () => {
      doc.removeEventListener('visibilitychange', onHide);
      g.removeEventListener?.('pagehide', onPageHide);
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createClient(opts: PoolstatisOptions): Poolstatis {
  return new Poolstatis(opts);
}
