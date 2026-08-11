import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;
const waitForBatchPurgeLock = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await env.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE '%id = ANY%'
           AND query LIKE '%FOR UPDATE%'
       ) AS waiting`,
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('batched purge did not reach the expected row lock');
};

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('projects admin', () => {
  it('lists projects with stats and scope for a personal token', async () => {
    const res = await api(env, env.personalToken, 'GET', '/api/v1/projects');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('org');
    const p = res.body.projects.find((x: any) => x.slug === env.projectSlug);
    expect(p).toMatchObject({
      active_metrics: expect.any(Number), proposed_metrics: expect.any(Number), active_outcome_contracts: expect.any(Number), funnels: expect.any(Number),
      events_24h: expect.any(Number), events_7d: expect.any(Number), events_30d: expect.any(Number),
      key_outcome_available: expect.any(Boolean), health: expect.stringMatching(/^(healthy|needs_attention|no_data)$/),
      attention: expect.any(Array),
      health_evaluation: {
        source: 'server',
        evaluated_at: expect.any(String),
        guardrails: expect.arrayContaining([
          expect.objectContaining({ id: 'recent_data', state: expect.stringMatching(/^(pass|fail)$/) }),
          expect.objectContaining({ id: 'registered_coverage', state: expect.stringMatching(/^(pass|fail|not_applicable)$/) }),
          expect.objectContaining({ id: 'active_outcome', state: expect.stringMatching(/^(pass|fail)$/) }),
          expect.objectContaining({ id: 'metric_review_queue', state: expect.stringMatching(/^(pass|fail)$/) }),
        ]),
      },
    });
  });

  it('scopes a secret key to its own project', async () => {
    const res = await api(env, env.secretToken, 'GET', '/api/v1/projects');
    expect(res.body.scope).toBe('project');
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].slug).toBe(env.projectSlug);
  });

  it('creates a project with a personal token', async () => {
    const slug = `new-${Date.now()}`;
    const res = await api(env, env.personalToken, 'POST', '/api/v1/projects', { slug, name: 'New One' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(slug);
    const list = await api(env, env.personalToken, 'GET', '/api/v1/projects');
    expect(list.body.projects.map((p: any) => p.slug)).toContain(slug);
  });

  it('rejects an invalid slug', async () => {
    const res = await api(env, env.personalToken, 'POST', '/api/v1/projects', { slug: 'Bad Slug!', name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_slug');
  });

  it('409s on a duplicate slug', async () => {
    const res = await api(env, env.personalToken, 'POST', '/api/v1/projects', { slug: env.projectSlug, name: 'dup' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('slug_taken');
  });

  it('requires the exact slug and deletes only the confirmed project with all project-scoped data', async () => {
    const slug = `delete-${Date.now()}`;
    const created = await api(env, env.personalToken, 'POST', '/api/v1/projects', { slug, name: 'Delete me' });
    expect(created.status).toBe(201);

    const project = await env.pool.query<{ id: string; org_id: string }>(
      'SELECT id, org_id FROM projects WHERE slug = $1',
      [slug],
    );
    const projectId = project.rows[0]!.id;
    const orgId = project.rows[0]!.org_id;
    const key = await api(env, env.personalToken, 'POST', `/api/v1/projects/${slug}/keys`, { kind: 'ingest' });
    expect(key.status).toBe(201);
    expect((await api(env, key.body.token, 'POST', '/i/v1/events', {
      events: [{ event: 'delete.tested', distinct_id: 'local-user' }],
    })).status).toBe(200);

    const actorLink = await env.pool.query<{ id: string }>(
      `INSERT INTO actor_links (
         project_id, env, source_distinct_id, target_distinct_id, created_by
       ) VALUES ($1, 'prod', 'anon-delete', 'user-delete', 'test')
       RETURNING id`,
      [projectId],
    );
    await env.pool.query(
      `INSERT INTO actor_link_audit (
         actor_link_id, project_id, env, action, actor, snapshot
       ) VALUES ($1, $2, 'prod', 'created', 'test', '{}'::jsonb)`,
      [actorLink.rows[0]!.id, projectId],
    );
    await env.pool.query(
      `INSERT INTO usage_ledger (
         org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key
       ) VALUES ($1, $2, 'prod', 'events_stored', date_trunc('month', now())::date, 1, $3, $3)`,
      [orgId, projectId, `delete-${projectId}`],
    );

    const mismatch = await api(env, env.personalToken, 'DELETE', `/api/v1/projects/${slug}`, {
      confirm_slug: 'another-project',
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('confirmation_mismatch');

    const deleted = await api(env, env.personalToken, 'DELETE', `/api/v1/projects/${slug}`, {
      confirm_slug: slug,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, slug });

    const remaining = await env.pool.query<{ projects: number; events: number; keys: number; audits: number; usage: number }>(
      `SELECT
         (SELECT count(*)::int FROM projects WHERE id = $1) AS projects,
         (SELECT count(*)::int FROM events WHERE project_id = $1) AS events,
         (SELECT count(*)::int FROM api_keys WHERE project_id = $1) AS keys,
         (SELECT count(*)::int FROM actor_link_audit WHERE project_id = $1) AS audits,
         (SELECT count(*)::int FROM usage_ledger WHERE project_id = $1) AS usage`,
      [projectId],
    );
    expect(remaining.rows[0]).toEqual({ projects: 0, events: 0, keys: 0, audits: 0, usage: 0 });
    expect((await api(env, env.personalToken, 'GET', '/api/v1/projects')).body.projects.map((p: any) => p.slug))
      .toContain(env.projectSlug);
  });

  it('does not let an exact-project secret key delete its project', async () => {
    const denied = await api(env, env.secretToken, 'DELETE', `/api/v1/projects/${env.projectSlug}`, {
      confirm_slug: env.projectSlug,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');
  });

  it('keeps every project reference cascading so deletion cannot strand tenant data', async () => {
    const constraints = await env.pool.query<{ table_name: string; constraint_name: string }>(
      `SELECT conrelid::regclass::text AS table_name, conname AS constraint_name
       FROM pg_constraint
       WHERE contype = 'f'
         AND confrelid = 'projects'::regclass
         AND confdeltype <> 'c'
       ORDER BY 1, 2`,
    );
    expect(constraints.rows).toEqual([]);
  });
});

describe('api key admin', () => {
  it('lists the project keys (masked, no token)', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/keys`);
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBeGreaterThanOrEqual(3); // ingest prod, ingest dev, secret
    expect(res.body.keys[0]).not.toHaveProperty('token');
    expect(res.body.keys[0]).not.toHaveProperty('token_hash');
    expect(res.body.keys[0]).toHaveProperty('last_used_at');
    expect(res.body.keys[0].masked_token).toMatch(/^(pk|sk)_\.\.\.[a-f0-9]{4}$/);
    expect(res.body.keys.some((key: any) => key.kind === 'secret' && key.last_used_at)).toBe(true);
  });

  it('issues an ingest key and returns the token exactly once', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/keys`, { kind: 'ingest', env: 'prod', label: 'web' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^pk_/);
    expect(res.body.id).toBeDefined();
  });

  it('issues a secret key', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/keys`, { kind: 'secret' });
    expect(res.body.token).toMatch(/^sk_/);
  });

  it('rejects an invalid key kind', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/keys`, { kind: 'personal' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_kind');
  });

  it('revokes a key so it can no longer be used', async () => {
    const issued = await api(env, env.secretToken, 'POST', `${P()}/keys`, { kind: 'ingest' });
    const token = issued.body.token;
    // it works before revoke
    const before = await api(env, token, 'POST', '/i/v1/events', { events: [{ event: 'x.y', distinct_id: 'a' }] });
    expect(before.status).toBe(200);
    // revoke
    const rev = await api(env, env.secretToken, 'POST', `${P()}/keys/${issued.body.id}/revoke`);
    expect(rev.body.revoked).toBe(true);
    // now rejected
    const after = await api(env, token, 'POST', '/i/v1/events', { events: [{ event: 'x.y', distinct_id: 'a' }] });
    expect(after.status).toBe(401);
  });

  it('forbids ingest keys from the key admin routes', async () => {
    const res = await api(env, env.ingestToken, 'GET', `${P()}/keys`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_key_kind');
  });

  it("won't let a project's secret key revoke another project's key in the same org", async () => {
    // Second project B in the same org, with its own ingest key.
    const slugB = `proj-b-${Date.now()}`;
    const created = await api(env, env.personalToken, 'POST', '/api/v1/projects', { slug: slugB, name: 'B' });
    expect(created.status).toBe(201);
    const keyB = await api(env, env.personalToken, 'POST', `/api/v1/projects/${slugB}/keys`, { kind: 'ingest' });
    expect(keyB.status).toBe(201);
    const tokenB = keyB.body.token;

    // Project A's secret key tries to revoke B's key via A's slug — must NOT succeed.
    const attempt = await api(env, env.secretToken, 'POST', `${P()}/keys/${keyB.body.id}/revoke`);
    expect(attempt.status).toBe(404);

    // B's key is still usable.
    const stillWorks = await api(env, tokenB, 'POST', '/i/v1/events', { events: [{ event: 'x.y', distinct_id: 'a' }] });
    expect(stillWorks.status).toBe(200);
  });
});

describe('destructive actions', () => {
  it('deletes a metric, but refuses while a funnel references it', async () => {
    // two metrics + a funnel using them
    for (const key of ['del_a', 'del_b']) {
      await api(env, env.secretToken, 'POST', `${P()}/metrics`, {
        key, name: key, purpose: `metric ${key} used in the delete-guard test scenario`,
        type: 'count', source: { event: `${key}.done` },
      });
    }
    await api(env, env.secretToken, 'POST', `${P()}/funnels`, {
      key: 'del_funnel', name: 'Del funnel', goal: 'A funnel that references metrics under deletion test.',
      steps: [{ metric_key: 'del_a', label: 'A' }, { metric_key: 'del_b', label: 'B' }],
    });
    // refused while referenced
    const refused = await api(env, env.secretToken, 'DELETE', `${P()}/metrics/del_a`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('metric_in_use');
    // delete the funnel, then the metric deletes
    const df = await api(env, env.secretToken, 'DELETE', `${P()}/funnels/del_funnel`);
    expect(df.body.deleted).toBe(true);
    const ok = await api(env, env.secretToken, 'DELETE', `${P()}/metrics/del_a`);
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(true);
    // gone from the registry
    const list = await api(env, env.secretToken, 'GET', `${P()}/metrics`);
    expect(list.body.metrics.map((m: any) => m.key)).not.toContain('del_a');
  });

  it('purges events for the project (env-scoped, slug-confirmed)', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'purge.me', distinct_id: 'p1' }, { event: 'purge.me', distinct_id: 'p2' }],
    });
    const before = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100`);
    expect(before.body.events.length).toBeGreaterThan(0);
    const purge = await api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
      env: 'prod', scope: 'events', confirm_slug: env.projectSlug,
    });
    expect(purge.status).toBe(200);
    expect(purge.body.events_deleted).toBeGreaterThan(0);
    const after = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100`);
    expect(after.body.events).toHaveLength(0);
  });

  it('purges only one actor when distinct_id is given', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'a.b', distinct_id: 'keep' }, { event: 'a.b', distinct_id: 'drop' }],
    });
    await api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
      env: 'prod', scope: 'events', confirm_slug: env.projectSlug, distinct_id: 'drop',
    });
    const sample = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100`);
    const ids = sample.body.events.map((e: any) => e.distinct_id);
    expect(ids).toContain('keep');
    expect(ids).not.toContain('drop');
  });

  it('purges large event sets in bounded batches', async () => {
    const inserted = await env.pool.query<{ id: string }>(
      `INSERT INTO events (
         project_id, env, event, "timestamp", distinct_id, properties, registered
       )
       SELECT $1, 'purge-batch', 'purge.batch', now(),
              'batch-actor-' || n::text, '{}'::jsonb, false
       FROM generate_series(1, 1001) AS n
       RETURNING id`,
      [env.projectId],
    );
    const lastId = inserted.rows.map((row) => row.id).sort().at(-1)!;
    const blocker = await env.pool.connect();
    let purgePromise: ReturnType<typeof api> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT id FROM events
         WHERE project_id = $1 AND env = 'purge-batch' AND id = $2
         FOR UPDATE`,
        [env.projectId, lastId],
      );
      purgePromise = api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
        env: 'purge-batch', scope: 'events', confirm_slug: env.projectSlug,
      });
      await waitForBatchPurgeLock();
      await env.pool.query(
        `INSERT INTO events (
           project_id, env, event, "timestamp", distinct_id, properties, registered
         ) VALUES ($1, 'purge-batch', 'purge.late', now(),
                   'late-actor', '{}'::jsonb, false)`,
        [env.projectId],
      );
      await blocker.query('COMMIT');
      const purge = await purgePromise;
      expect(purge.status).toBe(200);
      expect(purge.body.events_deleted).toBe(1001);
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => {});
      await purgePromise?.catch(() => {});
      throw error;
    } finally {
      blocker.release();
    }
    const remaining = await env.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM events
       WHERE project_id = $1 AND env = 'purge-batch'`,
      [env.projectId],
    );
    expect(remaining.rows[0]?.count).toBe(1);
  });

  it('rejects distinct_id combined with a non-events scope', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
      env: 'prod', scope: 'all', confirm_slug: env.projectSlug, distinct_id: 'someone',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_scope');
  });

  it('rejects a purge whose confirm_slug does not match', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
      env: 'prod', scope: 'all', confirm_slug: 'wrong-slug',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('confirmation_mismatch');
  });

  it('forbids a personal token from purging (secret-key only)', async () => {
    const res = await api(env, env.personalToken, 'POST', `${P()}/data/purge`, {
      env: 'prod', scope: 'events', confirm_slug: env.projectSlug,
    });
    expect(res.status).toBe(403);
  });
});

