import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let other: TestEnv;

const project = () => `/api/v1/projects/${env.projectSlug}`;
const window = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
};

async function actors(
  input: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return api(env, env.secretToken, 'POST', `${project()}/query`, {
    kind: 'actors',
    env: 'prod',
    ...window,
    ...input,
  });
}

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  other = await createTestEnv({ ingestBuffer: false, queryCache: false });

  await activeMetric(env, {
    key: 'actor_activity',
    type: 'count',
    source: { event: 'activity.performed', filters: [] },
  });
  const browserSetup = await api(env, env.secretToken, 'POST', `${project()}/properties/browser-analytics`, {
    route_keys: ['home'],
  });
  expect(browserSetup.status).toBe(200);
  const trustedRoute = await api(
    env,
    env.secretToken,
    'PATCH',
    `${project()}/properties/event/$route_key`,
    { status: 'trusted' },
  );
  expect(trustedRoute.status).toBe(200);
  const activeBrowserMetric = await api(
    env,
    env.secretToken,
    'PATCH',
    `${project()}/metrics/web_page_views`,
    { status: 'active' },
  );
  expect(activeBrowserMetric.status).toBe(200);

  const prod = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    events: [
      {
        event: 'activity.performed',
        distinct_id: 'anon-a',
        session_id: 'generic-session',
        timestamp: '2026-07-10T10:00:00.000Z',
        properties: { email: 'private@example.test', plan: 'pro' },
      },
      {
        event: 'activity.performed',
        distinct_id: 'stable-a',
        timestamp: '2026-07-20T10:00:00.000Z',
        properties: { name: 'Private Name' },
      },
      {
        event: 'page.viewed',
        distinct_id: 'stable-a',
        session_id: 'browser-session-a',
        timestamp: '2026-07-21T10:00:00.000Z',
        properties: {
          $browser_context: '1',
          $route_key: 'home',
          $page_view_id: 'page-a',
        },
      },
      {
        event: 'unregistered.private_payload',
        distinct_id: 'stable-a',
        timestamp: '2026-07-22T10:00:00.000Z',
        properties: { raw_text: 'must not be surfaced' },
      },
      {
        event: 'activity.performed',
        distinct_id: 'unknown-b',
        session_id: 'generic-session-b',
        timestamp: '2026-07-20T10:00:00.000Z',
        properties: { email: 'unknown@example.test' },
      },
      {
        event: 'activity.performed',
        distinct_id: 'unknown-b-suffix',
        timestamp: '2026-07-19T10:00:00.000Z',
      },
    ],
  });
  expect(prod.status).toBe(200);

  const dev = await api(env, env.ingestDevToken, 'POST', '/i/v1/events', {
    events: [{
      event: 'activity.performed',
      distinct_id: 'dev-only',
      timestamp: '2026-07-20T10:00:00.000Z',
    }],
  });
  expect(dev.status).toBe(200);

  const otherTenant = await api(other, other.ingestToken, 'POST', '/i/v1/events', {
    events: [{
      event: 'activity.performed',
      distinct_id: 'other-tenant-only',
      timestamp: '2026-07-20T10:00:00.000Z',
    }],
  });
  expect(otherTenant.status).toBe(200);

  const link = await api(env, env.secretToken, 'POST', `${project()}/identity-links`, {
    source_distinct_id: 'anon-a',
    target_distinct_id: 'stable-a',
    env: 'prod',
  });
  expect(link.status).toBe(201);
});

afterAll(async () => {
  await env.close();
  await other.close();
});

