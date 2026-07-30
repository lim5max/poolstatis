import type pg from 'pg';
import { ApiError, badRequest } from '../errors.js';
import {
  ACQUISITION_UTM_PROPERTIES,
  acquisitionPropertyPlans,
  isSafeRouteKey,
  proposeAcquisitionProperties,
} from './acquisitionAttribution.js';
import {
  createPropertyDefinition,
  listPropertyDefinitions,
  type PropertyDefinition,
} from './properties.js';
import {
  listMetrics,
  registerMetric,
  updateMetric,
  type Metric,
} from './registry.js';

type Queryable = pg.Pool | pg.PoolClient;

type BrowserPropertySpec = {
  value_type: 'string' | 'enum';
  purpose: string;
  enum_values?: string[];
};

export const BROWSER_ANALYTICS_PROPERTIES: Record<string, BrowserPropertySpec> = {
  $browser_context: {
    value_type: 'enum',
    enum_values: ['1'],
    purpose: 'Marks canonical events produced by the consent-gated privacy-safe browser analytics module.',
  },
  $route_key: {
    value_type: 'enum',
    purpose: 'Records a host-mapped finite safe route key without URL, query, hash, dynamic identifier or secret.',
  },
  $page_view_id: {
    value_type: 'string',
    purpose: 'Links one canonical page view to its bounded cumulative engagement snapshots without replay data.',
  },
  $device_class: {
    value_type: 'enum',
    enum_values: ['desktop', 'mobile', 'tablet'],
    purpose: 'Groups traffic into coarse device classes without device fingerprinting.',
  },
  $browser_family: {
    value_type: 'enum',
    enum_values: ['chrome', 'safari', 'firefox', 'edge', 'other'],
    purpose: 'Groups traffic by coarse browser family without retaining user agent or version.',
  },
  $os_family: {
    value_type: 'enum',
    enum_values: ['android', 'ios', 'macos', 'windows', 'linux', 'other'],
    purpose: 'Groups traffic by coarse operating-system family without retaining version or hardware detail.',
  },
  $language: {
    value_type: 'string',
    purpose: 'Records a normalized primary browser language for localization analysis without country inference.',
  },
  $timezone: {
    value_type: 'string',
    purpose: 'Records a bounded IANA timezone for scheduling analysis without country inference.',
  },
  $viewport_bucket: {
    value_type: 'enum',
    enum_values: ['xs', 'sm', 'md', 'lg', 'xl'],
    purpose: 'Groups viewport width into coarse responsive buckets without precise dimensions.',
  },
  $screen_bucket: {
    value_type: 'enum',
    enum_values: ['xs', 'sm', 'md', 'lg', 'xl'],
    purpose: 'Groups screen width into coarse buckets without precise display dimensions.',
  },
};

interface BrowserPropertyPlan {
  key: string;
  spec: BrowserPropertySpec;
  property?: PropertyDefinition;
}

export async function browserAnalyticsPropertyPlans(
  pool: Queryable,
  projectId: string,
  routeKeys: string[],
): Promise<BrowserPropertyPlan[]> {
  const existing = new Map(
    (await listPropertyDefinitions(pool, projectId, { scope: 'event' }))
      .map((property) => [property.key, property]),
  );
  return Object.entries(BROWSER_ANALYTICS_PROPERTIES).map(([key, spec]) => {
    const expectedSpec = key === '$route_key' ? { ...spec, enum_values: routeKeys } : spec;
    const property = existing.get(key);
    const expectedEnums = spec.enum_values ?? null;
    if (property && (
      property.value_type !== expectedSpec.value_type
      || property.source !== 'native'
      || property.purpose !== expectedSpec.purpose
      || JSON.stringify(property.enum_values) !== JSON.stringify(
        expectedSpec.enum_values ?? expectedEnums,
      )
    )) {
      throw new ApiError(
        409,
        'browser_property_conflict',
        `reserved browser property "${key}" has an incompatible definition`,
        'restore the canonical event-scoped native definition before setup',
      );
    }
    return { key, spec: expectedSpec, ...(property ? { property } : {}) };
  });
}

async function proposeBrowserAnalyticsProperties(
  pool: Queryable,
  projectId: string,
  actor: string,
  plans: BrowserPropertyPlan[],
): Promise<PropertyDefinition[]> {
  const properties: PropertyDefinition[] = [];
  for (const plan of plans) {
    properties.push(plan.property ?? await createPropertyDefinition(pool, projectId, {
      key: plan.key,
      scope: 'event',
      value_type: plan.spec.value_type,
      purpose: plan.spec.purpose,
      status: 'proposed',
      source: 'native',
      ...(plan.spec.enum_values ? { enum_values: plan.spec.enum_values } : {}),
    }, actor));
  }
  return properties;
}

