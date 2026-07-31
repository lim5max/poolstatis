import type pg from 'pg';
import type { AppendResult, EventStore, StorableEvent } from '../stores/eventStore.js';
import { ingestEventSchema, type IngestEnvelope } from '../schemas.js';
import { registeredEventNames } from './registry.js';
import { recordWarnings, type WarningDelta } from './warnings.js';
import { randomUUID } from 'node:crypto';
import { validateAcquisitionProperties } from './acquisitionAttribution.js';
import {
  browserRouteVocabulary,
  validateAndEnrichBrowserProperties,
} from './browserAnalytics.js';
import { subtractUtcCalendarMonths } from './retentionPolicy.js';

const CLOCK_SKEW_FUTURE_MS = 5 * 60_000;
const REGISTRY_CACHE_TTL_MS = 30_000;

export interface IngestResult {
  accepted: number;
  unregistered: number;
  duplicate?: boolean;
  errors?: Array<{ index: number; message: string }>;
  warnings?: AppendResult['warnings'];
}

interface CacheEntry {
  names: Set<string>;
  expiresAt: number;
}

interface RouteCacheEntry {
  keys: Set<string> | null;
  expiresAt: number;
}

/**
 * Ingest pipeline: per-event validation (a bad event never sinks the batch),
 * batch idempotency, clock-skew correction, and the registered-flag check
 * against the active metric registry.
 */
export class IngestService {
  private readonly registryCache = new Map<string, CacheEntry>();
  private readonly browserRouteCache = new Map<string, RouteCacheEntry>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly eventStore: EventStore,
  ) {}

  async processBatch(
    project: { id: string; retention_months: number },
    env: string,
    batch: IngestEnvelope,
    now: Date = new Date(),
    enrichment: { country: string } = { country: 'unknown' },
  ): Promise<IngestResult> {
    const rawEvents = batch.events;
    {
      const needsSafeRouteVocabulary = rawEvents.some((raw) => {
        const properties = (raw as { properties?: unknown } | null)?.properties;
        return properties !== null
          && typeof properties === 'object'
          && !Array.isArray(properties)
          && ((properties as Record<string, unknown>).$browser_context !== undefined
            || (properties as Record<string, unknown>).landing_route !== undefined);
      });
      const [registered, safeRouteKeys] = await Promise.all([
        this.registeredNames(project.id),
        needsSafeRouteVocabulary
          ? this.browserRouteKeys(project.id)
          : Promise.resolve(undefined),
      ]);
      const retentionFloor = subtractUtcCalendarMonths(now, project.retention_months);

      const storable: StorableEvent[] = [];
      const errors: Array<{ index: number; message: string }> = [];
      let unregistered = 0;

      // Accumulate warnings deduped per (kind,event) within this batch, so a noisy
      // batch produces a handful of upserts, not one per event.
      const warn = new Map<string, WarningDelta>();
      const bump = (kind: WarningDelta['kind'], event: string, detail: string, sample?: unknown) => {
        const key = `${kind}:${event}`;
        const cur = warn.get(key);
        if (cur) { cur.count += 1; cur.detail = detail; } // keep the most recent detail, not just the first
        else warn.set(key, { kind, event, detail, count: 1, ...(sample !== undefined ? { sample } : {}) });
      };

      rawEvents.forEach((raw, index) => {
        const parsed = ingestEventSchema.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const message = issue ? `${issue.path.join('.') || 'event'}: ${issue.message}` : 'invalid event';
          errors.push({ index, message });
          const name = typeof (raw as { event?: unknown })?.event === 'string' ? (raw as { event: string }).event : '(unknown)';
          bump('rejected', name, message, raw);
          return;
        }
        const e = parsed.data;
        const properties: Record<string, unknown> = { ...e.properties };
        const acquisitionError = validateAcquisitionProperties(properties, e.session_id, safeRouteKeys);
        if (acquisitionError) {
          errors.push({ index, message: acquisitionError });
          // Do not retain the rejected payload: attribution must never turn a
          // raw URL into an observability log entry.
          bump('rejected', e.event, acquisitionError);
          return;
        }
        const browserError = validateAndEnrichBrowserProperties(
          e.event,
          properties,
          e.session_id,
          enrichment.country,
          {
            ...(safeRouteKeys !== undefined ? { safeRouteKeys } : {}),
          },
        );
        if (browserError) {
          errors.push({ index, message: browserError });
          bump('rejected', e.event, browserError);
          return;
        }

        let timestamp = e.timestamp ? new Date(e.timestamp) : now;
        if (timestamp.getTime() > now.getTime() + CLOCK_SKEW_FUTURE_MS || timestamp < retentionFloor) {
          timestamp = now;
          properties.$clock_skew = true;
          bump('clock_skew', e.event, 'timestamp out of range — replaced with receipt time');
        }

        const isRegistered = registered.has(e.event);
        if (!isRegistered) {
          unregistered += 1;
          bump('unregistered', e.event, 'no active metric covers this event');
        }

        storable.push({
          projectId: project.id,
          env,
          event: e.event,
          timestamp,
          distinctId: e.distinct_id,
          sessionId: e.session_id ?? null,
          properties,
          registered: isRegistered,
        });
      });

      // Even a request without a caller-supplied batch id gets a server-only
      // claim. That keeps one HTTP batch, its quota check, and its durable
      // writes indivisible through BufferedEventStore.
      const appended = await this.eventStore.appendIdempotent({
        dedupe: 'ingest_24h',
        projectId: project.id,
        env,
        batchId: batch.batch_id ?? `server:${randomUUID()}`,
        events: storable,
      });
      if (appended.duplicate) return { accepted: 0, unregistered: 0, duplicate: true };
      if (warn.size > 0) {
        // Best-effort: a warnings-log failure must never fail ingestion.
        await recordWarnings(this.pool, project.id, env, [...warn.values()]).catch(() => {});
      }

      const result: IngestResult = { accepted: appended.inserted, unregistered };
      if (errors.length > 0) result.errors = errors;
      if (appended.warnings?.length) result.warnings = appended.warnings;
      return result;
    }
  }

  /** Drop the cached registry for a project (call after metric changes). */
  invalidateRegistry(projectId: string): void {
    this.registryCache.delete(projectId);
    this.browserRouteCache.delete(projectId);
  }

  private async registeredNames(projectId: string): Promise<Set<string>> {
    const cached = this.registryCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) return cached.names;
    const names = await registeredEventNames(this.pool, projectId);
    this.registryCache.set(projectId, { names, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
    return names;
  }

  private async browserRouteKeys(projectId: string): Promise<Set<string> | null> {
    const cached = this.browserRouteCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) return cached.keys;
    const keys = await browserRouteVocabulary(this.pool, projectId);
    this.browserRouteCache.set(projectId, {
      keys,
      expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS,
    });
    return keys;
  }
}