describe('ingest warnings (error log)', () => {
  it('logs rejected and unregistered events, deduped with a count', async () => {
    // one valid-but-unregistered event (twice) + one malformed event
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        { event: 'wild.thing', distinct_id: 'w1' },
        { event: 'wild.thing', distinct_id: 'w2' },
        { event: 'BadName!!', distinct_id: 'w3' },
      ],
    });
    const res = await api(env, env.secretToken, 'GET', `${P()}/ingest-warnings`);
    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(res.body.warnings.map((w: any) => [`${w.kind}:${w.event}`, w]));
    expect(byKind['unregistered:wild.thing'].count).toBe(2); // deduped in one batch
    expect(byKind['rejected:BadName!!']).toBeDefined();
  });

  it('accumulates the count across batches and can be cleared', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/events', { events: [{ event: 'wild.thing', distinct_id: 'w4' }] });
    const after = await api(env, env.secretToken, 'GET', `${P()}/ingest-warnings?kind=unregistered`);
    const w = after.body.warnings.find((x: any) => x.event === 'wild.thing');
    expect(w.count).toBe(3); // 2 + 1

    const cleared = await api(env, env.secretToken, 'DELETE', `${P()}/ingest-warnings`);
    expect(cleared.body.cleared).toBeGreaterThan(0);
    const empty = await api(env, env.secretToken, 'GET', `${P()}/ingest-warnings`);
    expect(empty.body.warnings).toHaveLength(0);
  });
});