const BROWSER_METRICS = [
  {
    key: 'web_page_views',
    name: 'Web page views',
    purpose: 'Counts consented canonical page views to assess traffic and demand across trusted safe routes.',
    type: 'count' as const,
  },
  {
    key: 'web_visitors',
    name: 'Web visitors',
    purpose: 'Counts unique resolved actors with canonical page views without conflating visitors and sessions.',
    type: 'unique_actors' as const,
  },
] as const;

const CANONICAL_BROWSER_FILTER = {
  property: '$browser_context',
  op: 'eq' as const,
  value: '1',
};

interface BrowserMetricPlan {
  spec: (typeof BROWSER_METRICS)[number];
  metric?: Metric;
}

function canonicalBrowserFilter(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  return Object.keys(filter).length === 3
    && filter.property === '$browser_context'
    && filter.op === 'eq'
    && filter.value === '1';
}

async function browserAnalyticsMetricPlans(
  pool: Queryable,
  projectId: string,
): Promise<BrowserMetricPlan[]> {
  const existing = new Map((await listMetrics(pool, projectId)).map((metric) => [metric.key, metric]));
  return BROWSER_METRICS.map((spec) => {
    const metric = existing.get(spec.key);
    if (!metric) return { spec };
    const source = metric.source as {
      event?: unknown;
      filters?: unknown[];
      data_source?: unknown;
      source_connection_id?: unknown;
    };
    const filters = source.filters ?? [];
    const compatibleFilters = filters.length === 0
      || (filters.length === 1 && canonicalBrowserFilter(filters[0]));
    const unexpectedSource = Object.keys(source)
      .some((key) => !['event', 'filters', 'data_source'].includes(key));
    if (metric.type !== spec.type
      || !['active', 'proposed'].includes(metric.status)
      || source.event !== 'page.viewed'
      || (source.data_source ?? 'native') !== 'native'
      || source.source_connection_id !== undefined
      || unexpectedSource
      || !compatibleFilters) {
      throw new ApiError(
        409,
        'browser_metric_conflict',
        `reserved browser metric "${spec.key}" has an incompatible definition`,
        'restore a compatible native page.viewed definition before setup',
      );
    }
    return { spec, metric };
  });
}

async function proposeBrowserAnalyticsMetrics(
  pool: Queryable,
  projectId: string,
  actor: string,
  plans: BrowserMetricPlan[],
): Promise<Metric[]> {
  const metrics: Metric[] = [];
  for (const plan of plans) {
    const tags = [...new Set([...(plan.metric?.tags ?? []), 'browser-analytics'])];
    if (!plan.metric) {
      metrics.push(await registerMetric(pool, projectId, {
        ...plan.spec,
        category: 'acquisition',
        tags,
        source: {
          event: 'page.viewed',
          filters: [CANONICAL_BROWSER_FILTER],
          data_source: 'native',
        },
      }, actor));
      continue;
    }
    const source = plan.metric.source as { filters?: unknown[] };
    const alreadyCanonical = plan.metric.name === plan.spec.name
      && plan.metric.purpose === plan.spec.purpose
      && plan.metric.category === 'acquisition'
      && plan.metric.tags.length === tags.length
      && plan.metric.tags.every((tag, index) => tag === tags[index])
      && source.filters?.length === 1
      && canonicalBrowserFilter(source.filters[0]);
    metrics.push(alreadyCanonical ? plan.metric : await updateMetric(pool, projectId, plan.spec.key, {
      name: plan.spec.name,
      purpose: plan.spec.purpose,
      category: 'acquisition',
      tags,
      source: {
        event: 'page.viewed',
        filters: [CANONICAL_BROWSER_FILTER],
        data_source: 'native',
      },
    }));
  }
  return metrics;
}

export interface BrowserAnalyticsSetupResult {
  properties: PropertyDefinition[];
  metrics: Metric[];
}

const RETRYABLE_SETUP_CODES = new Set(['40001', '40P01']);

export function isRetryableBrowserSetupError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && RETRYABLE_SETUP_CODES.has((error as { code?: string }).code ?? '');
}

