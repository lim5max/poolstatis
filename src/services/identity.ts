import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { ActorLinkInput } from '../schemas.js';
import type { ActorIdentityStatus } from '../stores/eventStore.js';

export interface ActorLink {
  id: string;
  env: string;
  source_distinct_id: string;
  target_distinct_id: string;
  status: 'active' | 'revoked';
  created_by: string;
  created_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
}

export interface ActorLinkAudit {
  id: string;
  actor_link_id: string;
  action: 'created' | 'revoked';
  actor: string;
  snapshot: ActorLink;
  created_at: string;
}

export interface ActorIdentity {
  requested_distinct_id: string;
  distinct_id: string;
  status: ActorIdentityStatus;
  raw_actor_count: number;
  raw_distinct_ids: string[];
  raw_distinct_ids_truncated: boolean;
  links: ActorLink[];
  links_truncated: boolean;
}

const LINK_COLS = `id, env, source_distinct_id, target_distinct_id, status,
  created_by, created_at, revoked_by, revoked_at`;

export interface ActorCursorSecurity {
  identityRevision: string;
  signingKey: string | null;
}

export async function actorCursorSecurity(
  pool: pg.Pool,
  projectId: string,
  env: string,
  cursorSigningSecret?: string,
): Promise<ActorCursorSecurity> {
  const { rows } = await pool.query<{ identity_revision: string }>(
    `SELECT md5(COALESCE(string_agg(
       id::text || ':' || status || ':' || created_at::text || ':'
         || COALESCE(revoked_at::text, ''),
       ',' ORDER BY id
     ), '')) AS identity_revision
     FROM actor_links
     WHERE project_id = $1 AND env = $2`,
    [projectId, env],
  );
  return {
    identityRevision: rows[0]?.identity_revision ?? '',
    signingKey: cursorSigningSecret
      ? createHmac('sha256', cursorSigningSecret).update(projectId).digest('base64url')
      : null,
  };
}

export async function createActorLink(
  pool: pg.Pool,
  projectId: string,
  input: ActorLinkInput,
  actor: string,
): Promise<ActorLink> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      ['actor-links:' + projectId + ':' + input.env],
    );

    const existing = await client.query<ActorLink>(
      `SELECT ${LINK_COLS} FROM actor_links
       WHERE project_id = $1 AND env = $2
         AND source_distinct_id = $3 AND status = 'active'`,
      [projectId, input.env, input.source_distinct_id],
    );
    if (existing.rows[0]) {
      throw new ApiError(
        409,
        'actor_link_conflict',
        `actor "${input.source_distinct_id}" already has an active identity link`,
        'revoke the existing link before correcting this identity',
      );
    }

    const cycle = await client.query(
      `WITH RECURSIVE chain(actor) AS (
         SELECT $3::text
         UNION
         SELECT links.target_distinct_id
         FROM chain
         JOIN actor_links links
           ON links.project_id = $1
          AND links.env = $2
          AND links.source_distinct_id = chain.actor
          AND links.status = 'active'
       )
       SELECT 1 FROM chain WHERE actor = $4 LIMIT 1`,
      [projectId, input.env, input.target_distinct_id, input.source_distinct_id],
    );
    if (cycle.rowCount) {
      throw new ApiError(
        400,
        'actor_link_cycle',
        'this actor link would create a contradictory identity cycle',
        'link an anonymous or superseded id toward its final stable identified id',
      );
    }

    const inserted = await client.query<ActorLink>(
      `INSERT INTO actor_links (
         project_id, env, source_distinct_id, target_distinct_id, created_by
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${LINK_COLS}`,
      [projectId, input.env, input.source_distinct_id, input.target_distinct_id, actor],
    );
    const link = inserted.rows[0]!;
    await appendAudit(client, projectId, link, 'created', actor);
    await client.query('COMMIT');
    return link;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeActorLink(
  pool: pg.Pool,
  projectId: string,
  id: string,
  actor: string,
): Promise<ActorLink> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<ActorLink>(
      `UPDATE actor_links
       SET status = 'revoked', revoked_by = $3, revoked_at = now()
       WHERE project_id = $1 AND id = $2 AND status = 'active'
       RETURNING ${LINK_COLS}`,
      [projectId, id, actor],
    );
    const link = updated.rows[0];
    if (!link) throw notFound('actor_link', 'the link may already be revoked');
    await appendAudit(client, projectId, link, 'revoked', actor);
    await client.query('COMMIT');
    return link;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listActorLinks(
  pool: pg.Pool,
  projectId: string,
  env: string,
): Promise<{ links: ActorLink[]; audit: ActorLinkAudit[] }> {
  const [links, audit] = await Promise.all([
    pool.query<ActorLink>(
      `SELECT ${LINK_COLS} FROM actor_links
       WHERE project_id = $1 AND env = $2
       ORDER BY created_at DESC, id`,
      [projectId, env],
    ),
    pool.query<ActorLinkAudit>(
      `SELECT id, actor_link_id, action, actor, snapshot, created_at
       FROM actor_link_audit
       WHERE project_id = $1 AND env = $2
       ORDER BY created_at DESC, id DESC`,
      [projectId, env],
    ),
  ]);
  return { links: links.rows, audit: audit.rows };
}

/**
 * Resolve one canonical population and its active server-owned link
 * provenance. No identity class is inferred from ID spelling or entity
 * properties: without a link, the only truthful status is `unknown`.
 */
