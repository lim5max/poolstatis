import type pg from 'pg';
import { ApiError, badRequest } from '../errors.js';
import { isIsoAlpha2Country } from './country.js';
import { createPropertyDefinition, listPropertyDefinitions, type PropertyDefinition } from './properties.js';
import { listMetrics, registerMetric, type Metric } from './registry.js';

type Spec = {
  value_type: 'string' | 'enum';
  purpose: string;
  enum_values?: string[];
};

export const BROWSER_ANALYTICS_PROPERTIES: Record<string, Spec> = {
  $browser_context: {
    value_type: 'enum', enum_values: ['1'],
    purpose: 'Marks events produced by the consent-gated optional browser analytics module for bounded server enrichment.',
  },
  $page_path: {
    value_type: 'string',
    purpose: 'Records the pathname without query string or fragment for privacy-bounded page and route analysis.',
  },
  $device_class: {
    value_type: 'enum', enum_values: ['desktop', 'mobile', 'tablet'],
    purpose: 'Groups browser traffic into coarse device classes for responsive product decisions without device fingerprinting.',
  },
  $browser_family: {
    value_type: 'enum', enum_values: ['chrome', 'safari', 'firefox', 'edge', 'other'],
    purpose: 'Groups browser traffic by coarse browser family without retaining a full user agent or version.',
  },
  $os_family: {
    value_type: 'enum', enum_values: ['android', 'ios', 'macos', 'windows', 'linux', 'other'],
    purpose: 'Groups browser traffic by coarse operating system family without retaining versions or hardware details.',
  },
  $language: {
    value_type: 'string',
    purpose: 'Records the normalized primary browser language for localization decisions without using it as a country proxy.',
  },
  $timezone: {
    value_type: 'string',
    purpose: 'Records a bounded IANA browser timezone for scheduling and localization analysis without inferring country.',
  },
  $viewport_bucket: {
    value_type: 'enum', enum_values: ['xs', 'sm', 'md', 'lg', 'xl'],
    purpose: 'Groups browser viewport width into coarse responsive buckets without retaining precise screen dimensions.',
  },
  $screen_bucket: {
    value_type: 'enum', enum_values: ['xs', 'sm', 'md', 'lg', 'xl'],
    purpose: 'Groups browser screen width into coarse buckets without retaining precise display dimensions.',
  },
  $country: {
    value_type: 'string',
    purpose: 'Records coarse ISO country derived server-side by a trusted proxy for geographic traffic decisions without storing IP.',
  },
};

export async function proposeBrowserAnalyticsProperties(
  pool: pg.Pool,
  projectId: string,
  actor: string,
): Promise<PropertyDefinition[]> {
  const existing = await listPropertyDefinitions(pool, projectId, { scope: 'event' });
  const byKey = new Map(existing.map((property) => [property.key, property]));
  const result: PropertyDefinition[] = [];
  for (const [key, spec] of Object.entries(BROWSER_ANALYTICS_PROPERTIES)) {
    const property = byKey.get(key);
    const expectedEnums = spec.enum_values ?? null;
    if (property) {
      const actualEnums = property.enum_values ?? null;
      if (property.value_type !== spec.value_type || property.source !== 'native'
        || property.purpose !== spec.purpose
        || JSON.stringify(actualEnums) !== JSON.stringify(expectedEnums)) {
        throw new ApiError(
          409,
          'browser_property_conflict',
          `reserved browser property "${key}" has an incompatible definition`,
          'restore the canonical event-scoped native definition before enabling browser analytics',
        );
      }
      result.push(property);
      continue;
    }
    result.push(await createPropertyDefinition(pool, projectId, {
      key,
      scope: 'event',
      value_type: spec.value_type,
      purpose: spec.purpose,
      status: 'proposed',
      source: 'native',
      ...(spec.enum_values ? { enum_values: spec.enum_values } : {}),
    }, actor));
  }
  return result;
}

const BROWSER_METRICS = [
  {
    key: 'web_page_views',
    name: 'Web page views',
    purpose: 'Counts consented privacy-bounded page views to assess website traffic and route demand.',
    type: 'count' as const,
  },
  {
    key: 'web_visitors',
    name: 'Web visitors',
    purpose: 'Counts unique resolved browser actors to compare traffic reach without conflating sessions or page views.',
    type: 'unique_actors' as const,
  },
] as const;
const BROWSER_METRIC_FILTERS = [
  { property: '$browser_context', op: 'eq' as const, value: '1' },
];

