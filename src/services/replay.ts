import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import { hashToken } from '../keys.js';
import type { CreateReplaySessionInput, ReplayChunkUploadInput } from '../schemas.js';
import type { ArtifactStore } from '../stores/artifactStore.js';
import type { EventStore } from '../stores/eventStore.js';
import { getExperienceRoute, getExperienceSurface } from './experience.js';
import {
  ReplayObjectConflictError,
  ReplayObjectTooLargeError,
  type ReplayObjectStore,
} from '../replay/objectStore.js';
import { sanitizeReplayEvents } from '../replay/sanitize.js';
import {
  REPLAY_LIMITS,
  type ReplaySessionStatus,
  type ReplaySessionSummary,
  type ReplayTextMode,
} from '../replay/types.js';

interface ReplayRow {
  id: string;
  project_id: string;
  surface: string;
  route: string;
  env: string;
  session_id: string;
  distinct_id: string;
  host: string;
  version: string;
  device: 'desktop' | 'mobile';
  consent_version: string;
  policy_version: string;
  policy_hash: string;
  text_mode: ReplayTextMode;
  mask_selectors: string[];
  block_selectors: string[];
  status: ReplaySessionStatus;
  upload_token_hash: string;
  chunk_count: number;
  event_count: number | string;
  byte_size: number | string;
  started_at: string | Date;
  completed_at: string | Date | null;
  delete_after: string | Date;
}

interface ChunkRow {
  sequence: number;
  object_key: string;
  checksum: string;
  stored_checksum: string;
  byte_size: number;
  event_count: number;
  first_timestamp: number | string;
  last_timestamp: number | string;
  has_checkout: boolean;
}

interface ProjectDeletionJobRow {
  project_id: string;
  actor: string;
  phase: 'artifacts' | 'events' | 'replays' | 'metadata' | 'objects';
  artifacts_deleted: number;
  events_deleted: number | string;
  replays_deleted: number;
}

export interface ProjectDeletionDependencies {
  artifacts: Pick<ArtifactStore, 'delete'>;
  eventStore: Pick<EventStore, 'purge'>;
}

export interface ReplayProjectDeletionResult {
  artifactsDeleted: number;
  eventsDeleted: number;
  replaysDeleted: number;
}

export interface ReplayEventsRead {
  replay: ReplaySessionSummary;
  events: Array<Record<string, unknown>>;
}

export interface ReplayEventsLease extends ReplayEventsRead {
  expiresAt: number;
  close(completed: boolean): Promise<void>;
}

const SESSION_SELECT = `
  SELECT rs.id, rs.project_id, s.key AS surface, r.key AS route, rs.env,
         rs.session_id, rs.distinct_id, rs.host, rs.version, rs.device,
         rs.consent_version, rs.policy_version, rs.policy_hash, rs.text_mode,
         rs.mask_selectors, rs.block_selectors,
         rs.status, rs.upload_token_hash, rs.chunk_count, rs.event_count,
         rs.byte_size, rs.started_at, rs.completed_at, rs.delete_after
  FROM replay_sessions rs
  JOIN experience_surfaces s ON s.id = rs.surface_id
  JOIN experience_routes r ON r.id = rs.route_id`;

