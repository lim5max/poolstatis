import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.js';
import {
  historicalEventSchema,
  type EventRevisionPatch,
  type HistoricalEventInput,
} from '../schemas.js';
import type {
  BackfillResult,
  EventRevisionRecord,
  EventStore,
  RawEvent,
  StorableEvent,
} from '../stores/eventStore.js';
import { validateAcquisitionProperties } from './acquisitionAttribution.js';
import {
  browserRouteVocabulary,
  validateAndEnrichBrowserProperties,
} from './browserAnalytics.js';
import { registeredEventNames } from './registry.js';
import { subtractUtcCalendarMonths } from './retentionPolicy.js';

const CLOCK_SKEW_FUTURE_MS = 5 * 60_000;

export interface BackfillPreview {
  valid: boolean;
  payload_sha256: string | null;
  event_count: number;
  registered_count: number;
  unregistered_count: number;
  min_timestamp: string | null;
  max_timestamp: string | null;
  errors: Array<{ index: number; message: string }>;
}

export interface EventRevisionPreview {
  event_id: string;
  expected_revision: number;
  preview_sha256: string;
  changed_fields: string[];
  before: RawEvent;
  after: RawEvent;
}

interface PreparedBackfill {
  preview: BackfillPreview;
  events: StorableEvent[];
}

