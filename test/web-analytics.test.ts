import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { createTrustedProxyCountryResolver } from '../src/services/country.js';

describe('web analytics query', () => {
  const countryResolver = createTrustedProxyCountryResolver({
    header: 'x-edge-country',
    trustedProxyCidrs: ['127.0.0.0/8', '::1/128'],
  });
  let env: TestEnv;
  let other: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ countryResolver });
    other = await createTestEnv({ countryResolver });
    const proposed = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/properties/browser-analytics`, {});
    expect(proposed.status).toBe(200);
    expect(proposed.body.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '$browser_context' }),
      expect.objectContaining({ key: '$utm_source' }),
    ]));
    await api(env, env.secretToken, 'PATCH', `/api/v1/projects/${env.projectSlug}/metrics/web_page_views`, { status: 'active' });
  });
  afterAll(async () => { await env.close(); await other.close(); });

  async function ingest(country: string, events: Array<Record<string, unknown>>) {
    return env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: { authorization: `Bearer ${env.ingestToken}`, 'x-edge-country': country },
      payload: { events },
    });
  }

  const page = (actor: string, session: string, path: string, source?: string) => ({
    event: 'page.viewed',
    distinct_id: actor,
    session_id: session,
    properties: {
      $browser_context: '1', $page_path: path, $device_class: actor.includes('mobile') ? 'mobile' : 'desktop',
      $browser_family: 'chrome', $os_family: 'linux', $language: 'en',
      $timezone: 'UTC', $viewport_bucket: 'lg', $screen_bucket: 'lg',
      ...(source ? { $utm_source: source } : {}),
    },
  });

  it('keeps anonymous visitors distinct until an explicit audited actor link exists', async () => {
    const isolated = await createTestEnv({ countryResolver });
    try {
      expect((await api(
        isolated,
        isolated.secretToken,
        'POST',
        `/api/v1/projects/${isolated.projectSlug}/properties/browser-analytics`,
        {},
      )).status).toBe(200);
      expect((await api(
        isolated,
        isolated.secretToken,
        'PATCH',
        `/api/v1/projects/${isolated.projectSlug}/metrics/web_page_views`,
        { status: 'active' },
      )).status).toBe(200);

      const stored = await isolated.app.inject({
        method: 'POST',
        url: '/i/v1/events',
        headers: {
          authorization: `Bearer ${isolated.ingestToken}`,
          'x-edge-country': 'US',
        },
        payload: {
          events: [
            page('anonymous:one', 'session:one', '/'),
            page('anonymous:two', 'session:two', '/pricing'),
          ],
        },
      });
      expect(stored.statusCode).toBe(200);

      const beforeLink = await api(
        isolated,
        isolated.secretToken,
        'POST',
        `/api/v1/projects/${isolated.projectSlug}/query`,
        {
          kind: 'web_analytics',
          metric: 'web_page_views',
          date_from: '-1d',
          dimensions: ['country'],
          env: 'prod',
        },
      );
      expect(beforeLink.status).toBe(200);
      expect(beforeLink.body.summary).toEqual({ visitors: 2, sessions: 2, page_views: 2 });

      expect((await api(
        isolated,
        isolated.secretToken,
        'POST',
        `/api/v1/projects/${isolated.projectSlug}/identity-links`,
        {
          source_distinct_id: 'anonymous:one',
          target_distinct_id: 'anonymous:two',
          env: 'prod',
        },
      )).status).toBe(201);

      const afterLink = await api(
        isolated,
        isolated.secretToken,
        'POST',
        `/api/v1/projects/${isolated.projectSlug}/query`,
        {
          kind: 'web_analytics',
          metric: 'web_page_views',
          date_from: '-1d',
          dimensions: ['country'],
          env: 'prod',
        },
      );
      expect(afterLink.status).toBe(200);
      expect(afterLink.body.summary).toEqual({ visitors: 1, sessions: 2, page_views: 2 });
    } finally {
      await isolated.close();
    }
  });

  it('keeps visitors, sessions and page views distinct and returns count plus percentage breakdowns', async () => {
    const legacy = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'page.viewed', distinct_id: 'legacy-manual', session_id: 'legacy-session' }],
    });
    expect(legacy.status).toBe(200);
    expect((await ingest('US', [
      page('visitor:one', 'session:1', '/', 'search'),
      page('visitor:one', 'session:1', '/pricing', 'search'),
      page('visitor:mobile', 'session:2', '/', 'social'),
    ])).statusCode).toBe(200);
    const linked = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/identity-links`, {
      source_distinct_id: 'visitor:one',
      target_distinct_id: 'user:one',
      env: 'prod',
    });
    expect(linked.status).toBe(201);
    expect((await ingest('DE', [page('user:one', 'session:3', '/docs', 'search')])).statusCode).toBe(200);

    const usageBeforeQuery = await env.pool.query(
      `SELECT COALESCE(sum(quantity), 0)::int AS quantity
       FROM usage_ledger
       WHERE project_id = $1 AND env = 'prod' AND meter_key = 'events_stored'`,
      [env.projectId],
    );
    expect(usageBeforeQuery.rows[0]?.quantity).toBe(5);

    const result = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '-1d',
      dimensions: ['country', 'device', 'source'],
      env: 'prod',
    });
    expect(result.status).toBe(200);
    expect(result.body.summary).toEqual({ visitors: 2, sessions: 3, page_views: 4 });
    expect(result.body.breakdowns.country).toEqual([
      { value: 'US', visitors: 2, sessions: 2, page_views: 3, percentage: 75 },
      { value: 'DE', visitors: 1, sessions: 1, page_views: 1, percentage: 25 },
    ]);
    expect(result.body.breakdowns.device.map((row: { value: string; page_views: number }) => [row.value, row.page_views]))
      .toEqual([['desktop', 3], ['mobile', 1]]);
    expect(result.body.meta.definitions.visitors).toContain('resolved actors');
    const usageAfterQuery = await env.pool.query(
      `SELECT COALESCE(sum(quantity), 0)::int AS quantity
       FROM usage_ledger
       WHERE project_id = $1 AND env = 'prod' AND meter_key = 'events_stored'`,
      [env.projectId],
    );
    expect(usageAfterQuery.rows[0]?.quantity).toBe(5);
  });

  it('isolates environment and tenant scopes', async () => {
    const dev = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/query`, {
      kind: 'web_analytics', metric: 'web_page_views', date_from: '-1d', dimensions: ['country'], env: 'dev',
    });
    expect(dev.body.summary).toEqual({ visitors: 0, sessions: 0, page_views: 0 });
    const crossTenant = await api(other, other.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/query`, {
      kind: 'web_analytics', metric: 'web_page_views', date_from: '-1d', dimensions: ['country'],
    });
    expect(crossTenant.status).toBe(404);
  });

  it('keeps 100+ breakdown groups bounded and reports truncation instead of silently hiding the tail', async () => {
    const events = Array.from(
      { length: 101 },
      (_, index) => page(
        `visitor:source:${index}`,
        `session:source:${index}`,
        `/source/${index}`,
        `source-${String(index).padStart(2, '0')}`,
      ),
    );
    expect((await ingest('US', events)).statusCode).toBe(200);
    const result = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/query`, {
      kind: 'web_analytics',
      metric: 'web_page_views',
      date_from: '-1d',
      dimensions: ['source'],
      env: 'prod',
    });
    expect(result.status).toBe(200);
    expect(result.body.breakdowns.source).toHaveLength(50);
    expect(result.body.meta.truncated_dimensions).toEqual(['source']);
  });
});
