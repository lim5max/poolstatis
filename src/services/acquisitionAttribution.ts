import type pg from 'pg';
import { ApiError, badRequest } from '../errors.js';
import {
  createPropertyDefinition,
  listPropertyDefinitions,
  type PropertyDefinition,
} from './properties.js';

type Queryable = pg.Pool | pg.PoolClient;

export const ACQUISITION_UTM_PROPERTIES = [
  '$utm_source',
  '$utm_medium',
  '$utm_campaign',
  '$utm_term',
  '$utm_content',
] as const;

export const ACQUISITION_PURPOSE: Record<(typeof ACQUISITION_UTM_PROPERTIES)[number], string> = {
  $utm_source: 'Records the consented session landing source for bounded acquisition analysis, never causal campaign credit.',
  $utm_medium: 'Records the consented session landing medium for bounded acquisition analysis, never causal campaign credit.',
  $utm_campaign: 'Records the consented session landing campaign for bounded acquisition analysis, never causal campaign credit.',
  $utm_term: 'Records the consented session landing term for bounded acquisition analysis, never causal campaign credit.',
  $utm_content: 'Records the consented session landing content for bounded acquisition analysis, never causal campaign credit.',
};

interface Plan {
  key: (typeof ACQUISITION_UTM_PROPERTIES)[number];
  property?: PropertyDefinition;
}

export async function acquisitionPropertyPlans(
  pool: Queryable,
  projectId: string,
): Promise<Plan[]> {
  const existing = new Map(
    (await listPropertyDefinitions(pool, projectId, { scope: 'event' }))
      .map((property) => [property.key, property]),
  );
  return ACQUISITION_UTM_PROPERTIES.map((key) => {
    const property = existing.get(key);
    if (property && (
      property.value_type !== 'string'
      || property.source !== 'native'
      || property.purpose !== ACQUISITION_PURPOSE[key]
    )) {
      throw new ApiError(
        409,
        'acquisition_property_conflict',
        `reserved acquisition property "${key}" has an incompatible definition`,
        'restore the canonical event-scoped native string definition before setup',
      );
    }
    return { key, ...(property ? { property } : {}) };
  });
}

export async function proposeAcquisitionProperties(
  pool: Queryable,
  projectId: string,
  actor: string,
  plans?: Plan[],
): Promise<PropertyDefinition[]> {
  const resolvedPlans = plans ?? await acquisitionPropertyPlans(pool, projectId);
  const properties: PropertyDefinition[] = [];
  for (const plan of resolvedPlans) {
    properties.push(plan.property ?? await createPropertyDefinition(pool, projectId, {
      key: plan.key,
      scope: 'event',
      value_type: 'string',
      purpose: ACQUISITION_PURPOSE[plan.key],
      status: 'proposed',
      source: 'native',
    }, actor));
  }
  return properties;
}

export async function assertTrustedAcquisitionProperties(
  pool: Queryable,
  projectId: string,
  keys: string[],
): Promise<void> {
  const requested = [...new Set(keys.filter((key) =>
    ACQUISITION_UTM_PROPERTIES.includes(key as (typeof ACQUISITION_UTM_PROPERTIES)[number])))];
  if (requested.length === 0) return;
  const definitions = new Map(
    (await listPropertyDefinitions(pool, projectId, { scope: 'event' }))
      .map((property) => [property.key, property]),
  );
  for (const key of requested) {
    const property = definitions.get(key);
    if (!property || property.status !== 'trusted'
      || property.value_type !== 'string'
      || property.source !== 'native'
      || property.purpose !== ACQUISITION_PURPOSE[key as keyof typeof ACQUISITION_PURPOSE]) {
      throw badRequest(
        'acquisition_property_untrusted',
        `reserved acquisition property "${key}" must be a trusted canonical event property`,
        'review and trust the setup definition before using it in customer-facing analysis',
      );
    }
  }
}

/**
 * Backward-compatible guard for generic Trend queries. E1 Web analytics uses
 * the stricter trusted guard above; existing registry-driven product queries
 * may continue to read canonical proposed definitions while owners review
 * them.
 */
export async function assertRegisteredAcquisitionProperties(
  pool: Queryable,
  projectId: string,
  keys: string[],
): Promise<void> {
  const requested = [...new Set(keys.filter((key) =>
    ACQUISITION_UTM_PROPERTIES.includes(key as (typeof ACQUISITION_UTM_PROPERTIES)[number])))];
  if (requested.length === 0) return;
  const definitions = new Map(
    (await listPropertyDefinitions(pool, projectId, { scope: 'event' }))
      .map((property) => [property.key, property]),
  );
  for (const key of requested) {
    const property = definitions.get(key);
    if (!property
      || property.value_type !== 'string'
      || property.source !== 'native'
      || property.purpose !== ACQUISITION_PURPOSE[key as keyof typeof ACQUISITION_PURPOSE]) {
      throw badRequest(
        'acquisition_property_unregistered',
        `reserved acquisition property "${key}" must have its canonical event definition`,
        'run browser acquisition setup before querying this reserved property',
      );
    }
  }
}

export function validateAcquisitionProperties(
  properties: Record<string, unknown>,
  sessionId: string | undefined,
  safeRouteKeys?: ReadonlySet<string> | null,
): string | null {
  if ('landing_path' in properties) {
    return 'landing_path is forbidden; use a finite safe landing_route key';
  }
  const reserved = [...ACQUISITION_UTM_PROPERTIES, 'landing_route', 'referrer_origin'];
  if (reserved.some((key) => key in properties) && !sessionId) {
    return 'session_id is required when acquisition properties are present';
  }
  for (const key of ACQUISITION_UTM_PROPERTIES) {
    const value = properties[key];
    if (value === undefined) continue;
    if (typeof value !== 'string'
      || value.length === 0
      || value.length > 256
      || value.normalize('NFC') !== value
      || value.trim() !== value
      || !/^[\p{L}\p{N}][\p{L}\p{N} ._~:@+,-]{0,255}$/u.test(value)) {
      return `${key} must be a bounded NFC attribution label, not a URL, path or query payload`;
    }
  }
  const landingRoute = properties.landing_route;
  if (landingRoute !== undefined && !isSafeRouteKey(landingRoute)) {
    return 'landing_route must be a registered-style safe route key';
  }
  if (landingRoute !== undefined && !safeRouteKeys?.has(landingRoute)) {
    return 'landing_route must belong to the trusted finite browser route vocabulary';
  }
  const origin = properties.referrer_origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string' || origin.length > 255) return 'referrer_origin must be a bounded origin';
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin
        || !['http:', 'https:'].includes(parsed.protocol)
        || isIpLiteralHostname(parsed.hostname)) {
        return 'referrer_origin must be an HTTP(S) origin only';
      }
    } catch {
      return 'referrer_origin must be an HTTP(S) origin only';
    }
  }
  return null;
}

export function isSafeRouteKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_.:-]{0,99}$/.test(value);
}

function isIpLiteralHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(unwrapped);
}
