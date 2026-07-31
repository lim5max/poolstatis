import type { PoolstatisEvent } from './index.js';

export const ACQUISITION_UTM_KEYS = [
  '$utm_source',
  '$utm_medium',
  '$utm_campaign',
  '$utm_term',
  '$utm_content',
] as const;

export type AcquisitionUtmKey = typeof ACQUISITION_UTM_KEYS[number];

export interface BrowserAttributionEnvironment {
  location: { href: string };
  document: { referrer: string };
}

export interface AttributionSnapshot {
  session_id: string;
  landing_route: string;
  referrer_origin?: string;
  $utm_source?: string;
  $utm_medium?: string;
  $utm_campaign?: string;
  $utm_term?: string;
  $utm_content?: string;
}

export interface AttributionCaptureClient {
  capture(event: PoolstatisEvent): void;
  flush(options?: { keepalive?: boolean }): Promise<void>;
  discardQueuedEvents?(predicate: (event: PoolstatisEvent) => boolean): void;
}

export interface AttributionClientOptions {
  client: AttributionCaptureClient;
  distinctId: string | (() => string);
  /** Optional host-owned pause control. Collection starts immediately when omitted. */
  hasConsent?: () => boolean;
  subscribeConsent?: (listener: () => void) => () => void;
  /** Product-owned finite safe route key, never a raw URL pathname. */
  route: string | (() => string);
  browser?: BrowserAttributionEnvironment;
  createSessionId?: () => string;
}

export const acquisitionPropertyDefinitions = ACQUISITION_UTM_KEYS.map((key) => ({
  key,
  scope: 'event' as const,
  value_type: 'string' as const,
  status: 'proposed' as const,
  source: 'native' as const,
  purpose: `Records the session landing ${key.slice(5)} for bounded acquisition analysis, never causal campaign credit.`,
}));

export function snapshotFromBrowser(
  browser: BrowserAttributionEnvironment,
  sessionId: string,
  safeRoute: string,
): AttributionSnapshot {
  const url = new URL(browser.location.href);
  const landingRoute = safeRoute.trim();
  if (!isSafeRouteKey(landingRoute)) {
    throw new Error('attribution route must be a finite safe route key');
  }
  const snapshot: AttributionSnapshot = { session_id: sessionId, landing_route: landingRoute };
  const mapping: Record<string, AcquisitionUtmKey> = {
    utm_source: '$utm_source',
    utm_medium: '$utm_medium',
    utm_campaign: '$utm_campaign',
    utm_term: '$utm_term',
    utm_content: '$utm_content',
  };
  for (const [queryKey, propertyKey] of Object.entries(mapping)) {
    const value = firstAllowedValue(url.searchParams.getAll(queryKey));
    if (value) snapshot[propertyKey] = value;
  }
  const origin = originOnly(browser.document.referrer);
  if (origin) snapshot.referrer_origin = origin;
  return snapshot;
}

/**
 * Acquisition helper retained for existing SDK integrations.
 * New browser analytics capture uses the same safe-route snapshot directly and starts immediately.
 */
export class AttributionClient {
  private snapshot: AttributionSnapshot | null = null;
  private pending: PoolstatisEvent[] = [];
  private started = false;
  private unsubscribeConsent: (() => void) | null = null;

  constructor(private readonly options: AttributionClientOptions) {}

  get sessionId(): string | null { return this.snapshot?.session_id ?? null; }

  get acquisition(): AttributionSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  async start(): Promise<void> {
    if (this.started || !this.collectionAllowed()) return;
    const browser = this.options.browser ?? browserFromGlobal();
    if (!browser) throw new Error('createAttributionClient requires a browser environment — do not start it during SSR');
    const sessionId = this.options.createSessionId?.() ?? opaqueId();
    this.snapshot = snapshotFromBrowser(browser, sessionId, this.route());
    this.started = true;
    this.unsubscribeConsent = this.options.subscribeConsent?.(() => {
      if (!this.collectionAllowed()) this.stop();
    }) ?? null;
    this.enqueue('session.started');
    this.enqueue('page.viewed');
    await this.flush();
  }

  track(event: string, properties: Record<string, unknown> = {}): void {
    if (!this.started || !this.collectionAllowed()) {
      if (!this.collectionAllowed()) this.stop();
      return;
    }
    this.enqueue(event, properties);
  }

  pageViewed(properties: Record<string, unknown> = {}): void {
    this.track('page.viewed', properties);
  }

  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (!this.collectionAllowed()) { this.stop(); return; }
    while (this.pending.length > 0) this.options.client.capture(this.pending.shift()!);
    await this.options.client.flush(options);
  }

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
    if (!this.snapshot) return;
    const { session_id, ...systemProperties } = this.snapshot;
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

  private collectionAllowed(): boolean {
    return this.options.hasConsent?.() ?? true;
  }

  private route(): string {
    const value = typeof this.options.route === 'function' ? this.options.route() : this.options.route;
    const route = value.trim();
    if (!isSafeRouteKey(route)) {
      throw new Error('attribution route must be a finite safe route key');
    }
    return route;
  }
}

export function createAttributionClient(options: AttributionClientOptions): AttributionClient {
  return new AttributionClient(options);
}

function isSafeRouteKey(value: string): boolean {
  return /^[a-z][a-z0-9_.:-]{0,99}$/.test(value);
}

function firstAllowedValue(values: string[]): string | undefined {
  for (const raw of values) {
    const value = raw.trim().normalize('NFC');
    if (value.length <= 256
      && /^[\p{L}\p{N}][\p{L}\p{N} ._~:@+,-]{0,255}$/u.test(value)) {
      return value;
    }
  }
  return undefined;
}

function originOnly(referrer: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !isIpLiteralHostname(url.hostname)
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function isIpLiteralHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(unwrapped);
}

function opaqueId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.()
    ?? `attribution-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserFromGlobal(): BrowserAttributionEnvironment | null {
  const candidate = globalThis as unknown as Partial<BrowserAttributionEnvironment>;
  return candidate.location && candidate.document ? candidate as BrowserAttributionEnvironment : null;
}
