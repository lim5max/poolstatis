import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { ActorLinkInput } from '../schemas.js';

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

const LINK_COLS = `id, env, source_distinct_id, target_distinct_id, status,
  created_by, created_at, revoked_by, revoked_at`;

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