export class ReplayService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly objects: ReplayObjectStore,
    private readonly projectDeletion?: ProjectDeletionDependencies,
  ) {}

  async createSession(
    projectId: string,
    env: string,
    input: CreateReplaySessionInput,
    origin?: string,
    now = new Date(),
  ): Promise<{ replay: ReplaySessionSummary; upload_token: string }> {
    if (origin) {
      let hostname: string;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        throw new ApiError(403, 'replay_origin_invalid', 'browser replay requires a valid Origin header');
      }
      if (hostname !== input.host) {
        throw new ApiError(403, 'replay_host_policy_mismatch', 'browser origin does not match the declared replay host policy');
      }
    }
    const expectedPolicyHash = sha256(JSON.stringify(input.policy));
    if (expectedPolicyHash !== input.policy_hash) {
      throw new ApiError(400, 'replay_policy_hash_mismatch', 'policy_hash does not match the submitted privacy policy');
    }
    const [surface, route] = await Promise.all([
      getExperienceSurface(this.pool, projectId, input.surface),
      getExperienceRoute(this.pool, projectId, input.surface, input.route),
    ]);
    if (surface.status !== 'active') {
      throw new ApiError(409, 'experience_surface_not_active', `experience surface "${input.surface}" is ${surface.status}`);
    }
    const uploadToken = `rt_${randomBytes(32).toString('hex')}`;
    const deleteAfter = new Date(now.getTime() + input.retention_days * 86_400_000);
    const client = await this.pool.connect();
    let replayId: string;
    try {
      await client.query('BEGIN');
      await this.assertProjectReplayWritable(client, projectId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO replay_sessions (
           project_id, surface_id, route_id, env, session_id, distinct_id, host,
           version, device, consent_version, policy_version, policy_hash,
           text_mode, mask_selectors, block_selectors, upload_token_hash,
           started_at, last_seen_at, delete_after
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18)
         RETURNING id`,
        [
          projectId, surface.id, route.id, env, input.session_id, input.distinct_id,
          input.host, input.version, input.device, input.consent_version,
          input.policy.version, input.policy_hash, input.policy.text,
          input.policy.maskSelectors, input.policy.blockSelectors,
          hashToken(uploadToken), now, deleteAfter,
        ],
      );
      replayId = rows[0]!.id;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      replay: await this.getSession(projectId, env, replayId, true),
      upload_token: uploadToken,
    };
  }

  async putChunk(
    projectId: string,
    env: string,
    replayId: string,
    input: ReplayChunkUploadInput,
    now = new Date(),
  ): Promise<{ accepted: boolean; duplicate: boolean; sequence: number }> {
    const rawJson = JSON.stringify(input.events);
    const rawBytes = Buffer.byteLength(rawJson);
    if (rawBytes > REPLAY_LIMITS.maxChunkBytes) {
      throw new ApiError(413, 'replay_chunk_too_large', `replay chunk exceeds ${REPLAY_LIMITS.maxChunkBytes} bytes`);
    }
    if (sha256(rawJson) !== input.checksum) {
      throw new ApiError(400, 'replay_checksum_mismatch', 'checksum does not match the submitted replay events');
    }

    const client = await this.pool.connect();
    let objectKey: string | null = null;
    let objectCreated = false;
    let commitAttempted = false;
    try {
      await client.query('BEGIN');
      await this.assertProjectReplayWritable(client, projectId);
      const session = await this.lockSession(client, projectId, env, replayId);
      this.assertUploadAllowed(session, input.upload_token, now);
      const duplicate = await client.query<{ checksum: string }>(
        'SELECT checksum FROM replay_chunks WHERE replay_id = $1 AND sequence = $2',
        [replayId, input.sequence],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].checksum !== input.checksum) {
          throw new ApiError(409, 'replay_sequence_conflict', 'this replay sequence already has a different checksum');
        }
        await client.query('COMMIT');
        return { accepted: true, duplicate: true, sequence: input.sequence };
      }

      const sanitized = sanitizeReplayEvents(input.events, {
        route: session.route,
        textMode: session.text_mode,
        maskSelectors: session.mask_selectors,
        blockSelectors: session.block_selectors,
      });
      const storedJson = JSON.stringify(sanitized.events);
      const storedBytes = Buffer.from(storedJson);
      const nextChunks = Number(session.chunk_count) + 1;
      const nextEvents = Number(session.event_count) + sanitized.eventCount;
      const nextBytes = Number(session.byte_size) + storedBytes.length;
      if (nextChunks > REPLAY_LIMITS.maxChunksPerSession
          || nextEvents > REPLAY_LIMITS.maxEventsPerSession
          || nextBytes > REPLAY_LIMITS.maxSessionBytes) {
        throw new ApiError(413, 'replay_session_limit_exceeded', 'replay session exceeded its bounded chunk, event or byte limit');
      }

      objectKey = `${projectId}/${replayId}/${input.sequence}.json`;
      try {
        objectCreated = (await this.objects.put(objectKey, storedBytes)) === 'created';
      } catch (error) {
        if (error instanceof ReplayObjectConflictError) {
          throw new ApiError(409, 'replay_object_conflict', 'replay object exists with different bytes');
        }
        throw new ApiError(
          503,
          'replay_storage_unavailable',
          'replay storage is temporarily unavailable',
          'retry this exact sequence and checksum later',
          { retryable: true },
        );
      }
      await client.query(
        `INSERT INTO replay_chunks (
           replay_id, sequence, object_key, checksum, stored_checksum, byte_size,
           event_count, first_timestamp, last_timestamp, has_checkout
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          replayId, input.sequence, objectKey, input.checksum, sha256(storedJson),
          storedBytes.length, sanitized.eventCount, sanitized.firstTimestamp,
          sanitized.lastTimestamp, sanitized.hasCheckout,
        ],
      );
      await client.query(
        `UPDATE replay_sessions
         SET chunk_count = $2, event_count = $3, byte_size = $4,
             last_seen_at = $5, status = 'recording'
         WHERE id = $1`,
        [replayId, nextChunks, nextEvents, nextBytes, now],
      );
      // After COMMIT is sent, a connection loss leaves its result ambiguous.
      // Retaining the deterministic object makes either outcome recoverable by
      // an exact sequence/checksum retry.
      commitAttempted = true;
      await client.query('COMMIT');
      return { accepted: true, duplicate: false, sequence: input.sequence };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (!commitAttempted && objectCreated && objectKey) await this.objects.delete(objectKey).catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    projectId: string,
    env: string,
    replayId: string,
    uploadToken: string,
    lastSequence: number,
    now = new Date(),
  ): Promise<ReplaySessionSummary> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertProjectReplayWritable(client, projectId);
      const session = await this.lockSession(client, projectId, env, replayId);
      this.assertUploadAllowed(session, uploadToken, now, true);
      const chunks = await client.query<ChunkRow>(
        `SELECT sequence, object_key, checksum, stored_checksum, byte_size,
                event_count, first_timestamp, last_timestamp, has_checkout
         FROM replay_chunks WHERE replay_id = $1 ORDER BY sequence`,
        [replayId],
      );
      const contiguous = chunks.rows.length === lastSequence + 1
        && chunks.rows.every((chunk, index) => chunk.sequence === index)
        && chunks.rows.every((chunk, index) => index === 0
          || Number(chunk.first_timestamp) >= Number(chunks.rows[index - 1]!.last_timestamp));
      const anchored = chunks.rows[0]?.has_checkout === true;
      const first = chunks.rows[0];
      const last = chunks.rows.at(-1);
      const boundedDuration = Boolean(first && last)
        && Number(last!.last_timestamp) - Number(first!.first_timestamp) <= REPLAY_LIMITS.maxSessionDurationMs;
      const status: ReplaySessionStatus = contiguous && anchored && boundedDuration ? 'playable' : 'incomplete';
      await client.query(
        `UPDATE replay_sessions
         SET status = $2, completed_at = COALESCE(completed_at, $3), last_seen_at = $3
         WHERE id = $1`,
        [replayId, status, now],
      );
      await client.query('COMMIT');
      return this.getSession(projectId, env, replayId, true);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listSessions(
    projectId: string,
    filters: { env?: string; surface?: string; status?: ReplaySessionStatus; limit?: number } = {},
  ): Promise<ReplaySessionSummary[]> {
    const params: unknown[] = [projectId];
    const predicates = [
      'rs.project_id = $1',
      "rs.status NOT IN ('deleting', 'deleted')",
      'rs.delete_after > clock_timestamp()',
    ];
    for (const [column, value] of [
      ['rs.env', filters.env],
      ['s.key', filters.surface],
      ['rs.status', filters.status],
    ] as const) {
      if (value) {
        params.push(value);
        predicates.push(`${column} = $${params.length}`);
      }
    }
    params.push(Math.min(100, Math.max(1, filters.limit ?? 50)));
    const { rows } = await this.pool.query<ReplayRow>(
      `${SESSION_SELECT}
       WHERE ${predicates.join(' AND ')}
       ORDER BY rs.started_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(publicSession);
  }

  async getSession(
    projectId: string,
    env: string,
    replayId: string,
    includeRecording = false,
  ): Promise<ReplaySessionSummary> {
    const { rows } = await this.pool.query<ReplayRow>(
      `${SESSION_SELECT}
       WHERE rs.project_id = $1 AND rs.env = $2 AND rs.id = $3`,
      [projectId, env, replayId],
    );
    const row = rows[0];
    if (!row) throw notFound('session_replay');
    if (row.status === 'deleting' || row.status === 'deleted' || isExpired(row)) {
      throw new ApiError(410, 'session_replay_deleted', 'session replay is deleted');
    }
    if (!includeRecording && row.status === 'recording') {
      throw new ApiError(409, 'session_replay_recording', 'session replay is still recording');
    }
    return publicSession(row);
  }

  async readEvents(
    projectId: string,
    env: string,
    replayId: string,
    actor: string,
  ): Promise<ReplayEventsRead> {
    const lease = await this.openEventsRead(projectId, env, replayId, actor);
    await lease.close(true);
    return { replay: lease.replay, events: lease.events };
  }

  async openEventsRead(
    projectId: string,
    env: string,
    replayId: string,
    actor: string,
    deadlineMs = 15_000,
  ): Promise<ReplayEventsLease> {
    const boundedDeadlineMs = Math.min(30_000, Math.max(25, deadlineMs));
    const expiresAt = Date.now() + boundedDeadlineMs;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('statement_timeout', $1, true),
                set_config('lock_timeout', $1, true)`,
        [`${boundedDeadlineMs}ms`],
      );
      const sessionResult = await client.query<ReplayRow>(
        `${SESSION_SELECT}
         WHERE rs.project_id = $1 AND rs.env = $2 AND rs.id = $3
         FOR SHARE OF rs`,
        [projectId, env, replayId],
      );
      const row = sessionResult.rows[0];
      if (!row) throw notFound('session_replay');
      if (row.status === 'deleting' || row.status === 'deleted' || isExpired(row)) {
        throw new ApiError(410, 'session_replay_deleted', 'session replay is deleted');
      }
      if (row.status === 'recording') {
        throw new ApiError(409, 'session_replay_recording', 'session replay is still recording');
      }
      const replay = publicSession(row);
      if (replay.status !== 'playable') {
        throw new ApiError(409, 'session_replay_incomplete', 'only contiguous replay sessions with an initial full snapshot are playable');
      }
      const { rows } = await client.query<ChunkRow>(
        `SELECT sequence, object_key, checksum, stored_checksum, byte_size,
                event_count, first_timestamp, last_timestamp, has_checkout
         FROM replay_chunks WHERE replay_id = $1 ORDER BY sequence`,
        [replayId],
      );
      const events: Array<Record<string, unknown>> = [];
      let bytes = 0;
      let previousLast: number | null = null;
      if (rows.length !== replay.chunk_count) throw corruptReplay('stored replay chunk count does not match its manifest');
      for (const [index, chunk] of rows.entries()) {
        if (chunk.sequence !== index) throw corruptReplay('stored replay chunk sequence is not contiguous');
        let stored: Buffer;
        try {
          stored = await withinReplayDeadline(
            this.objects.get(chunk.object_key, Number(chunk.byte_size)),
            expiresAt,
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (error instanceof ReplayObjectTooLargeError) throw corruptReplay('stored replay chunk exceeds its manifest size');
          throw new ApiError(503, 'replay_storage_unavailable', 'replay payload is temporarily unavailable', undefined, { retryable: true });
        }
        assertReplayDeadline(expiresAt);
        bytes += stored.length;
        if (bytes > REPLAY_LIMITS.maxViewerBytes) throw new ApiError(413, 'replay_view_limit_exceeded', 'replay exceeds the viewer byte limit');
        if (stored.length !== Number(chunk.byte_size)) throw corruptReplay('stored replay chunk size does not match its manifest');
        const json = stored.toString('utf8');
        if (sha256(json) !== chunk.stored_checksum) throw corruptReplay('stored replay chunk failed its integrity check');
        let parsed: unknown;
        try { parsed = JSON.parse(json); } catch { throw corruptReplay('stored replay chunk is not valid JSON'); }
        const sanitized = sanitizeReplayEvents(parsed, {
          route: replay.route,
          textMode: replay.text_mode,
          maskSelectors: row.mask_selectors,
          blockSelectors: row.block_selectors,
        });
        assertReplayDeadline(expiresAt);
        if (sanitized.byteSize !== stored.length
            || sanitized.eventCount !== Number(chunk.event_count)
            || sanitized.firstTimestamp !== Number(chunk.first_timestamp)
            || sanitized.lastTimestamp !== Number(chunk.last_timestamp)
            || sanitized.hasCheckout !== chunk.has_checkout
            || previousLast !== null && sanitized.firstTimestamp < previousLast
            || index === 0 && !sanitized.hasCheckout) {
          throw corruptReplay('stored replay chunk metadata failed playback validation');
        }
        previousLast = sanitized.lastTimestamp;
        events.push(...sanitized.events);
        if (events.length > REPLAY_LIMITS.maxViewerEvents) throw new ApiError(413, 'replay_view_limit_exceeded', 'replay exceeds the viewer event limit');
      }
      if (bytes !== replay.byte_size || events.length !== replay.event_count) {
        throw corruptReplay('stored replay totals do not match the manifest');
      }
      await client.query(
        'INSERT INTO replay_audit_log (project_id, replay_id, actor, action) VALUES ($1,$2,$3,\'view\')',
        [projectId, replayId, actor],
      );
      assertReplayDeadline(expiresAt);
      let closed = false;
      return {
        replay,
        events,
        expiresAt,
        close: async (completed: boolean) => {
          if (closed) return;
          closed = true;
          try {
            await client.query(completed ? 'COMMIT' : 'ROLLBACK');
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw error;
    }
  }

  async withdraw(
    projectId: string,
    env: string,
    replayId: string,
    uploadToken: string,
    now = new Date(),
  ): Promise<{ deleted: true }> {
    // A previous attempt may have committed the unreadable `deleting`
    // tombstone before physical storage failed or its HTTP response was lost.
    // The original upload token remains available until final deletion, so an
    // authenticated retry can converge instead of getting stuck on 410.
    const session = await this.getRawSession(projectId, env, replayId, true);
    this.assertToken(session.upload_token_hash, uploadToken);
    await this.deleteSession(projectId, replayId, 'consent:withdrawal', now);
    return { deleted: true };
  }

  async deleteSession(
    projectId: string,
    replayId: string,
    actor: string,
    now = new Date(),
  ): Promise<{ deleted: true }> {
    const claimClient = await this.pool.connect();
    try {
      await claimClient.query('BEGIN');
      const claimed = await claimClient.query(
        `UPDATE replay_sessions
         SET status = 'deleting', deleted_at = COALESCE(deleted_at, $3), last_seen_at = $3,
             delete_after = LEAST(delete_after, $3), deletion_claimed_until = $3 + interval '2 minutes'
         WHERE project_id = $1 AND id = $2 AND status <> 'deleted'
         RETURNING id`,
        [projectId, replayId, now],
      );
      if (!claimed.rowCount) {
        const existing = await claimClient.query<{ status: ReplaySessionStatus }>(
          'SELECT status FROM replay_sessions WHERE project_id = $1 AND id = $2',
          [projectId, replayId],
        );
        await claimClient.query('COMMIT');
        if (existing.rows[0]?.status === 'deleted') return { deleted: true };
        throw notFound('session_replay');
      }
      await claimClient.query(
        `INSERT INTO replay_audit_log (project_id, replay_id, actor, action)
         VALUES ($1,$2,$3,'delete_requested')
         ON CONFLICT (replay_id, action)
         WHERE action IN ('delete_requested', 'delete_completed') DO NOTHING`,
        [projectId, replayId, actor],
      );
      await claimClient.query('COMMIT');
    } catch (error) {
      await claimClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      claimClient.release();
    }
    try {
      await this.objects.deleteReplay(projectId, replayId);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM replay_chunks WHERE replay_id = $1', [replayId]);
        await client.query(
          `UPDATE replay_sessions
           SET status = 'deleted', chunk_count = 0, event_count = 0, byte_size = 0,
               session_id = 'deleted', distinct_id = 'deleted', host = 'deleted.invalid',
               version = 'deleted', consent_version = 'deleted', policy_version = 'deleted',
               policy_hash = repeat('0', 64), text_mode = 'masked',
               mask_selectors = '{}', block_selectors = '{}',
               upload_token_hash = repeat('0', 64),
               deletion_claimed_until = '-infinity', delete_retry_after = 'infinity',
               last_delete_error = NULL
           WHERE project_id = $1 AND id = $2 AND status = 'deleting'`,
          [projectId, replayId],
        );
        await client.query(
          `INSERT INTO replay_audit_log (project_id, replay_id, actor, action)
           SELECT $1, $2, COALESCE(
             (SELECT actor FROM replay_audit_log
              WHERE replay_id = $2 AND action = 'delete_requested'
              ORDER BY id LIMIT 1),
             $3
           ), 'delete_completed'
           ON CONFLICT (replay_id, action)
           WHERE action IN ('delete_requested', 'delete_completed') DO NOTHING`,
          [projectId, replayId, actor],
        );
        await client.query('COMMIT');
        return { deleted: true };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await this.pool.query(
        `UPDATE replay_sessions SET delete_attempts = delete_attempts + 1,
             delete_retry_after = $3 + interval '5 seconds'
               * power(2, LEAST(delete_attempts, 10)),
             deletion_claimed_until = '-infinity',
             last_delete_error = 'replay physical deletion or metadata finalization failed'
         WHERE project_id = $1 AND id = $2`,
        [projectId, replayId, now],
      ).catch(() => {});
      throw new ApiError(503, 'replay_delete_pending', 'replay is unreadable and physical deletion will be retried', undefined, { retryable: true });
    }
  }

  /**
   * Persists deletion intent before any external side effect. Snapshot object
   * keys are copied into a non-cascading work table so recovery remains
   * possible even after project metadata disappears.
   */
  async beginProjectDeletion(projectId: string, actor: string, now = new Date()): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const pending = await client.query(
        `UPDATE projects SET replay_deletion_pending = true
         WHERE id = $1 RETURNING id`,
        [projectId],
      );
      if (!pending.rowCount) throw notFound('project');
      await client.query(
        `INSERT INTO replay_project_deletion_jobs (
           project_id, actor, retry_after, claimed_until, last_error
         ) VALUES ($1,$2,'-infinity',$3::timestamptz + interval '2 minutes',NULL)
         ON CONFLICT (project_id) DO UPDATE
         SET claimed_until = GREATEST(
               replay_project_deletion_jobs.claimed_until,
               EXCLUDED.claimed_until
             ),
             retry_after = '-infinity', last_error = NULL`,
        [projectId, actor, now],
      );
      await client.query(
        `INSERT INTO replay_project_deletion_artifacts (project_id, artifact_key)
         SELECT $1, artifact_key FROM experience_snapshots WHERE project_id = $1
         ON CONFLICT (project_id, artifact_key) DO NOTHING`,
        [projectId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs every durable deletion phase; safe to retry after any crash window. */
  async processProjectDeletion(
    projectId: string,
    now = new Date(),
  ): Promise<ReplayProjectDeletionResult> {
    try {
      return await this.advanceProjectDeletion(projectId, now);
    } catch {
      await this.failProjectDeletionJob(projectId, now);
      throw new ApiError(
        503,
        'replay_project_delete_pending',
        'project deletion is durable and will be retried from its last completed phase',
        undefined,
        { retryable: true },
      );
    }
  }

  async retryProjectDeletionJobs(
    limit = 100,
    now = new Date(),
  ): Promise<{ deleted: number; errors: number; hasMore: boolean }> {
    const { rows } = await this.pool.query<{ project_id: string }>(
      `WITH candidates AS (
         SELECT project_id FROM replay_project_deletion_jobs
         WHERE completed_at IS NULL AND retry_after <= $1 AND claimed_until <= $1
         ORDER BY attempts, retry_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE replay_project_deletion_jobs jobs
       SET claimed_until = $1 + interval '2 minutes'
       FROM candidates
       WHERE jobs.project_id = candidates.project_id
       RETURNING jobs.project_id, jobs.actor`,
      [now, limit],
    );
    let deleted = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        await this.advanceProjectDeletion(row.project_id, now);
        deleted += 1;
      } catch {
        await this.failProjectDeletionJob(row.project_id, now);
        errors += 1;
      }
    }
    const more = await this.pool.query<{ has_more: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM replay_project_deletion_jobs
         WHERE completed_at IS NULL AND retry_after <= $1 AND claimed_until <= $1
       ) AS has_more`,
      [now],
    );
    return { deleted, errors, hasMore: more.rows[0]?.has_more === true };
  }

  private async advanceProjectDeletion(
    projectId: string,
    now: Date,
  ): Promise<ReplayProjectDeletionResult> {
    if (!this.projectDeletion) {
      throw new Error('project deletion dependencies are not configured');
    }
    let job = await this.getProjectDeletionJob(projectId);
    if (!job) throw notFound('project_deletion_job');

    if (job.phase === 'artifacts') {
      while (true) {
        const artifacts = await this.pool.query<{ artifact_key: string }>(
          `SELECT artifact_key FROM replay_project_deletion_artifacts
           WHERE project_id = $1 AND deleted_at IS NULL
           ORDER BY artifact_key LIMIT 100`,
          [projectId],
        );
        if (artifacts.rows.length === 0) break;
        for (const artifact of artifacts.rows) {
          await this.projectDeletion.artifacts.delete(artifact.artifact_key);
          await this.pool.query(
            `UPDATE replay_project_deletion_artifacts SET deleted_at = $3
             WHERE project_id = $1 AND artifact_key = $2 AND deleted_at IS NULL`,
            [projectId, artifact.artifact_key, now],
          );
        }
      }
      await this.pool.query(
        `UPDATE replay_project_deletion_jobs
         SET phase = 'events', artifacts_deleted = (
           SELECT count(*) FROM replay_project_deletion_artifacts
           WHERE project_id = $1 AND deleted_at IS NOT NULL
         )
         WHERE project_id = $1 AND phase = 'artifacts'`,
        [projectId],
      );
      job = (await this.getProjectDeletionJob(projectId))!;
    }

    if (job.phase === 'events') {
      const eventsDeleted = await this.projectDeletion.eventStore.purge(projectId);
      await this.pool.query(
        `UPDATE replay_project_deletion_jobs
         SET phase = 'replays', events_deleted = events_deleted + $2
         WHERE project_id = $1 AND phase = 'events'`,
        [projectId, eventsDeleted],
      );
      job = (await this.getProjectDeletionJob(projectId))!;
    }

    if (job.phase === 'replays') {
      const replaysDeleted = await this.purgeSessions(projectId, job.actor, undefined, undefined, now);
      await this.pool.query(
        `UPDATE replay_project_deletion_jobs
         SET phase = 'metadata', replays_deleted = replays_deleted + $2
         WHERE project_id = $1 AND phase = 'replays'`,
        [projectId, replaysDeleted],
      );
      job = (await this.getProjectDeletionJob(projectId))!;
    }

    if (job.phase === 'metadata') {
      const removed = await this.pool.query(
        `DELETE FROM projects
         WHERE id = $1 AND replay_deletion_pending = true`,
        [projectId],
      );
      if (!removed.rowCount) {
        const exists = await this.pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
        if (exists.rowCount) throw new Error('project deletion job lost its durable write barrier');
      }
      await this.pool.query(
        `UPDATE replay_project_deletion_jobs SET phase = 'objects'
         WHERE project_id = $1 AND phase = 'metadata'`,
        [projectId],
      );
      job = (await this.getProjectDeletionJob(projectId))!;
    }

    const result = projectDeletionResult(job);
    if (job.phase === 'objects') {
      await this.objects.deleteProject(projectId);
      await this.pool.query(
        'DELETE FROM replay_project_deletion_jobs WHERE project_id = $1',
        [projectId],
      );
    }
    return result;
  }

  private async getProjectDeletionJob(projectId: string): Promise<ProjectDeletionJobRow | null> {
    const { rows } = await this.pool.query<ProjectDeletionJobRow>(
      `SELECT project_id, actor, phase, artifacts_deleted, events_deleted, replays_deleted
       FROM replay_project_deletion_jobs WHERE project_id = $1`,
      [projectId],
    );
    return rows[0] ?? null;
  }

  /** Physical replay purge used by project deletion and env-scoped data purge. */
  async purgeSessions(
    projectId: string,
    actor: string,
    env?: string,
    distinctId?: string,
    now = new Date(),
  ): Promise<number> {
    let deleted = 0;
    while (true) {
      const { rows } = await this.pool.query<{ id: string }>(
        `SELECT id FROM replay_sessions
         WHERE project_id = $1 AND status <> 'deleted'
           AND ($2::text IS NULL OR env = $2)
           AND ($3::text IS NULL OR distinct_id = $3)
         ORDER BY id
         LIMIT 100`,
        [projectId, env ?? null, distinctId ?? null],
      );
      if (rows.length === 0) {
        if (env === undefined && distinctId === undefined) await this.objects.deleteProject(projectId);
        return deleted;
      }
      for (const row of rows) {
        await this.deleteSession(projectId, row.id, actor, now);
        deleted += 1;
      }
    }
  }

  private async failProjectDeletionJob(projectId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE replay_project_deletion_jobs
       SET attempts = attempts + 1,
           retry_after = $2 + interval '5 seconds' * power(2, LEAST(attempts, 10)),
           claimed_until = '-infinity',
           last_error = 'project replay object cleanup or metadata finalization failed'
       WHERE project_id = $1`,
      [projectId, now],
    ).catch(() => {});
  }

  private async getRawSession(
    projectId: string,
    env: string,
    replayId: string,
    allowDeleting = false,
  ): Promise<ReplayRow> {
    const { rows } = await this.pool.query<ReplayRow>(
      `${SESSION_SELECT} WHERE rs.project_id = $1 AND rs.env = $2 AND rs.id = $3`,
      [projectId, env, replayId],
    );
    if (!rows[0]) throw notFound('session_replay');
    if (rows[0].status === 'deleted' || rows[0].status === 'deleting' && !allowDeleting) {
      throw new ApiError(410, 'session_replay_deleted', 'session replay is deleted');
    }
    return rows[0];
  }

  private async lockSession(
    client: pg.PoolClient,
    projectId: string,
    env: string,
    replayId: string,
  ): Promise<ReplayRow> {
    const { rows } = await client.query<ReplayRow>(
      `${SESSION_SELECT}
       WHERE rs.project_id = $1 AND rs.env = $2 AND rs.id = $3
       FOR UPDATE OF rs`,
      [projectId, env, replayId],
    );
    if (!rows[0]) throw notFound('session_replay');
    return rows[0];
  }

  private async assertProjectReplayWritable(client: pg.PoolClient, projectId: string): Promise<void> {
    const { rows } = await client.query<{ replay_deletion_pending: boolean }>(
      `SELECT replay_deletion_pending FROM projects
       WHERE id = $1 FOR SHARE`,
      [projectId],
    );
    if (!rows[0] || rows[0].replay_deletion_pending) {
      throw new ApiError(410, 'replay_project_deleting', 'project deletion has disabled replay recording');
    }
  }

  private assertUploadAllowed(session: ReplayRow, token: string, now: Date, allowCompleted = false): void {
    this.assertToken(session.upload_token_hash, token);
    if (session.status === 'deleting' || session.status === 'deleted') {
      throw new ApiError(410, 'session_replay_deleted', 'session replay is deleted');
    }
    if (!allowCompleted && session.status === 'playable') {
      throw new ApiError(409, 'session_replay_completed', 'session replay is already complete');
    }
    if (now.getTime() - new Date(session.started_at).getTime() > REPLAY_LIMITS.maxSessionDurationMs + 5 * 60_000) {
      throw new ApiError(410, 'session_replay_expired', 'session replay upload window has expired');
    }
  }

  private assertToken(expectedHash: string, token: string): void {
    const actual = Buffer.from(hashToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ApiError(403, 'replay_upload_token_invalid', 'replay upload token is invalid for this session');
    }
  }
}

function replayDeadlineError(): ApiError {
  return new ApiError(
    504,
    'replay_response_deadline_exceeded',
    'replay payload could not be read within the bounded response deadline',
    'retry the replay read later',
    { retryable: true },
  );
}

function projectDeletionResult(job: ProjectDeletionJobRow): ReplayProjectDeletionResult {
  return {
    artifactsDeleted: Number(job.artifacts_deleted),
    eventsDeleted: Number(job.events_deleted),
    replaysDeleted: Number(job.replays_deleted),
  };
}

function assertReplayDeadline(expiresAt: number): void {
  if (Date.now() >= expiresAt) throw replayDeadlineError();
}

async function withinReplayDeadline<T>(operation: Promise<T>, expiresAt: number): Promise<T> {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw replayDeadlineError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(replayDeadlineError()), remaining);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function purgeExpiredReplays(
  service: ReplayService,
  pool: pg.Pool,
  limit = 100,
  now = new Date(),
): Promise<{ deleted: number; errors: number; hasMore: boolean }> {
  const { rows } = await pool.query<{ id: string; project_id: string }>(
    `WITH candidates AS (
       SELECT id FROM replay_sessions
       WHERE delete_after <= $1 AND status <> 'deleted'
         AND delete_retry_after <= $1 AND deletion_claimed_until <= $1
       ORDER BY delete_attempts, delete_after, id
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE replay_sessions sessions
     SET deletion_claimed_until = $1 + interval '2 minutes'
     FROM candidates
     WHERE sessions.id = candidates.id
     RETURNING sessions.id, sessions.project_id`,
    [now, limit],
  );
  let deleted = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      await service.deleteSession(row.project_id, row.id, 'retention:worker', now);
      deleted += 1;
    } catch {
      errors += 1;
    }
  }
  const more = await pool.query<{ has_more: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM replay_sessions
       WHERE delete_after <= $1 AND status <> 'deleted'
         AND delete_retry_after <= $1 AND deletion_claimed_until <= $1
     ) AS has_more`,
    [now],
  );
  return { deleted, errors, hasMore: more.rows[0]?.has_more === true };
}

function publicSession(row: ReplayRow): ReplaySessionSummary {
  return {
    id: row.id,
    surface: row.surface,
    route: row.route,
    env: row.env,
    session_id: row.session_id,
    distinct_id: row.distinct_id,
    host: row.host,
    version: row.version,
    device: row.device,
    consent_version: row.consent_version,
    policy_version: row.policy_version,
    text_mode: row.text_mode,
    status: row.status,
    chunk_count: Number(row.chunk_count),
    event_count: Number(row.event_count),
    byte_size: Number(row.byte_size),
    started_at: row.started_at,
    completed_at: row.completed_at,
    delete_after: row.delete_after,
    viewer_path: `/experience?replay=${row.id}&env=${encodeURIComponent(row.env)}`,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function corruptReplay(message: string): ApiError {
  return new ApiError(409, 'replay_object_corrupt', message);
}

function isExpired(row: Pick<ReplayRow, 'delete_after'>, now = new Date()): boolean {
  return new Date(row.delete_after).getTime() <= now.getTime();
}