/**
 * Serialized all-or-nothing registry setup. The session advisory lock is held
 * across bounded SERIALIZABLE retries; callers invalidate caches only after
 * this function returns a committed bundle.
 */
export async function setupBrowserAnalytics(
  pool: pg.Pool,
  projectId: string,
  actor: string,
  routeKeys: string[],
): Promise<BrowserAnalyticsSetupResult> {
  return runSerializedBrowserSetup(
    pool,
    `browser-analytics-setup:${projectId}`,
    async (client) => {
      // Full preflight before the first write.
      const browserProperties = await browserAnalyticsPropertyPlans(client, projectId, routeKeys);
      const acquisitionProperties = await acquisitionPropertyPlans(client, projectId);
      const browserMetrics = await browserAnalyticsMetricPlans(client, projectId);
      const properties = [
        ...await proposeBrowserAnalyticsProperties(
          client,
          projectId,
          actor,
          browserProperties,
        ),
        ...await proposeAcquisitionProperties(
          client,
          projectId,
          actor,
          acquisitionProperties,
        ),
      ];
      const metrics = await proposeBrowserAnalyticsMetrics(
        client,
        projectId,
        actor,
        browserMetrics,
      );
      return { properties, metrics };
    },
  );
}

export async function runSerializedBrowserSetup<T>(
  pool: Pick<pg.Pool, 'connect'>,
  lockKey: string,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let failure: unknown;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    locked = true;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (!isRetryableBrowserSetupError(error)) throw error;
        if (attempt === 3) {
          throw new ApiError(
            503,
            'browser_setup_retryable',
            'browser analytics setup could not obtain a stable serializable transaction',
            'retry the same idempotent setup request shortly',
            { retryable: true },
          );
        }
      }
    }
    throw new Error('browser analytics setup retry loop ended unexpectedly');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [lockKey],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          releaseError = new Error('browser analytics setup advisory lock could not be released');
        }
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(releaseError);
    if (releaseError && failure === undefined) throw releaseError;
  }
}

const MAX_DURATION_MS = 7 * 24 * 60 * 60_000;
const MAX_SEQUENCE = 2_147_483_647;
const TERMINAL_REASONS = new Set([
  'visibility_hidden',
  'blur',
  'route_change',
  'pagehide',
  'freeze',
  'duration_rollover',
  'destroy',
]);
const ALL_REASONS = new Set([...TERMINAL_REASONS, 'heartbeat']);
const CONTEXT_ENUMS: Record<string, Set<string>> = {
  $browser_context: new Set(['1']),
  $device_class: new Set(['desktop', 'mobile', 'tablet']),
  $browser_family: new Set(['chrome', 'safari', 'firefox', 'edge', 'other']),
  $os_family: new Set(['android', 'ios', 'macos', 'windows', 'linux', 'other']),
  $viewport_bucket: new Set(['xs', 'sm', 'md', 'lg', 'xl']),
  $screen_bucket: new Set(['xs', 'sm', 'md', 'lg', 'xl']),
};
const COMMON_PROPERTIES = new Set([
  ...Object.keys(BROWSER_ANALYTICS_PROPERTIES),
  ...ACQUISITION_UTM_PROPERTIES,
  'landing_route',
  'referrer_origin',
]);
const PAGE_VIEW_PROPERTIES = new Set(COMMON_PROPERTIES);
const PAGE_ENGAGEMENT_PROPERTIES = new Set([
  ...COMMON_PROPERTIES,
  'sequence',
  'foreground_ms',
  'elapsed_ms',
  'max_scroll_pct',
  'interaction_count',
  'reason',
]);
const BROWSER_ONLY_PROPERTIES = new Set([
  ...Object.keys(BROWSER_ANALYTICS_PROPERTIES),
  'sequence',
  'foreground_ms',
  'elapsed_ms',
  'max_scroll_pct',
  'interaction_count',
  'reason',
]);

