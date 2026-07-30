import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BROWSER_ANALYTICS_PROPERTIES } from '../src/services/browserAnalytics.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('property registry and measurement trust', () => {
  let env: TestEnv;
  let other: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    await activeMetric(env, {
      key: 'signup_completed',
      type: 'unique_actors',
      source: { event: 'signup.completed', filters: [] },
    });
  });

  afterAll(async () => {
    await env.close();
    await other.close();
  });

  test('requires explicit property meaning and reports evidence-backed metric trust', async () => {
    const initialTrust = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/measurement/trust',
      { metric_key: 'signup_completed', env: 'prod', target_filters: [] },
    );
    expect(initialTrust.status).toBe(200);
    expect(initialTrust.body.status).toBe('untrusted');
    expect(initialTrust.body.blockers.map((item: { code: string }) => item.code))
      .toContain('primary_metric_no_observations');

    const invalid = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/properties',
      { key: 'plan', scope: 'event', value_type: 'string', purpose: 'too short' },
    );
    expect(invalid.status).toBe(400);

    const created = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/properties',
      {
        key: 'plan',
        scope: 'event',
        value_type: 'string',
        purpose: 'Segments signup outcomes by the commercial plan selected.',
      },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'plan', status: 'proposed', source: 'native' });

    const untrustedProperty = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/measurement/trust',
      {
        metric_key: 'signup_completed',
        env: 'prod',
        target_filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
      },
    );
    expect(untrustedProperty.body.blockers.map((item: { code: string }) => item.code))
      .toContain('target_property_untrusted');

    const trusted = await api(
      env,
      env.secretToken,
      'PATCH',
      '/api/v1/projects/' + env.projectSlug + '/properties/event/plan',
      { status: 'trusted' },
    );
    expect(trusted.status).toBe(200);
    expect(trusted.body.status).toBe('trusted');

    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'property-coverage',
      events: [
        { event: 'signup.completed', distinct_id: 'u1', properties: { plan: 'pro' } },
        { event: 'signup.completed', distinct_id: 'u2', properties: {} },
      ],
    });
    expect(ingested.status).toBe(200);

    const assessed = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/measurement/trust',
      {
        metric_key: 'signup_completed',
        env: 'prod',
        target_filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
      },
    );
    expect(assessed.status).toBe(200);
    expect(assessed.body).toMatchObject({
      status: 'trusted',
      primary_metric: {
        key: 'signup_completed',
        observed_events: 2,
        observed_actors: 2,
        registered_coverage: 1,
      },
      identity: { distinct_id_coverage: 1 },
    });
    expect(assessed.body.properties[0]).toMatchObject({
      key: 'plan',
      status: 'trusted',
      coverage: 0.5,
    });
    expect(assessed.body.warnings.map((item: { code: string }) => item.code))
      .toContain('target_property_low_coverage');

    const listed = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + env.projectSlug + '/properties',
    );
    expect(listed.status).toBe(200);
    expect(listed.body.properties).toHaveLength(1);

    const projectSchema = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + env.projectSlug + '/schema?env=prod',
    );
    expect(projectSchema.status).toBe(200);
    expect(projectSchema.body).toMatchObject({
      properties: [expect.objectContaining({ key: 'plan', status: 'trusted' })],
      identity: { active_links: 0, linked_sources: 0, audit_entries: 0 },
      sources: [],
    });

    const crossOrg = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + other.projectSlug + '/properties',
    );
    expect(crossOrg.status).toBe(404);
  });

  test('rejects a noncanonical existing definition for reserved acquisition UTM keys', async () => {
    const malformed = await api(
      other,
      other.secretToken,
      'POST',
      '/api/v1/projects/' + other.projectSlug + '/properties',
      { key: '$utm_source', scope: 'event', value_type: 'string', purpose: 'An unrelated legacy property with an incompatible meaning.' },
    );
    expect(malformed.status).toBe(201);
    const setup = await api(
      other,
      other.secretToken,
      'POST',
      '/api/v1/projects/' + other.projectSlug + '/properties/acquisition-attribution',
      {},
    );
    expect(setup.status).toBe(409);
    expect(setup.body.error.code).toBe('acquisition_property_conflict');
  });

  test('rejects a noncanonical existing definition for reserved browser keys', async () => {
    const malformed = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/properties',
      { key: '$route_key', scope: 'event', value_type: 'string', purpose: 'A dynamic route field with no finite trusted vocabulary.' },
    );
    expect(malformed.status).toBe(201);
    const setup = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/properties/browser-analytics',
      { route_keys: ['home', 'pricing'] },
    );
    expect(setup.status).toBe(409);
    expect(setup.body.error.code).toBe('browser_property_conflict');
  });

  test('invalidates a primed missing-route cache after generic property creation', async () => {
    const cacheEnv = await createTestEnv();
    try {
      const browserEvent = {
        event: 'page.viewed',
        distinct_id: 'cache-actor',
        session_id: 'cache-session',
        properties: {
          $browser_context: '1',
          $route_key: 'home',
          $page_view_id: 'cache-page',
        },
      };
      const primed = await api(cacheEnv, cacheEnv.ingestToken, 'POST', '/i/v1/events', {
        events: [browserEvent],
      });
      expect(primed.status).toBe(207);

      const created = await api(
        cacheEnv,
        cacheEnv.secretToken,
        'POST',
        '/api/v1/projects/' + cacheEnv.projectSlug + '/properties',
        {
          key: '$route_key',
          scope: 'event',
          value_type: 'enum',
          enum_values: ['home'],
          purpose: BROWSER_ANALYTICS_PROPERTIES.$route_key!.purpose,
          status: 'trusted',
          source: 'native',
        },
      );
      expect(created.status).toBe(201);

      const accepted = await api(cacheEnv, cacheEnv.ingestToken, 'POST', '/i/v1/events', {
        events: [{ ...browserEvent, properties: { ...browserEvent.properties, $page_view_id: 'cache-page-2' } }],
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body.accepted).toBe(1);
    } finally {
      await cacheEnv.close();
    }
  });
});
