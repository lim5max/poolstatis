import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySchema } from '../src/schemas.js';
import { runSerializedBrowserSetup } from '../src/services/browserAnalytics.js';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let other: TestEnv;
const project = () => `/api/v1/projects/${env.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  other = await createTestEnv({ ingestBuffer: false, queryCache: false });
});

afterAll(async () => {
  await Promise.all([env.close(), other.close()]);
});

describe('web analytics Query DSL', () => {
  it('parses only bounded typed branches', () => {
    expect(querySchema.parse({
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '-7d',
    })).toMatchObject({
      dimensions: ['route', 'source', 'device', 'browser'],
      env: 'prod',
    });
    expect(() => querySchema.parse({
      kind: 'web_sessions',
      metric: 'web_page_views',
      date_from: '-7d',
      limit: 101,
    })).toThrow();
    expect(() => querySchema.parse({
      kind: 'web_session',
      metric: 'web_page_views',
      date_from: '-7d',
      session_id: '',
    })).toThrow();
    expect(() => querySchema.parse({
      kind: 'page_engagement',
      metric: 'web_page_views',
      date_from: '-7d',
      page_view_id: 'x'.repeat(201),
    })).toThrow();
  });
});

describe('atomic browser registry setup', () => {
  it('retries 40001/40P01 at most three times and returns a controlled retryable 503', async () => {
    const statements: string[] = [];
    let released = false;
    const client = {
      async query(sql: string) { statements.push(sql); return { rows: [] }; },
      release() { released = true; },
    };
    const pool = { async connect() { return client; } };
    let attempts = 0;
    const result = await runSerializedBrowserSetup(
      pool as never,
      'test-lock',
      async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('serialization'), { code: '40001' });
        if (attempts === 2) throw Object.assign(new Error('deadlock'), { code: '40P01' });
        return 'committed';
      },
    );
    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    expect(statements.filter((sql) => sql.startsWith('BEGIN'))).toHaveLength(3);
    expect(statements.filter((sql) => sql === 'ROLLBACK')).toHaveLength(2);
    expect(statements).toContain('COMMIT');
    expect(released).toBe(true);

    await expect(runSerializedBrowserSetup(
      pool as never,
      'test-lock',
      async () => {
        throw Object.assign(new Error('still serializing'), { code: '40001' });
      },
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'browser_setup_retryable',
      retryable: true,
    });
  });

  it('is concurrent, atomic and idempotent', async () => {
    const [first, second] = await Promise.all([
      api(env, env.secretToken, 'POST', `${project()}/properties/browser-analytics`, {}),
      api(env, env.secretToken, 'POST', `${project()}/properties/browser-analytics`, {}),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.properties).toHaveLength(15);
    expect(first.body.metrics).toHaveLength(2);
    expect(second.body.properties).toHaveLength(15);
    expect(second.body.metrics).toHaveLength(2);

    const counts = await env.pool.query(
      `SELECT
         (SELECT count(*)::int FROM property_definitions WHERE project_id = $1) AS properties,
         (SELECT count(*)::int FROM metrics WHERE project_id = $1) AS metrics`,
      [env.projectId],
    );
    expect(counts.rows[0]).toEqual({ properties: 15, metrics: 2 });
  });

  it('preflights the whole bundle before any write', async () => {
    await api(other, other.secretToken, 'POST', `/api/v1/projects/${other.projectSlug}/properties`, {
      key: '$route_key',
      scope: 'event',
      value_type: 'number',
      purpose: 'Conflicting route property used to prove atomic setup rollback.',
      status: 'proposed',
      source: 'native',
    });
    const result = await api(
      other,
      other.secretToken,
      'POST',
      `/api/v1/projects/${other.projectSlug}/properties/browser-analytics`,
      {},
    );
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('browser_property_conflict');
    const counts = await other.pool.query(
      `SELECT
         (SELECT count(*)::int FROM property_definitions WHERE project_id = $1) AS properties,
         (SELECT count(*)::int FROM metrics WHERE project_id = $1) AS metrics`,
      [other.projectId],
    );
    expect(counts.rows[0]).toEqual({ properties: 1, metrics: 0 });
  });
});

describe('privacy-safe browser ingest and Web analytics', () => {
  beforeAll(async () => {
    await api(env, env.secretToken, 'PATCH', `${project()}/properties/event/$route_key`, {
      status: 'trusted',
    });
    await api(env, env.secretToken, 'PATCH', `${project()}/properties/event/$utm_source`, {
      status: 'trusted',
    });
    await api(env, env.secretToken, 'PATCH', `${project()}/metrics/web_page_views`, {
      status: 'active',
    });
    await activeMetric(env, {
      key: 'signup',
      source: { event: 'signup.completed' },
      purpose: 'Counts completed signups to classify a meaningful web session outcome.',
    });
  });

  it('rejects unsafe routes, forbidden canonical fields and browser-marked custom events', async () => {
    const result = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'page.viewed',
          distinct_id: 'unsafe-a',
          session_id: 'unsafe-s',
          properties: {
            $browser_context: '1',
            $route_key: '/invite/customer-42',
            $page_view_id: 'unsafe-p1',
          },
        },
        {
          event: 'page.viewed',
          distinct_id: 'unsafe-b',
          session_id: 'unsafe-s2',
          properties: {
            $browser_context: '1',
            $route_key: 'pricing',
            $page_view_id: 'unsafe-p2',
            full_url: 'https://example.test/pricing?token=secret',
          },
        },
        {
          event: 'checkout.completed',
          distinct_id: 'unsafe-c',
          session_id: 'unsafe-s3',
          properties: { $browser_context: '1', arbitrary: 'secret' },
        },
        {
          event: 'page.viewed',
          distinct_id: 'unsafe-d',
          session_id: 'unsafe-s4',
          properties: {
            $browser_context: '1',
            $route_key: 'pricing',
            $page_view_id: 'unsafe-p4',
            $utm_source: 'https://tracker.test/path?token=secret',
          },
        },
        {
          event: 'checkout.completed',
          distinct_id: 'neutral',
          properties: { arbitrary: 'allowed on the neutral base SDK path' },
        },
      ],
    });
    expect(result.status).toBe(207);
    expect(result.body).toMatchObject({ accepted: 1 });
    expect(result.body.errors).toHaveLength(4);
  });

  it('keeps legacy page events outside canonical semantics and returns tri-state rates', async () => {
    const events = [
      {
        event: 'page.viewed',
        distinct_id: 'actor-b',
        session_id: 'shared-session',
        timestamp: '2026-07-30T09:00:00.000Z',
        properties: {
          $browser_context: '1', $route_key: 'pricing', $page_view_id: 'page-b',
          $device_class: 'desktop', $browser_family: 'chrome', $utm_source: 'search',
        },
      },
      {
        event: 'page.engagement',
        distinct_id: 'actor-b',
        session_id: 'shared-session',
        timestamp: '2026-07-30T09:00:10.000Z',
        properties: {
          $browser_context: '1', $route_key: 'pricing', $page_view_id: 'page-b',
          sequence: 1, foreground_ms: 10_000, elapsed_ms: 10_000,
          max_scroll_pct: 50, interaction_count: 0, reason: 'pagehide',
        },
      },
      {
        event: 'page.viewed',
        distinct_id: 'actor-a',
        session_id: 'shared-session',
        timestamp: '2026-07-30T09:00:00.000Z',
        properties: {
          $browser_context: '1', $route_key: 'home', $page_view_id: 'page-a',
          $device_class: 'mobile', $browser_family: 'safari',
        },
      },
      {
        event: 'page.engagement',
        distinct_id: 'actor-a',
        session_id: 'shared-session',
        timestamp: '2026-07-30T09:00:09.999Z',
        properties: {
          $browser_context: '1', $route_key: 'home', $page_view_id: 'page-a',
          sequence: 2, foreground_ms: 9_999, elapsed_ms: 9_999,
          max_scroll_pct: 25, interaction_count: 0, reason: 'pagehide',
        },
      },
      {
        event: 'page.engagement',
        distinct_id: 'actor-a',
        session_id: 'shared-session',
        timestamp: '2026-07-30T09:00:05.000Z',
        properties: {
          $browser_context: '1', $route_key: 'home', $page_view_id: 'page-a',
          sequence: 1, foreground_ms: 5_000, elapsed_ms: 5_000,
          max_scroll_pct: 10, interaction_count: 0, reason: 'heartbeat',
        },
      },
      {
        event: 'page.viewed',
        distinct_id: 'actor-unknown',
        session_id: 'unknown-session',
        timestamp: '2026-07-30T09:01:00.000Z',
        properties: {
          $browser_context: '1', $route_key: 'docs', $page_view_id: 'page-unknown',
        },
      },
      {
        event: 'page.viewed',
        distinct_id: 'legacy',
        session_id: 'legacy-session',
        timestamp: '2026-07-30T09:02:00.000Z',
        properties: { path: '/legacy/customer-123' },
      },
      {
        event: 'page.viewed',
        distinct_id: 'dev-actor',
        session_id: 'dev-session',
        timestamp: '2026-07-30T09:03:00.000Z',
        properties: {
          $browser_context: '1', $route_key: 'dev', $page_view_id: 'dev-page',
        },
      },
    ];
    const prod = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events: events.slice(0, -1) });
    const dev = await api(env, env.ingestDevToken, 'POST', '/i/v1/events', { events: [events.at(-1)] });
    expect(prod.body.accepted).toBe(7);
    expect(dev.body.accepted).toBe(1);

    const overview = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
      dimensions: ['route', 'source', 'device', 'browser'],
    });
    expect(overview.status).toBe(200);
    expect(overview.body.summary).toEqual({
      visitors: 3,
      sessions: 3,
      page_views: 3,
      average_session_duration_ms: 9_999,
    });
    expect(overview.body.engagement).toMatchObject({
      measured_sessions: 2,
      unknown_sessions: 1,
      engaged_sessions: 1,
      bounce_sessions: 1,
      measured_session_coverage: 2 / 3,
      engaged_rate: 0.5,
      bounce_rate: 0.5,
    });
    expect(overview.body.breakdowns.route.map((row: { value: string }) => row.value).sort())
      .toEqual(['docs', 'home', 'pricing']);
    expect(overview.body.breakdowns).not.toHaveProperty('country');

    const sessions = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_sessions',
      metric: 'web_page_views',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
      limit: 3,
    });
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions.slice(1).map((row: { actor_id: string }) => row.actor_id))
      .toEqual(['actor-a', 'actor-b']);
    expect(sessions.body.sessions.find((row: { actor_id: string }) => row.actor_id === 'actor-b'))
      .toMatchObject({ engaged: true, bounce: false, foreground_ms: 10_000 });
    expect(sessions.body.sessions.find((row: { actor_id: string }) => row.actor_id === 'actor-a'))
      .toMatchObject({ engaged: false, bounce: true, foreground_ms: 9_999 });

    const ambiguous = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_session',
      metric: 'web_page_views',
      session_id: 'shared-session',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
    });
    expect(ambiguous.status, JSON.stringify(ambiguous.body)).toBe(400);
    expect(ambiguous.body.error.code).toBe('web_session_actor_ambiguous');
  });

  it('fails route analysis closed until the route key is trusted', async () => {
    await api(env, env.secretToken, 'PATCH', `${project()}/properties/event/$route_key`, {
      status: 'proposed',
    });
    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '-7d',
      dimensions: ['route'],
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('safe_route_unavailable');
    await api(env, env.secretToken, 'PATCH', `${project()}/properties/event/$route_key`, {
      status: 'trusted',
    });
  });

  it('does not report average duration from lifecycle-incomplete sessions', async () => {
    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'page.viewed',
          distinct_id: 'duration-actor',
          session_id: 'duration-incomplete',
          timestamp: '2026-07-30T10:05:00.000Z',
          properties: {
            $browser_context: '1', $route_key: 'home', $page_view_id: 'duration-page-a',
          },
        },
        {
          event: 'page.viewed',
          distinct_id: 'duration-actor',
          session_id: 'duration-incomplete',
          timestamp: '2026-07-30T10:05:30.000Z',
          properties: {
            $browser_context: '1', $route_key: 'pricing', $page_view_id: 'duration-page-b',
          },
        },
      ],
    });
    expect(ingested.body.accepted).toBe(2);
    const overview = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '2026-07-30T10:04:00.000Z',
      date_to: '2026-07-30T10:06:00.000Z',
      dimensions: ['device'],
    });
    expect(overview.status).toBe(200);
    expect(overview.body.summary).toMatchObject({
      sessions: 1,
      average_session_duration_ms: null,
    });
    expect(overview.body.engagement).toMatchObject({
      measured_sessions: 1,
      engaged_sessions: 1,
      incomplete_sessions: 1,
    });
  });

  it('resolves actor links at query time and separates actors again after revoke', async () => {
    const link = await api(env, env.secretToken, 'POST', `${project()}/identity-links`, {
      source_distinct_id: 'actor-a',
      target_distinct_id: 'actor-b',
      env: 'prod',
    });
    expect(link.status).toBe(201);
    const linked = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
      dimensions: ['route'],
    });
    expect(linked.body.summary).toMatchObject({ visitors: 2, sessions: 2, page_views: 3 });

    const revoked = await api(
      env,
      env.secretToken,
      'POST',
      `${project()}/identity-links/${link.body.id}/revoke`,
    );
    expect(revoked.status).toBe(200);
    const separated = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
      dimensions: ['route'],
    });
    expect(separated.body.summary).toMatchObject({ visitors: 3, sessions: 3, page_views: 3 });
  });

  it('fails page detail closed when a page id is reused across sessions', async () => {
    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'page.viewed',
          distinct_id: 'same-actor',
          session_id: 'page-session-a',
          timestamp: '2026-07-30T09:10:00.000Z',
          properties: {
            $browser_context: '1', $route_key: 'home', $page_view_id: 'reused-page',
          },
        },
        {
          event: 'page.viewed',
          distinct_id: 'same-actor',
          session_id: 'page-session-b',
          timestamp: '2026-07-30T09:11:00.000Z',
          properties: {
            $browser_context: '1', $route_key: 'pricing', $page_view_id: 'reused-page',
          },
        },
      ],
    });
    expect(ingested.body.accepted).toBe(2);
    const ambiguous = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'page_engagement',
      metric: 'web_page_views',
      page_view_id: 'reused-page',
      actor_id: 'same-actor',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
    });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.code).toBe('page_engagement_actor_ambiguous');
    const scoped = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'page_engagement',
      metric: 'web_page_views',
      page_view_id: 'reused-page',
      actor_id: 'same-actor',
      session_id: 'page-session-a',
      date_from: '2026-07-30T08:00:00.000Z',
      date_to: '2026-07-30T10:00:00.000Z',
    });
    expect(scoped.status).toBe(200);
    expect(scoped.body.page).toMatchObject({
      actor_id: 'same-actor',
      session_id: 'page-session-a',
      page_view_id: 'reused-page',
    });
  });

  it('bounds date ranges and top breakdown output without tenant leakage', async () => {
    const oversized = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '2024-01-01T00:00:00.000Z',
      date_to: '2026-01-02T00:00:00.000Z',
      dimensions: ['route'],
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.code).toBe('web_analytics_range_too_large');

    const events = Array.from({ length: 51 }, (_, index) => ({
      event: 'page.viewed',
      distinct_id: `breakdown-actor-${index}`,
      session_id: `breakdown-session-${index}`,
      timestamp: '2026-07-30T09:30:00.000Z',
      properties: {
        $browser_context: '1',
        $route_key: `route_${String(index).padStart(2, '0')}`,
        $page_view_id: `breakdown-page-${index}`,
      },
    }));
    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events });
    expect(ingested.body.accepted).toBe(51);
    const bounded = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '2026-07-30T09:20:00.000Z',
      date_to: '2026-07-30T09:40:00.000Z',
      dimensions: ['route'],
    });
    expect(bounded.body.breakdowns.route).toHaveLength(50);
    expect(bounded.body.meta.truncated_dimensions).toEqual(['route']);

    const store = new PostgresEventStore(env.pool);
    const isolated = await store.webAnalytics({
      projectId: other.projectId,
      env: 'prod',
      event: 'page.viewed',
      filters: [{ property: '$browser_context', op: 'eq', value: '1' }],
      from: new Date('2026-07-30T08:00:00.000Z'),
      to: new Date('2026-07-30T10:00:00.000Z'),
      dimensions: [],
    });
    expect(isolated.summary).toEqual({
      visitors: 0,
      sessions: 0,
      page_views: 0,
      average_session_duration_ms: null,
    });
  });

  it('rejects proposed key metrics instead of silently treating them as evidence', async () => {
    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      key_metric: 'web_visitors',
      date_from: '-1d',
      dimensions: ['route'],
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('web_analytics_key_metric_inactive');
  });
});