describe('data quality diagnostics', () => {
  it('flags entities whose current status contradicts a terminal event', async () => {
    await api(env, env.secretToken, 'POST', `${P()}/entity-types`, {
      name: 'brief',
      description: 'Brief documents used to test entity and event consistency.',
    });
    await api(env, env.secretToken, 'POST', `${P()}/metrics`, {
      key: 'brief_completed',
      name: 'Brief completed',
      purpose: 'Detects when a user completes a generated brief.',
      type: 'count',
      source: { event: 'brief.completed' },
    });
    await api(env, env.secretToken, 'PATCH', `${P()}/metrics/brief_completed`, { status: 'active' });
    await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [{ entity_type: 'brief', entity_id: 'bd-101', properties: { status: 'new', title: 'Seed brief' } }],
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'brief.completed', distinct_id: 'u1', properties: { brief_id: 'bd-101' } }],
    });

    const res = await api(env, env.secretToken, 'GET', `${P()}/data-quality?env=prod`);
    expect(res.status).toBe(200);
    expect(res.body.issues).toContainEqual(expect.objectContaining({
      kind: 'entity_event_status_conflict',
      severity: 'warning',
      entity_type: 'brief',
      entity_id: 'bd-101',
      current_status: 'new',
      expected_status: 'completed',
      event: 'brief.completed',
      evidence_events: 1,
    }));
  });

  it('applies limit after filtering matching entity statuses', async () => {
    await api(env, env.secretToken, 'POST', `${P()}/entity-types`, {
      name: 'review_brief',
      description: 'Review brief documents used to test data-quality limit semantics.',
    });
    await api(env, env.secretToken, 'POST', `${P()}/metrics`, {
      key: 'review_brief_completed',
      name: 'Review brief completed',
      purpose: 'Detects completed review brief documents for data-quality diagnostics.',
      type: 'count',
      source: { event: 'review_brief.completed' },
    });
    await api(env, env.secretToken, 'PATCH', `${P()}/metrics/review_brief_completed`, { status: 'active' });

    await api(env, env.ingestDevToken, 'POST', '/i/v1/entities', {
      entities: [
        ...Array.from({ length: 5 }, (_, i) => ({
          entity_type: 'review_brief',
          entity_id: `ok-${i}`,
          properties: { status: 'completed' },
        })),
        { entity_type: 'review_brief', entity_id: 'conflict-old', properties: { status: 'new' } },
      ],
    });
    await api(env, env.ingestDevToken, 'POST', '/i/v1/events', {
      events: [
        ...Array.from({ length: 5 }, (_, i) => ({
          event: 'review_brief.completed',
          distinct_id: `ok-user-${i}`,
          timestamp: hoursAgo(i + 1),
          properties: { review_brief_id: `ok-${i}` },
        })),
        {
          event: 'review_brief.completed',
          distinct_id: 'conflict-user',
          timestamp: hoursAgo(12),
          properties: { review_brief_id: 'conflict-old' },
        },
      ],
    });

    const res = await api(env, env.secretToken, 'GET', `${P()}/data-quality?env=dev&limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0]).toMatchObject({
      entity_type: 'review_brief',
      entity_id: 'conflict-old',
      current_status: 'new',
      expected_status: 'completed',
    });
  });
});

describe('standard endpoint', () => {
  it('returns the instrumentation standard markdown', async () => {
    const res = await api(env, env.secretToken, 'GET', '/api/v1/standard');
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('Instrumentation Standard');
  });
});