export async function proposeBrowserAnalyticsMetrics(
  pool: pg.Pool,
  projectId: string,
  actor: string,
): Promise<Metric[]> {
  const existing = new Map((await listMetrics(pool, projectId)).map((metric) => [metric.key, metric]));
  const result: Metric[] = [];
  for (const spec of BROWSER_METRICS) {
    const metric = existing.get(spec.key);
    if (metric) {
      const source = metric.source as { event?: string; data_source?: string; filters?: unknown[] };
      if (metric.name !== spec.name || metric.purpose !== spec.purpose || metric.type !== spec.type
        || metric.category !== 'acquisition' || source.event !== 'page.viewed'
        || (source.data_source ?? 'native') !== 'native'
        || JSON.stringify(source.filters ?? []) !== JSON.stringify(BROWSER_METRIC_FILTERS)) {
        throw new ApiError(
          409,
          'browser_metric_conflict',
          `reserved browser metric "${spec.key}" has an incompatible definition`,
          'restore the canonical page.viewed metric definition before enabling web analytics',
        );
      }
      result.push(metric);
      continue;
    }
    result.push(await registerMetric(pool, projectId, {
      ...spec,
      category: 'acquisition',
      tags: ['browser-analytics'],
      source: { event: 'page.viewed', filters: BROWSER_METRIC_FILTERS, data_source: 'native' },
    }, actor));
  }
  return result;
}

export async function assertBrowserAnalyticsProperties(
  pool: pg.Pool,
  projectId: string,
  keys: string[],
): Promise<void> {
  const requested = [...new Set(keys.filter((key) => key in BROWSER_ANALYTICS_PROPERTIES))];
  if (requested.length === 0) return;
  const existing = await listPropertyDefinitions(pool, projectId, { scope: 'event' });
  const byKey = new Map(existing.map((property) => [property.key, property]));
  for (const key of requested) {
    const spec = BROWSER_ANALYTICS_PROPERTIES[key]!;
    const property = byKey.get(key);
    if (!property || property.value_type !== spec.value_type || property.purpose !== spec.purpose
      || property.source !== 'native') {
      throw badRequest(
        'browser_property_unregistered',
        `reserved browser property "${key}" must have its canonical event-scoped native definition`,
        'run browser analytics property setup first; definitions start proposed for explicit owner review',
      );
    }
  }
}

function isPrimaryBrowserLanguage(value: string): boolean {
  return value === 'unknown' || /^[a-z]{2,3}$/.test(value);
}

function isIanaTimezone(value: string): boolean {
  if (value === 'unknown') return true;
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z_+-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function validateAndEnrichBrowserProperties(
  properties: Record<string, unknown>,
  sessionId: string | undefined,
  country: string,
): string | null {
  const marker = properties.$browser_context;
  const hasReserved = Object.keys(properties).some((key) => key in BROWSER_ANALYTICS_PROPERTIES);
  if (!hasReserved) return null;
  if (marker !== '1') return '$browser_context must equal "1" when reserved browser properties are present';
  if (!sessionId) return 'session_id is required when browser analytics properties are present';
  if ('$country' in properties) return '$country is server-derived and must not be sent by a client';

  for (const [key, spec] of Object.entries(BROWSER_ANALYTICS_PROPERTIES)) {
    if (key === '$country') continue;
    const value = properties[key];
    if (value === undefined) return `${key} is required in browser analytics context`;
    if (typeof value !== 'string' || value.length === 0 || value.length > (key === '$page_path' ? 512 : 64)) {
      return `${key} must be a bounded non-empty string`;
    }
    if (spec.enum_values && !spec.enum_values.includes(value)) return `${key} has an unsupported value`;
  }
  if (!isPrimaryBrowserLanguage(properties.$language as string)) {
    return '$language must be a normalized primary language or unknown';
  }
  if (!isIanaTimezone(properties.$timezone as string)) {
    return '$timezone must be a recognized IANA timezone or unknown';
  }
  const path = properties.$page_path as string;
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    return '$page_path must be a pathname only, without query string or fragment';
  }
  if (country !== 'unknown' && !isIsoAlpha2Country(country)) {
    return 'resolved country must be unknown or ISO alpha-2';
  }
  properties.$country = country;
  return null;
}
