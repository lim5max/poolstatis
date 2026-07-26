import type { PoolstatisEvent } from './index.js';

export const ACQUISITION_UTM_KEYS = [
  '$utm_source', '$utm_medium', '$utm_campaign', '$utm_term', '$utm_content',
] as const;

export type AcquisitionUtmKey = typeof ACQUISITION_UTM_KEYS[number];

/** Definitions to submit with a platform credential, never an ingest key. */
const acquisitionPurposes: Record<AcquisitionUtmKey, string> = {
  $utm_source: 'Records the browser landing publisher or referring source for bounded session acquisition analysis.',
  $utm_medium: 'Records the browser landing channel or medium for bounded session acquisition analysis.',
  $utm_campaign: 'Records the browser landing campaign identifier for bounded session acquisition analysis.',
  $utm_term: 'Records the intentionally supplied browser landing paid-search term for bounded session acquisition analysis.',
  $utm_content: 'Records the browser landing creative or placement variant for bounded session acquisition analysis.',
};

export const acquisitionPropertyDefinitions = ACQUISITION_UTM_KEYS.map((key) => ({
  key,
  scope: 'event' as const,
  value_type: 'string' as const,
  status: 'proposed' as const,
  source: 'native' as const,
  purpose: acquisitionPurposes[key],
}));

export interface AttributionCaptureClient {
  capture(event: PoolstatisEvent): void;
  flush(options?: { keepalive?: boolean }): Promise<void>;
  discardQueuedEvents?(predicate: (event: PoolstatisEvent) => boolean): void;
}

export interface BrowserAttributionEnvironment {
  location: { href: string };
  document: { referrer: string };
}

export interface AttributionSnapshot {
  session_id: string;
  landing_path: string;
  referrer_origin?: string;
  $utm_source?: string;
  $utm_medium?: string;
  $utm_campaign?: string;
  $utm_term?: string;
  $utm_content?: string;
}

export interface AttributionClientOptions {
  client: AttributionCaptureClient;
  /** May change from anonymous to authenticated after login. */
  distinctId: string | (() => string);
  /** Product-analytics consent. No browser data is read until this is true. */
  hasConsent: () => boolean;
  /** Register a synchronous consent-change listener; return its unsubscribe function. */
  subscribeConsent: (listener: () => void) => () => void;
  /** A product-owned safe pathname/route value for page.viewed events. */
  route: string | (() => string);
  /** Injection point for tests or non-window browser environments. */
  browser?: BrowserAttributionEnvironment;
  /** Injection point for tests; production uses crypto.randomUUID when available. */
  createSessionId?: () => string;
}

/**
 * Privacy-bounded browser acquisition helper. It is deliberately a separate
 * entrypoint: importing the base SDK never reads browser globals or URL data.
 */
export class AttributionClient {
  private snapshot: AttributionSnapshot | null = null;
  private pending: PoolstatisEvent[] = [];
  private started = false;
  private unsubscribeConsent: (() => void) | null = null;

  constructor(private readonly options: AttributionClientOptions) {}

  /** Opaque current session id, available only after a consented start. */
  get sessionId(): string | null { return this.snapshot?.session_id ?? null; }

  /** Copy of the immutable landing snapshot, without exposing mutable state. */
  get acquisition(): AttributionSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  /** Read the landing exactly once after consent and send the two session facts. */
  async start(): Promise<void> {
    if (this.started || !this.options.hasConsent()) return;
    // Resolve globals only after the consent predicate says that product
    // analytics may inspect browser state.
    const browser = this.options.browser ?? browserFromGlobal();
    if (!browser) throw new Error('createAttributionClient requires a browser environment — do not start it during SSR');
    const sessionId = this.options.createSessionId?.() ?? opaqueId();
    this.snapshot = snapshotFromBrowser(browser, sessionId);
    this.started = true;
    this.unsubscribeConsent = this.options.subscribeConsent(() => {
      if (!this.options.hasConsent()) this.stop();
    });
    this.enqueue('session.started');
    this.enqueue('page.viewed', { path: this.route() });
    await this.flush();
  }

  /** Track a product event with immutable session attribution properties. */
  track(event: string, properties: Record<string, unknown> = {}): void {
    if (!this.started || !this.options.hasConsent()) {
      if (!this.options.hasConsent()) this.stop();
      return;
    }
    this.enqueue(event, properties);
  }

  /** Call from an SPA navigation; it never reparses the landing URL. */
  pageViewed(properties: Record<string, unknown> = {}): void {
    this.track('page.viewed', { ...properties, path: this.route() });
  }

  /** Flush wrapper events, then the configured SDK client. */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (!this.options.hasConsent()) { this.stop(); return; }
    while (this.pending.length > 0) this.options.client.capture(this.pending.shift()!);
    await this.options.client.flush(options);
  }

  /** Stop immediately and remove every unsent event from this attribution session. */
  stop(): void {
    const sessionId = this.snapshot?.session_id;
    this.pending = [];
    if (sessionId) this.options.client.discardQueuedEvents?.((event) => event.session_id === sessionId);
    this.unsubscribeConsent?.();
    this.unsubscribeConsent = null;
    this.snapshot = null;
    this.started = false;
  }

  private enqueue(event: string, properties: Record<string, unknown> = {}): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    // System-owned properties deliberately merge last: callers cannot spoof a
    // UTM, landing/referrer value or session id for an attribution-managed event.
    const { session_id, ...systemProperties } = snapshot;
    this.pending.push({
      event,
      distinct_id: this.distinctId(),
      session_id,
      properties: { ...properties, ...systemProperties },
    });
  }

  private distinctId(): string {
    return typeof this.options.distinctId === 'function' ? this.options.distinctId() : this.options.distinctId;
  }

  private route(): string {
    return typeof this.options.route === 'function' ? this.options.route() : this.options.route;
  }
}

export function createAttributionClient(options: AttributionClientOptions): AttributionClient {
  return new AttributionClient(options);
}

export function snapshotFromBrowser(browser: BrowserAttributionEnvironment, sessionId: string): AttributionSnapshot {
  const url = new URL(browser.location.href);
  const snapshot: AttributionSnapshot = { session_id: sessionId, landing_path: url.pathname };
  for (const [queryKey, propertyKey] of Object.entries({
    utm_source: '$utm_source', utm_medium: '$utm_medium', utm_campaign: '$utm_campaign',
    utm_term: '$utm_term', utm_content: '$utm_content',
  }) as Array<[string, AcquisitionUtmKey]>) {
    const value = firstAllowedValue(url.searchParams.getAll(queryKey));
    if (value) snapshot[propertyKey] = value;
  }
  const origin = originOnly(browser.document.referrer);
  if (origin) snapshot.referrer_origin = origin;
  return snapshot;
}

function firstAllowedValue(values: string[]): string | undefined {
  for (const raw of values) {
    const value = raw.trim().normalize('NFC');
    if (value.length === 0) continue;
    return value.length <= 256 ? value : undefined;
  }
  return undefined;
}

function originOnly(referrer: string): string | undefined {
  if (!referrer) return undefined;
  try { return new URL(referrer).origin; } catch { return undefined; }
}

function opaqueId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.() ?? `attribution-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserFromGlobal(): BrowserAttributionEnvironment | null {
  const candidate = globalThis as unknown as Partial<BrowserAttributionEnvironment>;
  return candidate.location && candidate.document ? candidate as BrowserAttributionEnvironment : null;
}
