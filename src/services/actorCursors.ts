import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.js';
import type {
  ActorActivityKeyset,
  ActorOrder,
  ActorsKeyset,
} from '../stores/eventStore.js';

const PG_INT_MAX = 2_147_483_647;

export interface CursorSnapshot {
  from: string;
  to: string;
  ingestedAt: string;
  identityRevision: string;
}

interface CursorEnvelope extends CursorSnapshot {
  fingerprint: string;
}

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

function sign(payload: Record<string, unknown>, signingKey: string): string {
  return createHmac('sha256', signingKey)
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function validSignature(
  payload: Record<string, unknown>,
  signingKey: string,
): boolean {
  if (typeof payload.signature !== 'string' || payload.signature.length > 100) return false;
  const { signature, ...unsigned } = payload;
  const expected = sign(unsigned, signingKey);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 100
    && Number.isFinite(Date.parse(value));
}

function validEnvelope(
  payload: Record<string, unknown>,
  fingerprint: string,
  identityRevision: string,
): payload is Record<string, unknown> & CursorEnvelope {
  return payload.fingerprint === fingerprint
    && payload.identityRevision === identityRevision
    && validTimestamp(payload.from)
    && validTimestamp(payload.to)
    && validTimestamp(payload.ingestedAt);
}

export function actorCursorFingerprint(scope: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('base64url');
}

export function requireActorCursorSigningKey(signingKey: string | null): string {
  if (signingKey) return signingKey;
  throw new ApiError(
    503,
    'actor_cursor_signing_unavailable',
    'actor pagination requires stable server-owned project key material',
    'create a project API key before requesting a paginated actor result',
    false,
  );
}

export function encodeActorsCursor(
  order: ActorOrder,
  key: ActorsKeyset,
  fingerprint: string,
  snapshot: CursorSnapshot,
  signingKey: string,
): string {
  const payload = {
    v: 2,
    kind: 'actors',
    order,
    fingerprint,
    ...snapshot,
    value: key.value,
    distinct_id: key.distinctId,
  };
  return Buffer.from(JSON.stringify({
    ...payload,
    signature: sign(payload, signingKey),
  })).toString('base64url');
}

export function decodeActorsCursor(
  cursor: string,
  order: ActorOrder,
  fingerprint: string,
  identityRevision: string,
  signingKey: string,
): { key: ActorsKeyset; snapshot: CursorSnapshot } {
  const payload = decode(cursor) as Record<string, unknown> | undefined;
  if (!payload
    || payload.v !== 2
    || payload.kind !== 'actors'
    || !validSignature(payload, signingKey)
    || payload.order !== order
    || !validEnvelope(payload, fingerprint, identityRevision)
    || typeof payload.distinct_id !== 'string'
    || payload.distinct_id.length === 0
    || payload.distinct_id.length > 200
    || (order === 'events_desc'
      ? !Number.isSafeInteger(payload.value)
        || Number(payload.value) < 0
        || Number(payload.value) > PG_INT_MAX
      : typeof payload.value !== 'string'
        || payload.value.length > 100
        || !Number.isFinite(Date.parse(payload.value)))) {
    return invalid('actors');
  }
  return {
    key: {
      value: payload.value as string | number,
      distinctId: payload.distinct_id,
    },
    snapshot: {
      from: payload.from,
      to: payload.to,
      ingestedAt: payload.ingestedAt,
      identityRevision: payload.identityRevision,
    },
  };
}

export function encodeActorActivityCursor(
  key: ActorActivityKeyset,
  fingerprint: string,
  snapshot: CursorSnapshot,
  signingKey: string,
): string {
  const payload = {
    v: 2,
    kind: 'person_activity',
    fingerprint,
    ...snapshot,
    timestamp: key.timestamp,
    ingested_at: key.ingestedAt,
    event: key.event,
    raw_distinct_id: key.rawDistinctId,
    session_id: key.sessionId,
    properties_hash: key.propertiesHash,
    duplicate_ordinal: key.duplicateOrdinal,
  };
  return Buffer.from(JSON.stringify({
    ...payload,
    signature: sign(payload, signingKey),
  })).toString('base64url');
}

export function decodeActorActivityCursor(
  cursor: string,
  fingerprint: string,
  identityRevision: string,
  signingKey: string,
): { key: ActorActivityKeyset; snapshot: CursorSnapshot } {
  const payload = decode(cursor) as Record<string, unknown> | undefined;
  if (!payload
    || payload.v !== 2
    || payload.kind !== 'person_activity'
    || !validSignature(payload, signingKey)
    || !validEnvelope(payload, fingerprint, identityRevision)
    || !validTimestamp(payload.timestamp)
    || !validTimestamp(payload.ingested_at)
    || typeof payload.event !== 'string'
    || payload.event.length > 200
    || typeof payload.raw_distinct_id !== 'string'
    || payload.raw_distinct_id.length > 200
    || typeof payload.session_id !== 'string'
    || payload.session_id.length > 500
    || typeof payload.properties_hash !== 'string'
    || payload.properties_hash.length > 100
    || !Number.isSafeInteger(payload.duplicate_ordinal)
    || Number(payload.duplicate_ordinal) < 1
    || Number(payload.duplicate_ordinal) > PG_INT_MAX) {
    return invalid('person_activity');
  }
  return {
    key: {
      timestamp: payload.timestamp,
      ingestedAt: payload.ingested_at,
      event: payload.event,
      rawDistinctId: payload.raw_distinct_id,
      sessionId: payload.session_id,
      propertiesHash: payload.properties_hash,
      duplicateOrdinal: Number(payload.duplicate_ordinal),
    },
    snapshot: {
      from: payload.from,
      to: payload.to,
      ingestedAt: payload.ingestedAt,
      identityRevision: payload.identityRevision,
    },
  };
}
