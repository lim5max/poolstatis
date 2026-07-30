import type pg from 'pg';
import { parseDateInput } from '../dates.js';
import { badRequest } from '../errors.js';
import type { PersonQueryInput } from '../schemas.js';
import type { EventStore } from '../stores/eventStore.js';
import {
  actorCursorFingerprint,
  decodeActorActivityCursor,
  encodeActorActivityCursor,
  requireActorCursorSigningKey,
} from './actorCursors.js';
import { actorCursorSecurity, resolveActorIdentity } from './identity.js';
import { hasTrustedBrowserSessionSource } from './query.js';

export async function getPerson(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  requestedDistinctId: string,
  input: PersonQueryInput,
  cursorSigningSecret?: string,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const [trustedBrowserSessions, cursorSecurity] = await Promise.all([
    hasTrustedBrowserSessionSource(pool, projectId),
    actorCursorSecurity(pool, projectId, input.env, cursorSigningSecret),
  ]);
  const fingerprint = actorCursorFingerprint({
    kind: 'person_activity',
    projectId,
    env: input.env,
    distinctId: requestedDistinctId,
    from: input.from ?? null,
    to: input.to ?? null,
    trustedBrowserSessions,
  });
  const identityRevision = cursorSecurity.identityRevision;
  const decodedCursor = input.cursor
    ? decodeActorActivityCursor(
      input.cursor,
      fingerprint,
      identityRevision,
      requireActorCursorSigningKey(cursorSecurity.signingKey),
    )
    : undefined;
  const from = decodedCursor
    ? new Date(decodedCursor.snapshot.from)
    : parseDateInput(input.from ?? '-30d', now);
  const to = decodedCursor
    ? new Date(decodedCursor.snapshot.to)
    : input.to
      ? parseDateInput(input.to, now)
      : now;
  const snapshotIngestedAt = decodedCursor
    ? new Date(decodedCursor.snapshot.ingestedAt)
    : now;
  if (to.getTime() <= from.getTime()) {
    throw badRequest('person_range_invalid', 'to must be later than from');
  }
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60_000) {
    throw badRequest(
      'person_range_too_large',
      'person activity is bounded to at most 366 days',
      'request a smaller activity window',
    );
  }
  const identity = await resolveActorIdentity(
    pool,
    projectId,
    input.env,
    requestedDistinctId,
    100,
    snapshotIngestedAt,
  );
  const [listed, activity] = await Promise.all([
    eventStore.actors({
      projectId,
      env: input.env,
      from,
      to,
      snapshotIngestedAt,
      limit: 1,
      order: 'last_seen_desc',
      searchExactId: requestedDistinctId,
      trustedBrowserSessions,
    }),
    eventStore.actorActivity({
      projectId,
      env: input.env,
      distinctId: requestedDistinctId,
      from,
      to,
      snapshotIngestedAt,
      limit: input.limit,
      ...(decodedCursor ? { cursor: decodedCursor.key } : {}),
    }),
  ]);
  const actor = listed.actors[0];
  const summary = actor ? {
    first_seen: actor.first_seen,
    last_seen: actor.last_seen,
    total_events: actor.total_events,
    distinct_events: actor.distinct_events,
    active_days: actor.active_days,
    sessions: actor.session_count,
    session_count: actor.session_count,
    registered_share: actor.registered_share,
    top_events: actor.top_events,
  } : {
    first_seen: null,
    last_seen: null,
    total_events: 0,
    distinct_events: 0,
    active_days: 0,
    sessions: null,
    session_count: null,
    registered_share: 0,
    top_events: [],
  };
  return {
    requested_distinct_id: requestedDistinctId,
    distinct_id: identity.distinct_id,
    env: input.env,
    window: { from: from.toISOString(), to: to.toISOString() },
    summary,
    identity: {
      status: identity.status,
      raw_actor_count: identity.raw_actor_count,
      raw_distinct_ids: identity.raw_distinct_ids,
      raw_distinct_ids_truncated: identity.raw_distinct_ids_truncated,
      links: identity.links,
      links_truncated: identity.links_truncated,
    },
    entity: null,
    activity: {
      events: activity.events,
      next_cursor: activity.hasMore && activity.lastKey
        ? encodeActorActivityCursor(
          activity.lastKey,
          fingerprint,
          {
            from: from.toISOString(),
            to: to.toISOString(),
            ingestedAt: snapshotIngestedAt.toISOString(),
            identityRevision,
          },
          requireActorCursorSigningKey(cursorSecurity.signingKey),
        )
        : null,
      registered_only: true,
      properties_masked: true,
    },
    capabilities: {
      identity_entity: {
        available: false,
        reason: 'No explicit deterministic entity-to-canonical-actor rule exists.',
        source: null,
      },
      activity_properties: {
        available: false,
        reason: 'No approved event-property allowlist and masking policy exists.',
        source: null,
      },
      pinned_properties: {
        available: false,
        reason: 'No approved deterministic pinned-property source exists.',
        source: null,
      },
      session_count: {
        source: 'canonical_browser_sessions',
        unavailable_value: null,
        project_capability: trustedBrowserSessions,
      },
      purge: {
        scope: 'exact_raw_distinct_id',
        canonical_expansion: false,
        warning: 'Purge never expands from a canonical actor to linked raw IDs.',
      },
    },
  };
}