export async function resolveActorIdentity(
  pool: pg.Pool,
  projectId: string,
  env: string,
  requestedDistinctId: string,
  limit = 100,
  snapshotIngestedAt = new Date(),
): Promise<ActorIdentity> {
  const canonicalResult = await pool.query<{ distinct_id: string }>(
    `SELECT poolstatis_resolve_actor($1::uuid, $2, $3) AS distinct_id`,
    [projectId, env, requestedDistinctId],
  );
  const distinctId = canonicalResult.rows[0]!.distinct_id;
  const [populationResult, linksResult] = await Promise.all([
    pool.query<{
      count: string;
      raw_distinct_ids: string[] | null;
      ambiguous: boolean;
    }>(
      `WITH RECURSIVE reverse_chain(raw_id, path, cycle) AS (
         SELECT $3::text, ARRAY[$3::text], false
         UNION ALL
         SELECT links.source_distinct_id,
                ARRAY[links.source_distinct_id]::text[] || chain.path,
                links.source_distinct_id = ANY(chain.path)
         FROM reverse_chain chain
         JOIN actor_links links
           ON links.project_id = $1 AND links.env = $2
          AND links.status = 'active'
          AND links.target_distinct_id = chain.raw_id
         WHERE NOT chain.cycle
       ), candidates AS MATERIALIZED (
         SELECT DISTINCT raw_id FROM reverse_chain WHERE NOT cycle
       ), observed AS MATERIALIZED (
         SELECT DISTINCT events.distinct_id AS raw_id
         FROM events
         JOIN candidates ON candidates.raw_id = events.distinct_id
         WHERE events.project_id = $1 AND events.env = $2
           AND events.ingested_at <= $6
       ), seeds AS MATERIALIZED (
         SELECT raw_id FROM observed
         UNION SELECT $4::text
       ), actor_chain(raw_id, current_id, path, depth, cycle) AS (
         SELECT raw_id, raw_id, ARRAY[raw_id]::text[], 0, false
         FROM seeds
         UNION ALL
         SELECT chain.raw_id, links.target_distinct_id,
                chain.path || links.target_distinct_id,
                chain.depth + 1,
                links.target_distinct_id = ANY(chain.path)
         FROM actor_chain chain
         JOIN actor_links links
           ON links.project_id = $1 AND links.env = $2
          AND links.status = 'active'
          AND links.source_distinct_id = chain.current_id
         WHERE NOT chain.cycle
       ), actor_map AS MATERIALIZED (
         SELECT DISTINCT ON (raw_id)
                raw_id, current_id AS actor_id
         FROM actor_chain
         WHERE NOT cycle
         ORDER BY raw_id, depth DESC, current_id
       ), matching AS MATERIALIZED (
         SELECT observed.raw_id
         FROM observed
         JOIN actor_map ON actor_map.raw_id = observed.raw_id
         WHERE actor_map.actor_id = $3
       )
       SELECT
         (SELECT count(*)::text FROM matching) AS count,
         (
           SELECT array_agg(raw_id ORDER BY raw_id)
           FROM (
             SELECT raw_id FROM matching ORDER BY raw_id LIMIT $5
           ) bounded
         ) AS raw_distinct_ids,
         (
           EXISTS (SELECT 1 FROM reverse_chain WHERE cycle)
           OR EXISTS (
             SELECT 1
             FROM actor_chain
             WHERE cycle
               AND (
                 raw_id = $4
                 OR raw_id IN (SELECT raw_id FROM matching)
               )
           )
         ) AS ambiguous`,
      [projectId, env, distinctId, requestedDistinctId, limit + 1, snapshotIngestedAt],
    ),
    pool.query<ActorLink>(
      `WITH RECURSIVE provenance AS (
         SELECT l.*, ARRAY[l.source_distinct_id, l.target_distinct_id]::text[] AS path
         FROM actor_links l
         WHERE l.project_id = $1 AND l.env = $2 AND l.status = 'active'
           AND l.target_distinct_id = $3
         UNION ALL
         SELECT l.*, ARRAY[l.source_distinct_id]::text[] || p.path
         FROM actor_links l
         JOIN provenance p ON p.source_distinct_id = l.target_distinct_id
         WHERE l.project_id = $1 AND l.env = $2 AND l.status = 'active'
           AND NOT l.source_distinct_id = ANY(p.path)
       )
       SELECT ${LINK_COLS}
       FROM provenance
       ORDER BY created_at, id
       LIMIT $4`,
      [projectId, env, distinctId, limit + 1],
    ),
  ]);
  const population = populationResult.rows[0];
  const rawActorCount = Number(population?.count ?? 0);
  const rawDistinctIds = population?.raw_distinct_ids ?? [];
  const visibleRawDistinctIds = rawDistinctIds.slice(0, limit);
  const links = linksResult.rows.slice(0, limit);
  const ambiguous = population?.ambiguous === true;
  return {
    requested_distinct_id: requestedDistinctId,
    distinct_id: distinctId,
    status: ambiguous
      ? 'ambiguous'
      : links.length > 0 || rawActorCount > 1
        ? 'linked'
        : 'unknown',
    raw_actor_count: rawActorCount,
    raw_distinct_ids: visibleRawDistinctIds,
    raw_distinct_ids_truncated: rawDistinctIds.length > limit,
    links,
    links_truncated: linksResult.rows.length > limit,
  };
}

async function appendAudit(
  client: pg.PoolClient,
  projectId: string,
  link: ActorLink,
  action: ActorLinkAudit['action'],
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO actor_link_audit (
       actor_link_id, project_id, env, action, actor, snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [link.id, projectId, link.env, action, actor, JSON.stringify(link)],
  );
}