export class EventManagementService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventStore: EventStore,
  ) {}

  async previewBackfill(
    project: { id: string; retention_months: number },
    env: string,
    rawEvents: unknown[],
    now: Date = new Date(),
  ): Promise<BackfillPreview> {
    return (await this.prepareBackfill(project, env, rawEvents, now)).preview;
  }

  async commitBackfill(input: {
    project: { id: string; retention_months: number };
    env: string;
    batchId: string;
    reason: string;
    actor: string;
    expectedPayloadSha256: string;
    rawEvents: unknown[];
    now?: Date;
  }): Promise<BackfillResult> {
    const prepared = await this.prepareBackfill(
      input.project,
      input.env,
      input.rawEvents,
      input.now ?? new Date(),
    );
    if (!prepared.preview.valid || !prepared.preview.payload_sha256) {
      throw new ApiError(
        422,
        'backfill_validation_failed',
        'historical import contains invalid events; nothing was stored',
        'fix every indexed error, preview the complete batch again, then import it',
        { errors: prepared.preview.errors },
      );
    }
    if (input.expectedPayloadSha256 !== prepared.preview.payload_sha256) {
      throw new ApiError(
        409,
        'backfill_preview_changed',
        'the historical payload no longer matches the reviewed preview',
        'preview the exact payload again and pass its new payload_sha256',
        { current_payload_sha256: prepared.preview.payload_sha256 },
      );
    }
    return this.eventStore.backfill({
      projectId: input.project.id,
      env: input.env,
      batchId: input.batchId,
      payloadSha256: prepared.preview.payload_sha256,
      reason: input.reason,
      actor: input.actor,
      events: prepared.events,
    });
  }

  async previewRevision(input: {
    project: { id: string; retention_months: number };
    env: string;
    eventId: string;
    patch: EventRevisionPatch;
    now?: Date;
  }): Promise<EventRevisionPreview> {
    const current = await this.eventStore.getEvent(input.project.id, input.env, input.eventId);
    if (!current) throw new ApiError(404, 'event_not_found', 'event not found');
    if (!current.editable) {
      throw new ApiError(
        409,
        'event_not_editable',
        'system and Browser Experience events cannot be revised',
        'correct the producing integration and keep typed platform evidence immutable',
      );
    }
    const after = await this.applyAndValidatePatch(
      input.project,
      current,
      input.patch,
      input.now ?? new Date(),
    );
    const fields = changedFields(current, after);
    if (fields.length === 0) {
      throw new ApiError(
        422,
        'event_revision_no_changes',
        'the correction would not change the current event',
        'set or unset a different value before creating a revision',
      );
    }
    const reviewed = {
      event_id: current.id,
      expected_revision: current.revision,
      changed_fields: fields,
      before: current,
      after,
    };
    return {
      ...reviewed,
      preview_sha256: hashPayload({
        project_id: input.project.id,
        env: input.env,
        ...reviewed,
      }),
    };
  }

  async commitRevision(input: {
    project: { id: string; retention_months: number };
    env: string;
    eventId: string;
    patch: EventRevisionPatch;
    expectedRevision: number;
    expectedPreviewSha256: string;
    reason: string;
    actor: string;
    now?: Date;
  }): Promise<EventRevisionRecord> {
    const preview = await this.previewRevision(input);
    if (preview.expected_revision !== input.expectedRevision) {
      throw new ApiError(
        409,
        'event_revision_conflict',
        `event is now at revision ${preview.expected_revision}`,
        'preview the current event and apply against its new expected_revision',
        { current_revision: preview.expected_revision },
      );
    }
    if (preview.preview_sha256 !== input.expectedPreviewSha256) {
      throw new ApiError(
        409,
        'event_revision_preview_changed',
        'the correction no longer matches the reviewed preview',
        'preview the current event and exact patch again, then pass its new preview_sha256',
        { current_preview_sha256: preview.preview_sha256 },
      );
    }
    const after = preview.after;
    return this.eventStore.reviseEvent({
      projectId: input.project.id,
      env: input.env,
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      actor: input.actor,
      reason: input.reason,
      event: {
        id: after.id,
        projectId: input.project.id,
        env: after.env,
        event: after.event,
        timestamp: new Date(after.timestamp),
        distinctId: after.distinct_id,
        sessionId: after.session_id,
        properties: after.properties,
        registered: after.registered,
        eventSource: 'ingest',
        origin: after.origin,
        backfillBatchId: after.backfill_batch_id,
        revision: after.revision,
      },
    });
  }

  private async prepareBackfill(
    project: { id: string; retention_months: number },
    env: string,
    rawEvents: unknown[],
    now: Date,
  ): Promise<PreparedBackfill> {
    const [registered, safeRouteKeys] = await Promise.all([
      registeredEventNames(this.pool, project.id),
      browserRouteVocabulary(this.pool, project.id),
    ]);
    const floor = subtractUtcCalendarMonths(now, project.retention_months);
    const events: StorableEvent[] = [];
    const normalized: Array<HistoricalEventInput & { registered: boolean }> = [];
    const errors: Array<{ index: number; message: string }> = [];

    rawEvents.forEach((raw, index) => {
      const parsed = historicalEventSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        errors.push({
          index,
          message: issue ? `${issue.path.join('.') || 'event'}: ${issue.message}` : 'invalid event',
        });
        return;
      }
      const event = parsed.data;
      const timestamp = new Date(event.timestamp);
      if (timestamp < floor) {
        errors.push({
          index,
          message: `timestamp is older than the project's ${project.retention_months}-month retention window`,
        });
        return;
      }
      if (timestamp.getTime() > now.getTime() + CLOCK_SKEW_FUTURE_MS) {
        errors.push({ index, message: 'timestamp is more than 5 minutes in the future' });
        return;
      }
      const properties = structuredClone(event.properties);
      const acquisitionError = validateAcquisitionProperties(
        properties,
        event.session_id,
        safeRouteKeys,
      );
      if (acquisitionError) {
        errors.push({ index, message: acquisitionError });
        return;
      }
      const browserError = validateAndEnrichBrowserProperties(
        event.event,
        properties,
        event.session_id,
        'unknown',
        { historical: true, safeRouteKeys },
      );
      if (browserError) {
        errors.push({ index, message: browserError });
        return;
      }
      normalized.push({
        event: event.event,
        timestamp: timestamp.toISOString(),
        distinct_id: event.distinct_id,
        ...(event.session_id !== undefined ? { session_id: event.session_id } : {}),
        properties,
        registered: registered.has(event.event),
      });
      events.push({
        projectId: project.id,
        env,
        event: event.event,
        timestamp,
        distinctId: event.distinct_id,
        sessionId: event.session_id ?? null,
        properties,
        registered: registered.has(event.event),
        eventSource: 'ingest',
        origin: 'backfill',
      });
    });

    const times = events.map((event) => event.timestamp.getTime());
    const registeredCount = events.filter((event) => event.registered).length;
    const valid = errors.length === 0 && events.length === rawEvents.length;
    return {
      events,
      preview: {
        valid,
        payload_sha256: valid ? hashPayload({
          project_id: project.id,
          env,
          events: normalized,
        }) : null,
        event_count: events.length,
        registered_count: registeredCount,
        unregistered_count: events.length - registeredCount,
        min_timestamp: times.length ? new Date(Math.min(...times)).toISOString() : null,
        max_timestamp: times.length ? new Date(Math.max(...times)).toISOString() : null,
        errors,
      },
    };
  }

  private async applyAndValidatePatch(
    project: { id: string; retention_months: number },
    current: RawEvent,
    patch: EventRevisionPatch,
    now: Date,
  ): Promise<RawEvent> {
    const properties = structuredClone(current.properties);
    for (const [key, value] of Object.entries(patch.set_properties)) properties[key] = value;
    for (const key of patch.unset_properties) delete properties[key];
    const event = patch.event ?? current.event;
    const timestamp = patch.timestamp ? new Date(patch.timestamp) : new Date(current.timestamp);
    const distinctId = patch.distinct_id ?? current.distinct_id;
    const sessionId = patch.session_id !== undefined ? patch.session_id : current.session_id;
    const floor = subtractUtcCalendarMonths(now, project.retention_months);
    if (timestamp < floor) {
      throw new ApiError(
        422,
        'event_outside_retention',
        `corrected timestamp is older than the project's ${project.retention_months}-month retention window`,
      );
    }
    if (timestamp.getTime() > now.getTime() + CLOCK_SKEW_FUTURE_MS) {
      throw new ApiError(422, 'event_in_future', 'corrected timestamp is more than 5 minutes in the future');
    }
    const safeRouteKeys = await browserRouteVocabulary(this.pool, project.id);
    const acquisitionError = validateAcquisitionProperties(
      properties,
      sessionId ?? undefined,
      safeRouteKeys,
    );
    if (acquisitionError) throw new ApiError(422, 'event_validation_failed', acquisitionError);
    const browserError = validateAndEnrichBrowserProperties(
      event,
      properties,
      sessionId ?? undefined,
      'unknown',
      { historical: true, safeRouteKeys },
    );
    if (browserError) throw new ApiError(422, 'event_validation_failed', browserError);
    const registered = await registeredEventNames(this.pool, project.id);
    return {
      ...current,
      event,
      timestamp: timestamp.toISOString(),
      distinct_id: distinctId,
      session_id: sessionId,
      properties,
      registered: registered.has(event),
      revision: current.revision + 1,
    };
  }
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function changedFields(before: RawEvent, after: RawEvent): string[] {
  const fields: Array<keyof RawEvent> = [
    'event', 'timestamp', 'distinct_id', 'session_id', 'properties', 'registered',
  ];
  return fields.filter((field) =>
    JSON.stringify(canonicalize(before[field])) !== JSON.stringify(canonicalize(after[field])));
}
