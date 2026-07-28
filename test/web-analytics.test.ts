import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import {
  createLocalMmdbCountryResolverFromReader,
  createTrustedProxyCountryResolver,
  DB_IP_ATTRIBUTION,
} from '../src/services/country.js';

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

  it('upgrades a legacy-compatible reserved metric without changing its review status', async () => {
    const legacy = await createTestEnv({ countryResolver });
    try {
      const registered = await api(
        legacy,
        legacy.secretToken,
        'POST',
        `/api/v1/projects/${legacy.projectSlug}/metrics`,
        {
          key: 'web_page_views',
          name: 'Legacy page views',
          purpose: 'Counts the older browser page-view contract before canonical setup.',
          category: 'acquisition',
          tags: ['legacy-import'],
          type: 'count',
          source: { event: 'page.viewed', filters: [], data_source: 'native' },
        },
      );
      expect(registered.status).toBe(201);
      const visitors = await api(
        legacy,
        legacy.secretToken,
        'POST',
        `/api/v1/projects/${legacy.projectSlug}/metrics`,
        {
          key: 'web_visitors',
          name: 'Legacy visitors',
          purpose: 'Counts the older browser visitor contract before canonical setup.',
          category: 'acquisition',
          tags: ['legacy-reach'],
          type: 'unique_actors',
          source: { event: 'page.viewed' },
        },
      );
      expect(visitors.status).toBe(201);
      expect((await api(
        legacy,
        legacy.secretToken,
        'PATCH',
        `/api/v1/projects/${legacy.projectSlug}/metrics/web_page_views`,
        { status: 'active' },
      )).status).toBe(200);

      const setup = await api(
        legacy,
        legacy.secretToken,
        'POST',
        `/api/v1/projects/${legacy.projectSlug}/properties/browser-analytics`,
        {},
      );

      expect(setup.status).toBe(200);
      expect(setup.body.metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'web_page_views',
          id: registered.body.id,
          owner: registered.body.owner,
          name: 'Web page views',
          purpose: 'Counts consented privacy-bounded page views to assess website traffic and route demand.',
          category: 'acquisition',
          status: 'active',
          tags: expect.arrayContaining(['legacy-import', 'browser-analytics']),
          source: {
            event: 'page.viewed',
            filters: [{ property: '$browser_context', op: 'eq', value: '1' }],
            data_source: 'native',
          },
        }),
        expect.objectContaining({
          key: 'web_visitors',
          id: visitors.body.id,
          owner: visitors.body.owner,
          name: 'Web visitors',
          purpose: 'Counts unique resolved browser actors to compare traffic reach without conflating sessions or page views.',
          category: 'acquisition',
          status: 'proposed',
          tags: expect.arrayContaining(['legacy-reach', 'browser-analytics']),
          source: {
            event: 'page.viewed',
            filters: [{ property: '$browser_context', op: 'eq', value: '1' }],
            data_source: 'native',
          },
        }),
      ]));
      const beforeRepeat = await legacy.pool.query<{ updated_at: Date }>(
        `SELECT updated_at
           FROM metrics
          WHERE project_id = $1 AND key = 'web_page_views'`,
        [legacy.projectId],
      );

      const repeated = await api(
        legacy,
        legacy.secretToken,
        'POST',
        `/api/v1/projects/${legacy.projectSlug}/properties/browser-analytics`,
        {},
      );
      expect(repeated.status).toBe(200);
      expect(repeated.body.metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'web_page_views',
          id: registered.body.id,
          status: 'active',
          tags: expect.arrayContaining(['legacy-import', 'browser-analytics']),
        }),
        expect.objectContaining({
          key: 'web_visitors',
          id: visitors.body.id,
          status: 'proposed',
          tags: expect.arrayContaining(['legacy-reach', 'browser-analytics']),
        }),
      ]));
      expect(repeated.body.metrics.find((item: { key: string; tags: string[] }) => item.key === 'web_page_views')
        .tags.filter((tag: string) => tag === 'browser-analytics')).toHaveLength(1);
      const afterRepeat = await legacy.pool.query<{ updated_at: Date }>(
        `SELECT updated_at
           FROM metrics
          WHERE project_id = $1 AND key = 'web_page_views'`,
        [legacy.projectId],
      );
      expect(afterRepeat.rows[0]!.updated_at.toISOString()).toBe(beforeRepeat.rows[0]!.updated_at.toISOString());
    } finally {
      await legacy.close();
    }
  });

  it('preflights both reserved metrics before changing a legacy-compatible definition', async () => {
    const collision = await createTestEnv({ countryResolver });
    try {
      const pageViews = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
        {
          key: 'web_page_views',
          name: 'Legacy page views',
          purpose: 'Counts the untouched legacy browser page-view contract for migration safety.',
          category: 'acquisition',
          tags: ['must-remain-legacy'],
          type: 'count',
          source: { event: 'page.viewed', filters: [] },
        },
      );
      expect(pageViews.status).toBe(201);
      expect((await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
        {
          key: 'web_visitors',
          name: 'Checkout visitors',
          purpose: 'Counts checkout visitors for a product-specific conversion decision.',
          category: 'activation',
          type: 'unique_actors',
          source: { event: 'checkout.viewed', filters: [] },
        },
      )).status).toBe(201);
      const propertiesBefore = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/properties`,
      );
      const metricsBefore = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
      );

      const setup = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties/browser-analytics`,
        {},
      );
      expect(setup.status).toBe(409);
      expect(setup.body.error.code).toBe('browser_metric_conflict');

      const propertiesAfter = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/properties`,
      );
      expect(propertiesAfter.body.properties).toEqual(propertiesBefore.body.properties);
      const listed = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
      );
      expect(listed.body.metrics).toEqual(metricsBefore.body.metrics);
      const unchanged = listed.body.metrics.find((item: { key: string }) => item.key === 'web_page_views');
      expect(unchanged).toEqual(expect.objectContaining({
        id: pageViews.body.id,
        name: 'Legacy page views',
        purpose: 'Counts the untouched legacy browser page-view contract for migration safety.',
        tags: ['must-remain-legacy'],
        source: { event: 'page.viewed', filters: [], data_source: 'native' },
      }));
    } finally {
      await collision.close();
    }
  });

  it('preflights every browser property before creating an earlier reserved definition', async () => {
    const collision = await createTestEnv({ countryResolver });
    try {
      expect((await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties`,
        {
          key: '$country',
          scope: 'event',
          value_type: 'string',
          purpose: 'Stores a client supplied browser locale as a misleading country proxy.',
        },
      )).status).toBe(201);
      const before = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/properties`,
      );

      const setup = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties/browser-analytics`,
        {},
      );
      expect(setup.status).toBe(409);
      expect(setup.body.error.code).toBe('browser_property_conflict');

      const after = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/properties`,
      );
      expect(after.body.properties).toEqual(before.body.properties);
    } finally {
      await collision.close();
    }
  });

  it('preflights every acquisition property before browser setup creates any definitions', async () => {
    const collision = await createTestEnv({ countryResolver });
    try {
      expect((await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties`,
        {
          key: '$utm_content',
          scope: 'event',
          value_type: 'string',
          purpose: 'Stores an unrelated content label with incompatible attribution semantics.',
        },
      )).status).toBe(201);
      const before = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/properties`,
      );

      const setup = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties/browser-analytics`,
        {},
      );
      expect(setup.status).toBe(409);
      expect(setup.body.error.code).toBe('acquisition_property_conflict');

      const after = await api(
        collision,
        collision.secretToken,
        'GET',
        `/api/v1/projects/${collision.projectSlug}/properties`,
      );
      expect(after.body.properties).toEqual(before.body.properties);
    } finally {
      await collision.close();
    }
  });

  it('rejects an incompatible reserved metric instead of rewriting user semantics', async () => {
    const collision = await createTestEnv({ countryResolver });
    try {
      expect((await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
        {
          key: 'web_page_views',
          name: 'Checkout page views',
          purpose: 'Counts checkout views for a product-specific conversion decision.',
          category: 'activation',
          type: 'count',
          source: { event: 'checkout.viewed', filters: [], data_source: 'native' },
        },
      )).status).toBe(201);

      const setup = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties/browser-analytics`,
        {},
      );

      expect(setup.status).toBe(409);
      expect(setup.body.error.code).toBe('browser_metric_conflict');
    } finally {
      await collision.close();
    }
  });

  it('rejects a reserved metric filter with unexpected JSON fields', async () => {
    const collision = await createTestEnv({ countryResolver });
    try {
      expect((await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
        {
          key: 'web_page_views',
          name: 'Legacy page views',
          purpose: 'Counts legacy browser page views before canonical browser analytics setup.',
          category: 'acquisition',
          type: 'count',
          source: {
            event: 'page.viewed',
            filters: [{ property: '$browser_context', op: 'eq', value: '1' }],
          },
        },
      )).status).toBe(201);
      await collision.pool.query(
        `UPDATE metrics
            SET source = jsonb_set(
              source,
              '{filters,0}',
              (source->'filters'->0) || jsonb_build_object('unexpected', 'value')
            )
          WHERE project_id = $1 AND key = $2`,
        [collision.projectId, 'web_page_views'],
      );

      const setup = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties/browser-analytics`,
        {},
      );
      expect(setup.status).toBe(409);
      expect(setup.body.error.code).toBe('browser_metric_conflict');
    } finally {
      await collision.close();
    }
  });

  it('rejects external-source residue on a legacy native reserved metric', async () => {
    const collision = await createTestEnv({ countryResolver });
    try {
      expect((await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/metrics`,
        {
          key: 'web_page_views',
          name: 'Legacy page views',
          purpose: 'Counts legacy browser page views before canonical browser analytics setup.',
          category: 'acquisition',
          type: 'count',
          source: { event: 'page.viewed', filters: [] },
        },
      )).status).toBe(201);
      await collision.pool.query(
        `UPDATE metrics
            SET source = source || jsonb_build_object('source_connection_id', $3::text)
          WHERE project_id = $1 AND key = $2`,
        [collision.projectId, 'web_page_views', '00000000-0000-4000-8000-000000000001'],
      );

      const setup = await api(
        collision,
        collision.secretToken,
        'POST',
        `/api/v1/projects/${collision.projectSlug}/properties/browser-analytics`,
        {},
      );
      expect(setup.status).toBe(409);
      expect(setup.body.error.code).toBe('browser_metric_conflict');
    } finally {
      await collision.close();
    }
  });

  it('exposes required DB-IP attribution only when the local MMDB resolver is active', async () => {
    const attributed = await createTestEnv({
      countryResolver: createLocalMmdbCountryResolverFromReader({
        databasePath: '/run/geoip/country.mmdb',
        clientIpHeader: 'x-poolstatis-client-ip',
        trustedProxyCidrs: ['127.0.0.0/8', '::1/128'],
      }, {
        metadata: { databaseType: 'DBIP-Country-Lite' },
        get: () => ({ country: { iso_code: 'DE' } }),
      }),
    });
    try {
      expect((await api(
        attributed,
        attributed.secretToken,
        'POST',
        `/api/v1/projects/${attributed.projectSlug}/properties/browser-analytics`,
        {},
      )).status).toBe(200);
      expect((await api(
        attributed,
        attributed.secretToken,
        'PATCH',
        `/api/v1/projects/${attributed.projectSlug}/metrics/web_page_views`,
        { status: 'active' },
      )).status).toBe(200);
      const result = await api(
        attributed,
        attributed.secretToken,
        'POST',
        `/api/v1/projects/${attributed.projectSlug}/query`,
        {
          kind: 'web_analytics',
          metric: 'web_page_views',
          date_from: '-1d',
          dimensions: ['country'],
        },
      );
      expect(result.status).toBe(200);
      expect(result.body.meta.country_attribution).toEqual(DB_IP_ATTRIBUTION);
    } finally {
      await attributed.close();
    }
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
      events: [{
        event: 'page.viewed',
        distinct_id: 'legacy-manual',
        session_id: 'legacy-session',
        properties: { custom_dimension: 'kept-for-legacy-consumers' },
      }],
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
    expect(result.body.meta.country_attribution).toBeUndefined();
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