describe('actors Query DSL contract', () => {
  it('resolves links, isolates tenant/env, masks unsupported properties and qualifies sessions', async () => {
    const result = await actors();
    expect(result.status).toBe(200);
    expect(result.body.kind).toBe('actors');
    expect(result.body.actors.map((actor: any) => actor.distinct_id))
      .toEqual(['stable-a', 'unknown-b', 'unknown-b-suffix']);
    expect(result.body.actors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ distinct_id: 'dev-only' }),
      expect.objectContaining({ distinct_id: 'other-tenant-only' }),
    ]));

    const linked = result.body.actors.find((actor: any) => actor.distinct_id === 'stable-a');
    expect(linked).toMatchObject({
      raw_actor_count: 2,
      total_events: 4,
      active_days: 4,
      session_count: 1,
      pinned_properties: {},
      identity_status: 'linked',
    });
    expect(linked.top_events).toEqual([
      { event: 'activity.performed', count: 2 },
      { event: 'page.viewed', count: 1 },
    ]);
    expect(linked.top_events.map((row: any) => row.event))
      .not.toContain('unregistered.private_payload');

    const unknown = result.body.actors.find((actor: any) => actor.distinct_id === 'unknown-b');
    expect(unknown).toMatchObject({
      raw_actor_count: 1,
      identity_status: 'unknown',
      session_count: null,
      pinned_properties: {},
    });
    expect(result.body.meta.capabilities).toMatchObject({
      property_filters: { available: false },
      pinned_properties: { available: false },
      session_count: { source: 'canonical_browser_sessions', unavailable_value: null },
    });
    expect(result.body.meta.provenance.top_events).toMatchObject({
      registered_only: true,
      limit: 8,
    });
  });

  it('uses exact-id search only and accepts an exact raw linked id', async () => {
    const exact = await actors({ search: { kind: 'exact_id', value: 'unknown-b' } });
    expect(exact.status).toBe(200);
    expect(exact.body.actors.map((actor: any) => actor.distinct_id)).toEqual(['unknown-b']);

    const noSubstring = await actors({ search: { kind: 'exact_id', value: 'unknown' } });
    expect(noSubstring.status).toBe(200);
    expect(noSubstring.body.actors).toEqual([]);

    const rawLinked = await actors({ search: { kind: 'exact_id', value: 'anon-a' } });
    expect(rawLinked.body.actors.map((actor: any) => actor.distinct_id)).toEqual(['stable-a']);
  });

  it('filters the population through an active native metric key, never a raw event name', async () => {
    const filtered = await actors({ activityMetric: 'actor_activity' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.actors.map((actor: any) => actor.distinct_id))
      .toEqual(['stable-a', 'unknown-b', 'unknown-b-suffix']);
    expect(filtered.body.meta.activity_metric).toMatchObject({
      key: 'actor_activity',
      source: 'native',
      population_filter: true,
    });

    const rawEvent = await actors({ activityMetric: 'activity.performed' });
    expect(rawEvent.status).toBe(400);
    expect(rawEvent.body.error.code).toBe('validation_error');
  });

  it('fails closed for actor property filters without a deterministic trusted source', async () => {
    const result = await actors({
      propertyFilters: [{ property: 'plan', op: 'eq', value: 'pro' }],
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({
      code: 'actors_property_filters_unavailable',
      retryable: false,
    });
  });

  it('returns stable opaque keyset pages for every supported order', async () => {
    for (const order of ['last_seen_desc', 'first_seen_desc', 'events_desc']) {
      const first = await actors({ order, limit: 1 });
      expect(first.status).toBe(200);
      expect(first.body.actors).toHaveLength(1);
      expect(first.body.meta.next_cursor).toEqual(expect.any(String));
      expect(first.body.meta.next_cursor).not.toContain(first.body.actors[0].distinct_id);

      const second = await actors({
        order,
        limit: 1,
        cursor: first.body.meta.next_cursor,
      });
      expect(second.status).toBe(200);
      expect(second.body.actors).toHaveLength(1);
      expect(second.body.actors[0].distinct_id).not.toBe(first.body.actors[0].distinct_id);
    }

    const invalid = await actors({ cursor: 'not-a-valid-cursor' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('actors_cursor_invalid');
  });

  it('applies trailing-30d, limit=50 and last_seen order defaults', async () => {
    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'actors',
      env: 'prod',
    });
    expect(result.status).toBe(200);
    const from = new Date(result.body.meta.date_range.from).getTime();
    const to = new Date(result.body.meta.date_range.to).getTime();
    expect(to - from).toBe(30 * 24 * 60 * 60_000);
    expect(result.body.meta).toMatchObject({
      limit: 50,
      order: 'last_seen_desc',
    });
  });

  it('rejects empty IDs, oversized limits and cursors bound to another order', async () => {
    const empty = await actors({ search: { kind: 'exact_id', value: ' ' } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_error');

    const oversized = await actors({ limit: 101 });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.code).toBe('validation_error');

    const first = await actors({ order: 'events_desc', limit: 1 });
    const wrongOrder = await actors({
      order: 'last_seen_desc',
      cursor: first.body.meta.next_cursor,
    });
    expect(wrongOrder.status).toBe(400);
    expect(wrongOrder.body.error.code).toBe('actors_cursor_invalid');
  });

  it('marks a server-detected corrupt active-link cycle as ambiguous', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'activity.performed',
          distinct_id: 'conflict-a',
          timestamp: '2026-07-26T10:00:00.000Z',
        },
        {
          event: 'activity.performed',
          distinct_id: 'conflict-b',
          timestamp: '2026-07-26T11:00:00.000Z',
        },
      ],
    });
    // The API rejects cycles. Insert this synthetic corruption directly so the
    // read path proves it fails closed if an operator bypasses the API.
    await env.pool.query(
      `INSERT INTO actor_links (
         project_id, env, source_distinct_id, target_distinct_id, created_by
       ) VALUES
         ($1, 'prod', 'conflict-a', 'conflict-b', 'synthetic-test'),
         ($1, 'prod', 'conflict-b', 'conflict-a', 'synthetic-test')`,
      [env.projectId],
    );

    const first = await actors({ search: { kind: 'exact_id', value: 'conflict-a' } });
    const second = await actors({ search: { kind: 'exact_id', value: 'conflict-b' } });
    expect(first.body.actors[0].identity_status).toBe('ambiguous');
    expect(second.body.actors[0].identity_status).toBe('ambiguous');
    const resolved = await env.pool.query<{ input: string; actor: string }>(
      `SELECT input,
              poolstatis_resolve_actor($1::uuid, 'prod', input) AS actor
       FROM unnest(ARRAY['conflict-a', 'conflict-b']) AS input
       ORDER BY input`,
      [env.projectId],
    );
    expect([first.body.actors[0].distinct_id, second.body.actors[0].distinct_id].sort())
      .toEqual(resolved.rows.map((row) => row.actor).sort());
  });

  it('keeps set-based actor resolution identical to the canonical function for a long chain', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{
        event: 'activity.performed',
        distinct_id: 'long-chain-0',
        timestamp: '2026-07-27T10:00:00.000Z',
      }],
    });
    await env.pool.query(
      `INSERT INTO actor_links (
         project_id, env, source_distinct_id, target_distinct_id, created_by
       )
       SELECT $1, 'prod', 'long-chain-' || n, 'long-chain-' || (n + 1),
              'synthetic-test'
       FROM generate_series(0, 39) AS n`,
      [env.projectId],
    );
    const canonical = await env.pool.query<{ actor: string }>(
      `SELECT poolstatis_resolve_actor($1::uuid, 'prod', 'long-chain-0') AS actor`,
      [env.projectId],
    );
    const listed = await actors({
      search: { kind: 'exact_id', value: 'long-chain-0' },
    });
    expect(canonical.rows[0]?.actor).toBe('long-chain-40');
    expect(listed.body.actors[0]).toMatchObject({
      distinct_id: canonical.rows[0]?.actor,
      identity_status: 'linked',
      raw_actor_count: 1,
    });
  });
});

