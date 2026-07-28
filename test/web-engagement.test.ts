import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('web engagement and session analytics', () => {
  let env: TestEnv;
  let other: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    expect((await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/properties/browser-analytics`,
      {},
    )).status).toBe(200);
    expect((await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/metrics/web_page_views`,
      { status: 'active' },
    )).status).toBe(200);
    await activeMetric(env, {
      key: 'signup_completed',
      name: 'Signup completed',
      purpose: 'Classify a short browser session as engaged when signup succeeds.',
      source: { event: 'signup.completed' },
    });

    const timestamp = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
    const page = (session: string, pageView: string, path: string, secondsAgo: number) => ({
      event: 'page.viewed',
      distinct_id: `visitor:${session}`,
      session_id: session,
      timestamp: timestamp(secondsAgo),
      properties: {
        $browser_context: '1',
        $page_view_id: pageView,
        $page_path: path,
        $device_class: 'desktop',
        $browser_family: 'chrome',
        $os_family: 'linux',
        $language: 'en',
        $timezone: 'UTC',
        $viewport_bucket: 'lg',
        $screen_bucket: 'lg',
      },
    });
    const engagement = (
      session: string,
      pageView: string,
      sequence: number,
      foregroundMs: number,
      elapsedMs: number,
      reason: string,
      secondsAgo: number,
    ) => ({
      event: 'page.engagement',
      distinct_id: `visitor:${session}`,
      session_id: session,
      timestamp: timestamp(secondsAgo),
      properties: {
        $browser_context: '1',
        $page_view_id: pageView,
        $page_path: '/',
        $device_class: 'desktop',
        $browser_family: 'chrome',
        $os_family: 'linux',
        $language: 'en',
        $timezone: 'UTC',
        $viewport_bucket: 'lg',
        $screen_bucket: 'lg',
        sequence,
        foreground_ms: foregroundMs,
        elapsed_ms: elapsedMs,
        max_scroll_pct: 75,
        interaction_count: 2,
        reason,
      },
    });
    const events = [
      page('session:45s', 'page:45s', '/', 120),
      engagement('session:45s', 'page:45s', 1, 10_000, 10_000, 'heartbeat', 110),
      engagement('session:45s', 'page:45s', 2, 45_000, 45_000, 'pagehide', 75),

      page('session:6s', 'page:6s', '/', 100),
      engagement('session:6s', 'page:6s', 1, 6_000, 6_000, 'pagehide', 94),

      page('session:key', 'page:key', '/', 90),
      engagement('session:key', 'page:key', 1, 3_000, 3_000, 'pagehide', 87),
      {
        event: 'signup.completed',
        distinct_id: 'visitor:session:key',
        session_id: 'session:key',
        timestamp: timestamp(86),
      },

      page('session:two-pages', 'page:two-a', '/', 80),
      engagement('session:two-pages', 'page:two-a', 1, 2_000, 2_000, 'route_change', 78),
      page('session:two-pages', 'page:two-b', '/pricing', 77),
      engagement('session:two-pages', 'page:two-b', 1, 3_000, 3_000, 'pagehide', 74),

      page('session:crash', 'page:crash', '/', 70),

      page('session:heartbeat-crash', 'page:heartbeat-crash', '/', 65),
      engagement('session:heartbeat-crash', 'page:heartbeat-crash', 1, 10_000, 10_000, 'heartbeat', 55),

      page('session:dedupe', 'page:dedupe', '/', 60),
      engagement('session:dedupe', 'page:dedupe', 1, 10_000, 10_000, 'heartbeat', 50),
      engagement('session:dedupe', 'page:dedupe', 2, 45_000, 45_000, 'pagehide', 15),
      engagement('session:dedupe', 'page:dedupe', 2, 45_000, 45_000, 'pagehide', 14),
      engagement('session:dedupe', 'page:dedupe', 1, 10_000, 10_000, 'heartbeat', 13),
    ];
    const stored = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events });
    expect([200, 207], JSON.stringify(stored.body)).toContain(stored.status);
    expect(stored.body.accepted, JSON.stringify(stored.body)).toBe(events.length);
  });

  afterAll(async () => {
    await env.close();
    await other.close();
  });

  const query = (body: Record<string, unknown>) => api(
    env,
    env.secretToken,
    'POST',
    `/api/v1/projects/${env.projectSlug}/query`,
    body,
  );

  it('classifies measured sessions without turning crashes into fake bounces', async () => {
    const usageBefore = await env.pool.query(
      `SELECT COALESCE(sum(quantity), 0)::int AS quantity
       FROM usage_ledger
       WHERE project_id = $1 AND env = 'prod' AND meter_key = 'events_stored'`,
      [env.projectId],
    );
    const result = await query({
      kind: 'web_analytics',
      metric: 'web_page_views',
      key_metric: 'signup_completed',
      date_from: '-1d',
      dimensions: ['device'],
      env: 'prod',
    });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.summary).toEqual({ visitors: 7, sessions: 7, page_views: 8 });
    expect(result.body.engagement).toMatchObject({
      measured_sessions: 5,
      incomplete_sessions: 2,
      engaged_sessions: 4,
      bounce_sessions: 1,
      single_page_sessions: 6,
      timed_page_views: 7,
      total_page_views: 8,
      timed_page_coverage: 7 / 8,
      foreground_ms: 114_000,
    });
    expect(result.body.meta.definitions.bounce_sessions).toContain('lifecycle-complete');
    expect(result.body.meta.accepted_event_accounting).toContain('stored event');

    const usageAfter = await env.pool.query(
      `SELECT COALESCE(sum(quantity), 0)::int AS quantity
       FROM usage_ledger
       WHERE project_id = $1 AND env = 'prod' AND meter_key = 'events_stored'`,
      [env.projectId],
    );
    expect(usageAfter.rows[0]?.quantity).toBe(usageBefore.rows[0]?.quantity);
  });

  it('keeps a heartbeat-only crashed page timed but incomplete', async () => {
    const result = await query({
      kind: 'page_engagement',
      metric: 'web_page_views',
      page_view_id: 'page:heartbeat-crash',
      date_from: '-1d',
      env: 'prod',
    });

    expect(result.status).toBe(200);
    expect(result.body.page).toMatchObject({
      foreground_ms: 10_000,
      reason: 'heartbeat',
      timed: true,
      complete: false,
    });
  });

  it('uses only the highest cumulative sequence for duplicate and out-of-order snapshots', async () => {
    const result = await query({
      kind: 'page_engagement',
      metric: 'web_page_views',
      page_view_id: 'page:dedupe',
      date_from: '-1d',
      env: 'prod',
    });

    expect(result.status).toBe(200);
    expect(result.body.page).toMatchObject({
      page_view_id: 'page:dedupe',
      session_id: 'session:dedupe',
      foreground_ms: 45_000,
      elapsed_ms: 45_000,
      sequence: 2,
      complete: true,
    });
  });

  it('returns a bounded session list and an ordered per-page session read', async () => {
    const listed = await query({
      kind: 'web_sessions',
      metric: 'web_page_views',
      key_metric: 'signup_completed',
      date_from: '-1d',
      env: 'prod',
      limit: 3,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(3);
    expect(listed.body.meta.truncated).toBe(true);

    const session = await query({
      kind: 'web_session',
      metric: 'web_page_views',
      session_id: 'session:two-pages',
      date_from: '-1d',
      env: 'prod',
    });
    expect(session.status).toBe(200);
    expect(session.body.summary).toMatchObject({
      page_views: 2,
      timed_page_views: 2,
      foreground_ms: 5_000,
      engaged: true,
      bounce: false,
    });
    expect(session.body.pages.map((page: { path: string }) => page.path)).toEqual(['/', '/pricing']);
  });

  it('keeps engagement reads inside the exact project and environment', async () => {
    const dev = await query({
      kind: 'web_sessions',
      metric: 'web_page_views',
      date_from: '-1d',
      env: 'dev',
      limit: 20,
    });
    expect(dev.status).toBe(200);
    expect(dev.body.sessions).toEqual([]);

    const crossTenant = await api(
      other,
      other.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      {
        kind: 'web_session',
        metric: 'web_page_views',
        session_id: 'session:45s',
        date_from: '-1d',
        env: 'prod',
      },
    );
    expect(crossTenant.status).toBe(404);
  });

  it('rejects malformed and overflow engagement snapshots before storage', async () => {
    const context = {
      $browser_context: '1',
      $page_view_id: 'page:invalid',
      $page_path: '/',
      $device_class: 'desktop',
      $browser_family: 'chrome',
      $os_family: 'linux',
      $language: 'en',
      $timezone: 'UTC',
      $viewport_bucket: 'lg',
      $screen_bucket: 'lg',
      sequence: 1,
      foreground_ms: 1_000,
      elapsed_ms: 1_000,
      max_scroll_pct: 50,
      interaction_count: 1,
      reason: 'heartbeat',
    };
    const invalid = [
      { ...context, sequence: 9_999_999_999_999 },
      { ...context, foreground_ms: -1 },
      { ...context, elapsed_ms: Number.MAX_VALUE },
      { ...context, foreground_ms: 2_000, elapsed_ms: 1_000 },
      { ...context, max_scroll_pct: 101 },
      { ...context, reason: 'made_up' },
    ].map((properties, index) => ({
      event: 'page.engagement',
      distinct_id: `visitor:invalid-${index}`,
      session_id: `session:invalid-${index}`,
      properties,
    }));
    invalid.push({
      event: 'page.engagement',
      distinct_id: 'visitor:invalid-no-context',
      session_id: 'session:invalid-no-context',
      properties: {
        $page_view_id: 'page:invalid-no-context',
        sequence: 1,
        foreground_ms: 1_000,
        elapsed_ms: 1_000,
        max_scroll_pct: 50,
        interaction_count: 1,
        reason: 'heartbeat',
      },
    });
    const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events: invalid });
    expect(response.status).toBe(207);
    expect(response.body.accepted).toBe(0);
    expect(response.body.errors).toHaveLength(invalid.length);

    const stored = await env.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM events
       WHERE project_id = $1 AND distinct_id LIKE 'visitor:invalid-%'`,
      [env.projectId],
    );
    expect(stored.rows[0]?.count).toBe('0');
  });

  it('bounds long session detail while preserving the exact page total', async () => {
    const timestamp = new Date(Date.now() - 5_000).toISOString();
    const maxDuration = 7 * 24 * 60 * 60 * 1_000;
    const pages = Array.from({ length: 1_025 }, (_, index) => {
      const shared = {
        distinct_id: 'visitor:long-session',
        session_id: 'session:long',
        timestamp,
      };
      const pageViewId = `page:long-${String(index).padStart(4, '0')}`;
      const browserContext = {
        $browser_context: '1',
        $page_view_id: pageViewId,
        $page_path: `/docs/${index}`,
        $device_class: 'desktop',
        $browser_family: 'chrome',
        $os_family: 'linux',
        $language: 'en',
        $timezone: 'UTC',
        $viewport_bucket: 'lg',
        $screen_bucket: 'lg',
      };
      return [
        { event: 'page.viewed', ...shared, properties: browserContext },
        {
          event: 'page.engagement',
          ...shared,
          properties: {
            ...browserContext,
            sequence: 1,
            foreground_ms: maxDuration,
            elapsed_ms: maxDuration,
            max_scroll_pct: 100,
            interaction_count: 0,
            reason: 'pagehide',
          },
        },
      ];
    }).flat();
    for (let index = 0; index < pages.length; index += 500) {
      const batch = pages.slice(index, index + 500);
      const stored = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events: batch });
      expect(stored.status).toBe(200);
      expect(stored.body.accepted).toBe(batch.length);
    }

    const result = await query({
      kind: 'web_session',
      metric: 'web_page_views',
      session_id: 'session:long',
      date_from: '-1d',
      page_limit: 100,
      env: 'prod',
    });
    expect(result.status).toBe(200);
    expect(result.body.summary).toMatchObject({
      page_views: 1_025,
      foreground_ms: 619_920_000_000,
    });
    expect(result.body.pages).toHaveLength(100);
    expect(result.body.meta).toMatchObject({ total_pages: 1_025, truncated: true });
  });

  it('does not use proposed or deprecated metrics for engagement classification', async () => {
    const proposed = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics`,
      {
        key: 'proposed_engagement',
        name: 'Proposed engagement',
        purpose: 'Remain unavailable until an owner reviews and activates this engagement metric.',
        category: 'activation',
        type: 'count',
        source: { event: 'signup.completed' },
      },
    );
    expect(proposed.status).toBe(201);
    const proposedQuery = await query({
      kind: 'web_sessions',
      metric: 'web_page_views',
      key_metric: 'proposed_engagement',
      date_from: '-1d',
      env: 'prod',
      limit: 10,
    });
    expect(proposedQuery.status).toBe(400);
    expect(proposedQuery.body.error.code).toBe('web_analytics_key_metric_inactive');

    await activeMetric(env, {
      key: 'deprecated_engagement',
      purpose: 'Classify engagement only while this reviewed test metric remains active.',
      source: { event: 'signup.completed' },
    });
    const deprecated = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/deprecated_engagement/deprecate`,
      { reason: 'Replaced by the reviewed signup metric after this bounded query regression test.' },
    );
    expect(deprecated.status).toBe(200);
    const deprecatedQuery = await query({
      kind: 'web_sessions',
      metric: 'web_page_views',
      key_metric: 'deprecated_engagement',
      date_from: '-1d',
      env: 'prod',
      limit: 10,
    });
    expect(deprecatedQuery.status).toBe(400);
    expect(deprecatedQuery.body.error.code).toBe('web_analytics_key_metric_inactive');
  });
});
