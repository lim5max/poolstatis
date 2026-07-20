import type pg from 'pg';
import type { EventStore } from '../stores/eventStore.js';
import type { MeasurementTrustInput, PropertyFilter } from '../schemas.js';
import { getMetric } from './registry.js';
import { listPropertyDefinitions, type PropertyDefinition } from './properties.js';
import type { PostHogAdapter } from './posthog.js';

export interface TrustFinding {
  code: string;
  message: string;
  next_action: string;
}

export interface MeasurementTrust {
  status: 'trusted' | 'untrusted';
  primary_metric: {
    key: string;
    purpose: string;
    category: string | null;
    observed_events: number;
    observed_actors: number;
    registered_coverage: number;
  };
  identity: {
    distinct_id_coverage: number;
    raw_actors: number;
    resolved_actors: number;
  };
  properties: Array<{
    key: string;
    status: 'missing' | PropertyDefinition['status'];
    purpose: string | null;
    coverage: number;
  }>;
  blockers: TrustFinding[];
  warnings: TrustFinding[];
}

export async function assessMeasurementTrust(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  input: MeasurementTrustInput,
  posthog?: PostHogAdapter,
): Promise<MeasurementTrust> {
  const metric = await getMetric(pool, projectId, input.metric_key);
  const blockers: TrustFinding[] = [];
  const warnings: TrustFinding[] = [];
  if (metric.status !== 'active') {
    blockers.push(finding(
      'primary_metric_inactive',
      'The primary metric is not active.',
      'Review and activate the metric before evaluating a product change.',
    ));
  }
  if (metric.type === 'conversion' || metric.type === 'state') {
    blockers.push(finding(
      'primary_metric_incompatible',
      'This metric type cannot yet produce decision-loop evidence.',
      'Use an active count, unique_actors or value metric.',
    ));
  }

  const source = metric.source as {
    event?: string;
    filters?: PropertyFilter[];
    data_source?: 'native' | 'posthog';
    source_connection_id?: string;
  };
  const propertyKeys = [...new Set(input.target_filters.map((filter) => filter.property))];
  let coverage;
  if (source.event && source.data_source === 'posthog' && source.source_connection_id && posthog) {
    try {
      coverage = await posthog.aggregate({
        projectId,
        connectionId: source.source_connection_id,
        metricKey: metric.key,
        windowName: 'observed',
        event: source.event,
        filters: source.filters ?? [],
        properties: propertyKeys,
        agg: metric.type === 'unique_actors' ? 'unique_actors' : metric.type === 'count' ? 'count' : 'value',
        from: new Date(Date.now() - input.since_days * 86_400_000),
        to: new Date(),
      });
    } catch (error) {
      blockers.push(finding(
        'external_source_unavailable',
        `PostHog trust evidence could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
        'Verify the source and use a supported metric definition before deciding.',
      ));
    }
  } else if (source.event && source.data_source !== 'posthog') {
    coverage = await eventStore.measurementCoverage({
        projectId,
        env: input.env,
        event: source.event,
        filters: source.filters ?? [],
        properties: propertyKeys,
        sinceDays: input.since_days,
      });
  }
  coverage ??= {
        events: 0,
        actors: 0,
        rawActors: 0,
        registeredCoverage: 0,
        distinctIdCoverage: 0,
        propertyCoverage: {},
      };
  if (coverage.events === 0) {
    blockers.push(finding(
      'primary_metric_no_observations',
      'No real event has been observed for the primary metric in this environment.',
      'Send a real product event and rerun the trust check.',
    ));
  }
  if (coverage.events > 0 && coverage.registeredCoverage < 1) {
    blockers.push(finding(
      'primary_metric_unregistered_evidence',
      'Some observed source events were not covered by an active registry metric.',
      'Verify the active metric source and ingest new registered evidence.',
    ));
  }
  if (coverage.distinctIdCoverage < 1) {
    blockers.push(finding(
      'distinct_id_missing',
      'Some source events have no stable actor identifier.',
      'Instrument a stable distinct_id or add explicit actor links.',
    ));
  }

  const definitions = await listPropertyDefinitions(pool, projectId, { scope: 'event' });
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const properties = propertyKeys.map((key) => {
    const definition = byKey.get(key);
    const propertyCoverage = coverage.propertyCoverage[key] ?? 0;
    if (!definition || definition.status !== 'trusted') {
      blockers.push(finding(
        'target_property_untrusted',
        `Target property "${key}" has no trusted measurement meaning.`,
        'Register the property purpose and explicitly mark it trusted after review.',
      ));
    } else if (propertyCoverage < 0.9) {
      warnings.push(finding(
        'target_property_low_coverage',
        `Target property "${key}" is present on ${Math.round(propertyCoverage * 100)}% of source events.`,
        'Check whether missing values bias the target segment before deciding.',
      ));
    }
    const status: 'missing' | PropertyDefinition['status'] = definition?.status ?? 'missing';
    return {
      key,
      status,
      purpose: definition?.purpose ?? null,
      coverage: propertyCoverage,
    };
  });

  return {
    status: blockers.length === 0 ? 'trusted' : 'untrusted',
    primary_metric: {
      key: metric.key,
      purpose: metric.purpose,
      category: metric.category,
      observed_events: coverage.events,
      observed_actors: coverage.actors,
      registered_coverage: coverage.registeredCoverage,
    },
    identity: {
      distinct_id_coverage: coverage.distinctIdCoverage,
      raw_actors: coverage.rawActors,
      resolved_actors: coverage.actors,
    },
    properties,
    blockers,
    warnings,
  };
}

function finding(code: string, message: string, nextAction: string): TrustFinding {
  return { code, message, next_action: nextAction };
}