describe('canonical person contract', () => {
  it('returns canonical identity, bounded provenance and registered-only keyset activity', async () => {
    const person = await api(
      env,
      env.secretToken,
      'GET',
      `${project()}/persons/${encodeURIComponent('anon-a')}?env=prod`
        + `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}&limit=2`,
    );
    expect(person.status).toBe(200);
    expect(person.body).toMatchObject({
      requested_distinct_id: 'anon-a',
      distinct_id: 'stable-a',
      env: 'prod',
      identity: {
        status: 'linked',
        raw_distinct_ids: ['anon-a', 'stable-a'],
        raw_distinct_ids_truncated: false,
        links: [
          expect.objectContaining({
            source_distinct_id: 'anon-a',
            target_distinct_id: 'stable-a',
            status: 'active',
          }),
        ],
      },
      entity: null,
    });
    expect(person.body.summary).toMatchObject({
      total_events: 4,
      active_days: 4,
      session_count: 1,
    });
    expect(person.body.activity.events).toHaveLength(2);
    expect(person.body.activity.events.every((event: any) =>
      event.distinct_id === 'stable-a'
      && event.properties
      && Object.keys(event.properties).length === 0
      && event.registered === true
    )).toBe(true);
    expect(person.body.activity.next_cursor).toEqual(expect.any(String));
    expect(person.body.capabilities).toMatchObject({
      identity_entity: { available: false },
      activity_properties: { available: false },
      purge: {
        scope: 'exact_raw_distinct_id',
        canonical_expansion: false,
      },
    });

    const next = await api(
      env,
      env.secretToken,
      'GET',
      `${project()}/persons/anon-a?env=prod`
        + `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`
        + `&limit=10&cursor=${encodeURIComponent(person.body.activity.next_cursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.activity.events.length).toBeGreaterThan(0);
    expect(next.body.activity.events.every((event: any) =>
      event.distinct_id === 'stable-a'
    )).toBe(true);
    expect([
      ...person.body.activity.events,
      ...next.body.activity.events,
    ].some((event: any) => event.raw_distinct_id === 'anon-a')).toBe(true);
  });

  it('matches the actors row for the same canonical population and window', async () => {
    const list = await actors({ search: { kind: 'exact_id', value: 'anon-a' } });
    const person = await api(
      env,
      env.secretToken,
      'GET',
      `${project()}/persons/anon-a?env=prod`
        + `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
    );
    const row = list.body.actors[0];
    expect(person.body.summary).toMatchObject({
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      total_events: row.total_events,
      active_days: row.active_days,
      session_count: row.session_count,
      top_events: row.top_events,
    });
  });

  it('keeps destructive purge scoped to the exact raw ID', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'activity.performed',
          distinct_id: 'purge-source',
          timestamp: '2026-07-25T10:00:00.000Z',
        },
        {
          event: 'activity.performed',
          distinct_id: 'purge-target',
          timestamp: '2026-07-25T11:00:00.000Z',
        },
      ],
    });
    await api(env, env.secretToken, 'POST', `${project()}/identity-links`, {
      source_distinct_id: 'purge-source',
      target_distinct_id: 'purge-target',
      env: 'prod',
    });

    const purged = await api(env, env.secretToken, 'POST', `${project()}/data/purge`, {
      env: 'prod',
      scope: 'events',
      distinct_id: 'purge-source',
      confirm_slug: env.projectSlug,
    });
    expect(purged.status).toBe(200);
    expect(purged.body).toMatchObject({
      events_deleted: 1,
      distinct_id: 'purge-source',
      identity_scope: 'exact_raw_distinct_id',
      canonical_expansion: false,
    });

    const remaining = await actors({
      search: { kind: 'exact_id', value: 'purge-target' },
    });
    expect(remaining.body.actors[0]).toMatchObject({
      distinct_id: 'purge-target',
      total_events: 1,
    });
  });
});