export function validateBrowserAnalyticsProperties(
  event: string,
  properties: Record<string, unknown>,
  sessionId: string | undefined,
  safeRouteKeys?: ReadonlySet<string> | null,
): string | null {
  const marker = properties.$browser_context;
  // Legacy/manual page events stay accepted and never acquire browser meaning.
  if (event === 'page.viewed' && marker === undefined) return null;
  if (marker !== undefined && event !== 'page.viewed' && event !== 'page.engagement') {
    return '$browser_context is forbidden on custom product events; use the neutral base SDK path';
  }
  if (event !== 'page.viewed' && event !== 'page.engagement') {
    const reserved = Object.keys(properties).find((key) => BROWSER_ONLY_PROPERTIES.has(key));
    return reserved
      ? `${reserved} is reserved for canonical browser analytics events`
      : null;
  }
  if (marker !== '1') return '$browser_context must equal "1" on canonical browser events';
  if (!sessionId) return 'session_id is required on canonical browser events';
  const allowed = event === 'page.viewed' ? PAGE_VIEW_PROPERTIES : PAGE_ENGAGEMENT_PROPERTIES;
  const unsupported = Object.keys(properties).find((key) => !allowed.has(key));
  if (unsupported) return `${unsupported} is not allowed on canonical ${event} events`;
  if (!isSafeRouteKey(properties.$route_key)) {
    return '$route_key must be a finite safe route key without URL or dynamic path data';
  }
  if (!safeRouteKeys?.has(properties.$route_key)) {
    return '$route_key must belong to the trusted finite browser route vocabulary';
  }
  if (typeof properties.$page_view_id !== 'string'
    || properties.$page_view_id.length === 0
    || properties.$page_view_id.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(properties.$page_view_id)) {
    return '$page_view_id must be an opaque identifier, not a URL, path or query payload';
  }
  for (const [key, values] of Object.entries(CONTEXT_ENUMS)) {
    const value = properties[key];
    if (value !== undefined && (typeof value !== 'string' || !values.has(value))) {
      return `${key} has an unsupported value`;
    }
  }
  if (properties.$language !== undefined
    && (typeof properties.$language !== 'string'
      || !/^(unknown|[a-z]{2,3})$/.test(properties.$language))) {
    return '$language must be a primary language or unknown';
  }
  if (properties.$timezone !== undefined
    && (typeof properties.$timezone !== 'string'
      || properties.$timezone.length > 64
      || !/^(unknown|[A-Za-z_+-]+(?:\/[A-Za-z_+-]+){0,2})$/.test(properties.$timezone))) {
    return '$timezone must be a bounded IANA timezone or unknown';
  }
  if (event === 'page.engagement') {
    for (const key of ['sequence', 'interaction_count'] as const) {
      if (!boundedInteger(properties[key], 0, MAX_SEQUENCE)) {
        return `${key} must be an integer from 0 to ${MAX_SEQUENCE}`;
      }
    }
    if ((properties.sequence as number) < 1) return 'sequence must be at least 1';
    for (const key of ['foreground_ms', 'elapsed_ms'] as const) {
      if (!boundedInteger(properties[key], 0, MAX_DURATION_MS)) {
        return `${key} must be an integer from 0 to ${MAX_DURATION_MS}`;
      }
    }
    if ((properties.foreground_ms as number) > (properties.elapsed_ms as number)) {
      return 'foreground_ms must not exceed elapsed_ms';
    }
    if (!boundedInteger(properties.max_scroll_pct, 0, 100)) {
      return 'max_scroll_pct must be an integer from 0 to 100';
    }
    if (typeof properties.reason !== 'string' || !ALL_REASONS.has(properties.reason)) {
      return 'reason must be a supported page engagement lifecycle reason';
    }
  }
  return null;
}

export async function assertTrustedSafeRoute(
  pool: Queryable,
  projectId: string,
): Promise<Set<string>> {
  const vocabulary = await browserRouteVocabulary(pool, projectId);
  if (!vocabulary) {
    throw badRequest(
      'safe_route_unavailable',
      'route analysis requires a trusted canonical finite $route_key vocabulary',
      'run setup with the complete finite route vocabulary, then review and trust its definition',
    );
  }
  return vocabulary;
}

export async function browserRouteVocabulary(
  pool: Queryable,
  projectId: string,
): Promise<Set<string> | null> {
  const property = (await listPropertyDefinitions(pool, projectId, { scope: 'event' }))
    .find((candidate) => candidate.key === '$route_key');
  const values = property?.enum_values;
  const spec = BROWSER_ANALYTICS_PROPERTIES.$route_key!;
  if (!property
    || property.status !== 'trusted'
    || property.source !== 'native'
    || property.value_type !== 'enum'
    || property.purpose !== spec.purpose
    || !values
    || values.length === 0
    || values.length > 100
    || values.some((value) => !isSafeRouteKey(value))) {
    return null;
  }
  return new Set(values);
}

function boundedInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= min
    && value <= max;
}
