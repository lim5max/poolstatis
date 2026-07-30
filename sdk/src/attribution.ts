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

export const acquisitionPropertyDefinitions = ACQUISITION_UTM_KEYS.map((key) => ({
  key,
  scope: 'event' as const,
  value_type: 'string' as const,
  status: 'proposed' as const,
  source: 'native' as const,
  purpose: `Records the consented session landing ${key.slice(5)} for bounded acquisition analysis, never causal campaign credit.`,
}));

export function snapshotFromBrowser(
  browser: BrowserAttributionEnvironment,
  sessionId: string,
  safeRoute: string,
): AttributionSnapshot {
  const url = new URL(browser.location.href);
  const snapshot: AttributionSnapshot = { session_id: sessionId, landing_route: safeRoute };
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
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
