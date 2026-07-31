import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
const project = () => `/api/v1/projects/${env.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  const setup = await api(
    env,
    env.secretToken,
    'POST',
    `${project()}/properties/browser-analytics`,
    { route_keys: ['home', 'other'] },
  );
  expect(setup.status).toBe(200);
  expect((await api(
    env,
    env.secretToken,
    'PATCH',
    `${project()}/properties/event/$route_key`,
    { status: 'trusted' },
  )).status).toBe(200);
  expect((await api(
    env,
    env.secretToken,
    'PATCH',
    `${project()}/metrics/web_page_views`,
    { status: 'active' },
  )).status).toBe(200);
  await activeMetric(env, { key: 'session_started_compat', source: { event: 'session.started' } });
  await activeMetric(env, { key: 'signup_completed_compat', source: { event: 'signup.completed' } });
  await activeMetric(env, { key: 'deep_scroll_compat', source: { event: 'page.deep_scrolled' } });
  await activeMetric(env, { key: 'page_engagement_compat', source: { event: 'page.engagement' } });
});

afterAll(() => env.close());

describe('published browser SDK compatibility on /i/v1/events', () => {
  it('accepts SDK 0.1, 0.2 and 0.3 payloads without retaining legacy raw paths', async () => {
    for (const fixture of browserSdkFixtures()) {
      const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', fixture);
      expect(response.status, `${fixture.batch_id}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.accepted).toBe(fixture.events.length);
    }

    const sampled = await api(env, env.secretToken, 'GET', `${project()}/events/sample?limit=100`);
    expect(sampled.status).toBe(200);
    const serialized = JSON.stringify(sampled.body);
    expect(serialized).not.toContain('landing_path');
    expect(serialized).not.toContain('$page_path');
    expect(serialized).not.toContain('/account/customer-42');

    const publishedPage = sampled.body.events.find(
      (event: { distinct_id: string; event: string }) => (
        event.distinct_id === 'sdk-010-published' && event.event === 'page.viewed'
      ),
    );
    expect(publishedPage.properties).toMatchObject({
      $browser_context: '1',
      $route_key: 'other',
      landing_route: 'other',
      $utm_source: 'newsletter',
      $country: 'unknown',
    });
    expect(publishedPage.properties.$page_view_id).toMatch(/^legacy:[a-f0-9]{32}$/);
    expect(publishedPage.properties).not.toHaveProperty('path');

    const legacyPage = sampled.body.events.find(
      (event: { distinct_id: string; event: string }) => (
        event.distinct_id === 'sdk-010-browser' && event.event === 'page.viewed'
      ),
    );
    const legacyEngagement = sampled.body.events.find(
      (event: { distinct_id: string; event: string }) => (
        event.distinct_id === 'sdk-010-browser' && event.event === 'page.engagement'
      ),
    );
    expect(legacyPage.properties).toMatchObject({
      $browser_context: '1',
      $route_key: 'home',
      landing_route: 'home',
      $country: 'unknown',
    });
    expect(legacyEngagement.properties.$page_view_id).toBe(legacyPage.properties.$page_view_id);

    const legacyCustom = sampled.body.events.find(
      (event: { distinct_id: string; event: string }) => (
        event.distinct_id === 'sdk-010-browser' && event.event === 'page.deep_scrolled'
      ),
    );
    expect(legacyCustom.properties).toMatchObject({
      threshold: 75,
      landing_route: 'home',
      $utm_source: 'newsletter',
    });
    expect(legacyCustom.properties).not.toHaveProperty('$browser_context');
    expect(legacyCustom.properties).not.toHaveProperty('$route_key');
    expect(legacyCustom.properties).not.toHaveProperty('$country');

    const rejectedWarnings = await api(
      env,
      env.secretToken,
      'GET',
      `${project()}/ingest-warnings?env=prod&kind=rejected`,
    );
    expect(rejectedWarnings.status).toBe(200);
    expect(rejectedWarnings.body.warnings).toEqual([]);
  });
});

function browserSdkFixtures() {
  return [
    {
      batch_id: 'published-sdk-0.1.0-contract',
      events: [
        {
          event: 'session.started',
          distinct_id: 'sdk-010-published',
          session_id: 'session-sdk-010-published',
          properties: {
            landing_path: '/account/customer-42',
            $utm_source: 'newsletter',
            referrer_origin: 'https://publisher.example',
          },
        },
        {
          event: 'page.viewed',
          distinct_id: 'sdk-010-published',
          session_id: 'session-sdk-010-published',
          properties: {
            path: '/account/customer-42',
            landing_path: '/account/customer-42',
            $utm_source: 'newsletter',
            referrer_origin: 'https://publisher.example',
          },
        },
        {
          event: 'signup.completed',
          distinct_id: 'sdk-010-published',
          session_id: 'session-sdk-010-published',
          properties: {
            landing_path: '/account/customer-42',
            $utm_source: 'newsletter',
          },
        },
      ],
    },
    {
      batch_id: 'vendored-browser-sdk-0.1.0-contract',
      events: [
        {
          event: 'page.viewed',
          distinct_id: 'sdk-010-browser',
          session_id: 'session-sdk-010-browser',
          properties: {
            $browser_context: '1',
            $page_path: '/home',
            landing_path: '/home',
            $device_class: 'desktop',
            $browser_family: 'chrome',
            $os_family: 'macos',
            $language: 'ru',
            $timezone: 'Europe/Moscow',
            $viewport_bucket: 'lg',
            $screen_bucket: 'xl',
            $country: 'US',
            $utm_source: 'newsletter',
          },
        },
        {
          event: 'page.engagement',
          distinct_id: 'sdk-010-browser',
          session_id: 'session-sdk-010-browser',
          properties: {
            $browser_context: '1',
            $page_path: '/home',
            landing_path: '/home',
            sequence: 1,
            foreground_ms: 10_000,
            elapsed_ms: 12_000,
            max_scroll_pct: 75,
            interaction_count: 1,
            reason: 'heartbeat',
          },
        },
        {
          event: 'page.deep_scrolled',
          distinct_id: 'sdk-010-browser',
          session_id: 'session-sdk-010-browser',
          properties: {
            threshold: 75,
            $browser_context: '1',
            $page_path: '/home',
            landing_path: '/home',
            $device_class: 'desktop',
            $browser_family: 'chrome',
            $country: 'US',
            $utm_source: 'newsletter',
          },
        },
      ],
    },
    {
      batch_id: 'vendored-browser-sdk-0.2.0-contract',
      events: [{
        event: 'page.viewed',
        distinct_id: 'sdk-020-browser',
        session_id: 'session-sdk-020-browser',
        properties: {
          $browser_context: '1',
          $route_key: 'home',
          $page_view_id: 'page:sdk-020-browser',
          landing_route: 'home',
          $device_class: 'desktop',
        },
      }],
    },
    {
      batch_id: 'release-browser-sdk-0.3.0-contract',
      events: [{
        event: 'page.engagement',
        distinct_id: 'sdk-030-browser',
        session_id: 'session-sdk-030-browser',
        properties: {
          $browser_context: '1',
          $route_key: 'home',
          $page_view_id: 'page:sdk-030-browser',
          landing_route: 'home',
          sequence: 1,
          foreground_ms: 15_000,
          elapsed_ms: 15_000,
          max_scroll_pct: 100,
          interaction_count: 2,
          reason: 'heartbeat',
        },
      }],
    },
  ];
}
