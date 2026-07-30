import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;

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
    expect(p).toMatchObject({ active_metrics: expect.any(Number), funnels: expect.any(Number), events_30d: expect.any(Number) });
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
});

describe('api key admin', () => {
  it('lists the project keys (masked, no token)', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/keys`);
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBeGreaterThanOrEqual(3); // ingest prod, ingest dev, secret
    expect(res.body.keys[0]).not.toHaveProperty('token');
    expect(res.body.keys[0]).not.toHaveProperty('token_hash');
    expect(res.body.keys[0].masked_token).toMatch(/^(pk|sk)_\.\.\.[a-f0-9]{4}$/);
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
