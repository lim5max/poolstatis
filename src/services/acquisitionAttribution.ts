import type pg from 'pg';
import { ApiError, badRequest } from '../errors.js';
import { createPropertyDefinition, listPropertyDefinitions, type PropertyDefinition } from './properties.js';

type Queryable = pg.Pool | pg.PoolClient;

export const ACQUISITION_UTM_PROPERTIES = [
  '$utm_source', '$utm_medium', '$utm_campaign', '$utm_term', '$utm_content',
] as const;

export const ACQUISITION_PURPOSE: Record<(typeof ACQUISITION_UTM_PROPERTIES)[number], string> = {
  $utm_source: 'Records the browser landing publisher or referring source for bounded session acquisition analysis.',
  $utm_medium: 'Records the browser landing channel or medium for bounded session acquisition analysis.',
  $utm_campaign: 'Records the browser landing campaign identifier for bounded session acquisition analysis.',
  $utm_term: 'Records the intentionally supplied browser landing paid-search term for bounded session acquisition analysis.',
  $utm_content: 'Records the browser landing creative or placement variant for bounded session acquisition analysis.',
};

type AcquisitionPropertyPlan = {
  key: (typeof ACQUISITION_UTM_PROPERTIES)[number];
  property: PropertyDefinition | undefined;
};

async function acquisitionPropertyPlans(
  pool: Queryable,
  projectId: string,
): Promise<AcquisitionPropertyPlan[]> {
  const existing = await listPropertyDefinitions(pool, projectId, { scope: 'event' });
  const byKey = new Map(existing.map((property) => [property.key, property]));
  return ACQUISITION_UTM_PROPERTIES.map((key) => {
    const property = byKey.get(key);
    if (property && (property.value_type !== 'string'
      || property.source !== 'native'
      || property.purpose !== ACQUISITION_PURPOSE[key])) {
      throw new ApiError(409, 'acquisition_property_conflict', `reserved attribution property "${key}" has an incompatible definition`, 'use an event-scoped native string definition before enabling browser acquisition attribution');
    }
    return { key, property };
  });
}

export async function preflightAcquisitionProperties(
  pool: Queryable,
  projectId: string,
): Promise<void> {
  await acquisitionPropertyPlans(pool, projectId);
}

export async function proposeAcquisitionProperties(
  pool: Queryable,
  projectId: string,
  actor: string,
): Promise<PropertyDefinition[]> {
  const plans = await acquisitionPropertyPlans(pool, projectId);
  const result: PropertyDefinition[] = [];
  for (const { key, property } of plans) {
    if (property) {
      result.push(property);
      continue;
    }
    result.push(await createPropertyDefinition(pool, projectId, {
      key,
      scope: 'event',
      value_type: 'string',
      purpose: ACQUISITION_PURPOSE[key],
      status: 'proposed',
      source: 'native',
    }, actor));
  }
  return result;
}

/** Query-time guard for the reserved UTM namespace; other existing filters remain backward-compatible. */
export async function assertRegisteredAcquisitionProperties(
  pool: pg.Pool,
  projectId: string,
  keys: string[],
): Promise<void> {
  const requested = [...new Set(keys.filter((key) => ACQUISITION_UTM_PROPERTIES.includes(key as (typeof ACQUISITION_UTM_PROPERTIES)[number])))];
  if (requested.length === 0) return;
  const definitions = await listPropertyDefinitions(pool, projectId, { scope: 'event' });
  const byKey = new Map(definitions.map((property) => [property.key, property]));
  for (const key of requested) {
    const property = byKey.get(key);
    if (!property || property.value_type !== 'string' || property.source !== 'native' || property.purpose !== ACQUISITION_PURPOSE[key as (typeof ACQUISITION_UTM_PROPERTIES)[number]]) {
      throw badRequest('acquisition_property_unregistered', `reserved attribution property "${key}" must have an event-scoped native string definition`, 'run the acquisition property setup first; definitions start proposed and need explicit trust before a decision contract uses them');
    }
  }
}

/** Enforce that reserved fields stay bounded and never carry full URLs. */
export function validateAcquisitionProperties(properties: Record<string, unknown>, sessionId: string | undefined): string | null {
  const reserved = [...ACQUISITION_UTM_PROPERTIES, 'landing_path', 'referrer_origin'];
  const present = reserved.some((key) => key in properties);
  if (present && !sessionId) return 'session_id is required when acquisition attribution properties are present';
  for (const key of ACQUISITION_UTM_PROPERTIES) {
    const value = properties[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.normalize('NFC') !== value) {
      return `${key} must be a non-empty NFC string of at most 256 characters`;
    }
  }
  const path = properties.landing_path;
  if (path !== undefined && (typeof path !== 'string' || path.length === 0 || path.length > 2000 || !path.startsWith('/') || path.includes('?') || path.includes('#'))) {
    return 'landing_path must be a pathname only, without a query string or hash';
  }
  const origin = properties.referrer_origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string') return 'referrer_origin must be a URL origin only';
    try {
      if (new URL(origin).origin !== origin) return 'referrer_origin must be a URL origin only';
    } catch { return 'referrer_origin must be a URL origin only'; }
  }
  return null;
}
