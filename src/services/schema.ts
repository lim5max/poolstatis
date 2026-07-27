import type pg from 'pg';
import type { EventStore } from '../stores/eventStore.js';
import { listActorLinks } from './identity.js';
import { listSourceConnections } from './posthog.js';
import { listPropertyDefinitions } from './properties.js';
import { listEntityTypes, listFunnels, listMetrics } from './registry.js';
import { listMetricCategories } from './metricCategories.js';

/**
 * The live project schema: everything an agent needs to reason about a
 * project in one read — registry, funnels, entity types, and the actual
 * event names seen in the last 30 days with their registered share.
 */
export async function getProjectSchema(
  pool: pg.Pool,
  eventStore: EventStore,
  project: { id: string; slug: string; name: string },
  env: string,
): Promise<Record<string, unknown>> {
  const [metrics, metricCategories, funnels, entityTypes, observedEvents, properties, actorLinks, sources] = await Promise.all([
    listMetrics(pool, project.id),
    listMetricCategories(pool, project.id),
    listFunnels(pool, project.id),
    listEntityTypes(pool, project.id),
    eventStore.eventNames(project.id, env, 30),
    listPropertyDefinitions(pool, project.id),
    listActorLinks(pool, project.id, env),
    listSourceConnections(pool, project.id),
  ]);
  return {
    project: { slug: project.slug, name: project.name },
    env,
    metrics,
    metric_categories: metricCategories,
    funnels,
    entity_types: entityTypes,
    observed_events_30d: observedEvents,
    properties,
    identity: {
      active_links: actorLinks.links.filter((link) => link.status === 'active').length,
      linked_sources: new Set(actorLinks.links
        .filter((link) => link.status === 'active')
        .map((link) => link.source_distinct_id)).size,
      audit_entries: actorLinks.audit.length,
    },
    sources,
  };
}
