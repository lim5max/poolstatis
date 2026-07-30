import { ApiError } from '../errors.js';
import type {
  ActorActivityKeyset,
  ActorOrder,
  ActorsKeyset,
} from '../stores/eventStore.js';

function invalid(kind: 'actors' | 'person_activity'): never {
  throw new ApiError(
    400,
    kind === 'actors' ? 'actors_cursor_invalid' : 'person_activity_cursor_invalid',
    `the ${kind === 'actors' ? 'actors' : 'person activity'} cursor is invalid or belongs to another query`,
    'restart pagination without a cursor; cursors are opaque and must be replayed unchanged',
    false,
  );
}

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function encodeActorsCursor(order: ActorOrder, key: ActorsKeyset): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: 'actors',
    order,
    value: key.value,
    distinct_id: key.distinctId,
  })).toString('base64url');
}

export function decodeActorsCursor(cursor: string, order: ActorOrder): ActorsKeyset {
  const payload = decode(cursor) as {
    v?: unknown;
    kind?: unknown;
    order?: unknown;
    value?: unknown;
    distinct_id?: unknown;
  } | undefined;
  if (!payload
    || payload.v !== 1
    || payload.kind !== 'actors'
    || payload.order !== order
    || typeof payload.distinct_id !== 'string'
    || payload.distinct_id.length === 0
    || (order === 'events_desc'
      ? !Number.isInteger(payload.value) || Number(payload.value) < 0
      : typeof payload.value !== 'string'
        || !Number.isFinite(Date.parse(payload.value)))) {
    return invalid('actors');
  }
  return {
    value: payload.value as string | number,
    distinctId: payload.distinct_id,
  };
}

export function encodeActorActivityCursor(key: ActorActivityKeyset): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: 'person_activity',
    timestamp: key.timestamp,
    ingested_at: key.ingestedAt,
    event: key.event,
    raw_distinct_id: key.rawDistinctId,
    session_id: key.sessionId,
    properties_hash: key.propertiesHash,
    duplicate_ordinal: key.duplicateOrdinal,
  })).toString('base64url');
}

export function decodeActorActivityCursor(cursor: string): ActorActivityKeyset {
  const payload = decode(cursor) as Record<string, unknown> | undefined;
  if (!payload
    || payload.v !== 1
    || payload.kind !== 'person_activity'
    || typeof payload.timestamp !== 'string'
    || !Number.isFinite(Date.parse(payload.timestamp))
    || typeof payload.ingested_at !== 'string'
    || !Number.isFinite(Date.parse(payload.ingested_at))
    || typeof payload.event !== 'string'
    || typeof payload.raw_distinct_id !== 'string'
    || typeof payload.session_id !== 'string'
    || typeof payload.properties_hash !== 'string'
    || !Number.isInteger(payload.duplicate_ordinal)
    || Number(payload.duplicate_ordinal) < 1) {
    return invalid('person_activity');
  }
  return {
    timestamp: payload.timestamp,
    ingestedAt: payload.ingested_at,
    event: payload.event,
    rawDistinctId: payload.raw_distinct_id,
    sessionId: payload.session_id,
    propertiesHash: payload.properties_hash,
    duplicateOrdinal: Number(payload.duplicate_ordinal),
  };
}
