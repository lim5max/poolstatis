import type pg from 'pg';
import type { EntityStatusEvidenceSpec, EventStore } from '../stores/eventStore.js';
import { listMetrics, type Metric } from './registry.js';

const TERMINAL_STATUS_ACTIONS = new Set([
  'completed',
  'finished',
  'published',
  'submitted',
  'sent',
  'activated',
  'failed',
  'cancelled',
  'canceled',
  'archived',
]);

export interface DataQualityIssue {
  kind: 'entity_event_status_conflict';
  severity: 'warning';
  entity_type: string;
  entity_id: string;
  current_status: string;
  expected_status: string;
  event: string;
  evidence_events: number;
  last_event_at: string;
  entity_updated_at: string;
  message: string;
}

interface ListDataQualityOptions {
  limit?: number;
  sinceDays?: number;
}

export async function listDataQualityIssues(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  env: string,
  options: ListDataQualityOptions = {},
): Promise<{ issues: DataQualityIssue[]; checked: { terminal_event_specs: number; evidence_rows: number } }> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const sinceDays = Math.max(1, Math.min(options.sinceDays ?? 30, 365));
  const specs = await entityStatusSpecs(pool, projectId);
  const evidence = await eventStore.entityStatusEvidence({
    projectId,
    env,
    specs,
    sinceDays,
    limit,
  });

  const issues = evidence.issues.map((ev) => ({
      kind: 'entity_event_status_conflict',
      severity: 'warning',
      entity_type: ev.entity_type,
      entity_id: ev.entity_id,
      current_status: ev.current_status,
      expected_status: ev.expected_status,
      event: ev.event,
      evidence_events: ev.evidence_events,
      last_event_at: ev.last_event_at,
      entity_updated_at: ev.entity_updated_at,
      message: `${ev.event} exists for ${ev.entity_type}:${ev.entity_id}, but current entity status is "${ev.current_status}".`,
    } satisfies DataQualityIssue));

  return {
    issues,
    checked: {
      terminal_event_specs: specs.length,
      evidence_rows: evidence.matchedEntities,
    },
  };
}

async function entityStatusSpecs(pool: pg.Pool, projectId: string): Promise<EntityStatusEvidenceSpec[]> {
  const metrics = await listMetrics(pool, projectId, { status: 'active' });
  const specs = new Map<string, EntityStatusEvidenceSpec>();
  for (const metric of metrics) {
    const spec = specFromMetric(metric);
    if (spec) specs.set(spec.event, spec);
  }
  return [...specs.values()];
}

function specFromMetric(metric: Metric): EntityStatusEvidenceSpec | null {
  if (metric.type === 'conversion' || metric.type === 'state') return null;
  const event = typeof metric.source.event === 'string' ? metric.source.event : '';
  const match = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(event);
  if (!match) return null;
  const [, entityType, action] = match;
  if (!entityType || !action || !TERMINAL_STATUS_ACTIONS.has(action)) return null;
  return { event, entity_type: entityType, expected_status: action };
}
