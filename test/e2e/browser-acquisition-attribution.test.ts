import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquisitionPropertyDefinitions, createAttributionClient } from '../../sdk/src/attribution.ts';
import { createClient } from '../../sdk/src/index.ts';
import { activeMetric, api, createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv();
  await activeMetric(env, { key: 'signup_completed', type: 'unique_actors', source: { event: 'signup.completed' } });
  await activeMetric(env, { key: 'session_started', type: 'unique_actors', source: { event: 'session.started' } });
  const browserSetup = await api(env, env.secretToken, 'POST', `${P()}/properties/browser-analytics`, {
    route_keys: ['signup', 'checkout'],
  });
  expect(browserSetup.status).toBe(200);
  const trustedRoute = await api(
    env,
    env.secretToken,
    'PATCH',
    `${P()}/properties/event/%24route_key`,
    { status: 'trusted' },
  );
  expect(trustedRoute.status).toBe(200);
});

afterAll(() => env.close());

describe('browser acquisition attribution end to end', () => {
  it('proves tagged landing → navigation → signup → actor link → filtered and broken-down trend', async () => {
    const proposed = await api(env, env.secretToken, 'POST', `${P()}/properties/acquisition-attribution`, {});
    expect(proposed.status).toBe(200);
    expect(proposed.body.properties).toHaveLength(5);
    expect(proposed.body.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '$utm_source', scope: 'event', value_type: 'string', status: 'proposed' }),
    ]));
    expect(proposed.body.properties.map((property: { key: string; purpose: string }) => ({ key: property.key, purpose: property.purpose }))).toEqual(
      acquisitionPropertyDefinitions.map((property) => ({ key: property.key, purpose: property.purpose })),
    );
    const proposedAgain = await api(env, env.secretToken, 'POST', `${P()}/properties/acquisition-attribution`, {});
    expect(proposedAgain.body.properties.map((property: { id: string }) => property.id)).toEqual(proposed.body.properties.map((property: { id: string }) => property.id));

    const browser = {
      location: { href: 'https://app.example/landing?utm_source=newsletter&utm_campaign=launch&unknown=do-not-store' },
      document: { referrer: 'https://publisher.example/article?private=do-not-store' },
    };
    let actor = 'anon-browser-1';
    const client = createClient({
      url: 'http://poolstatis.test', ingestKey: env.ingestToken,
      fetch: async (input, init) => injectedFetch(env, input, init),
      flushIntervalMs: 60_000,
    });
    const consent = consentController(true);
    const analytics = createAttributionClient({
      client, browser, distinctId: () => actor, hasConsent: consent.has, subscribeConsent: consent.subscribe, route: () => 'signup', createSessionId: () => 'browser-session-1',
    });

    await analytics.start();
    browser.location.href = 'https://app.example/signup';
    actor = 'user-browser-1';
    analytics.pageViewed();
    analytics.track('signup.completed');
    await analytics.flush();
    await client.shutdown();

    const beforeLink = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'funnel', steps: [{ metric: 'session_started' }, { metric: 'signup_completed' }], date_from: '-1d', env: 'prod',
    });
    expect(beforeLink.body.steps.map((step: { actors: number }) => step.actors)).toEqual([1, 0]);

    const linked = await api(env, env.secretToken, 'POST', `${P()}/identity-links`, {
      source_distinct_id: 'anon-browser-1', target_distinct_id: 'user-browser-1', env: 'prod',
    });
    expect(linked.status).toBe(201);
    const afterLink = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'funnel', steps: [{ metric: 'session_started' }, { metric: 'signup_completed' }], date_from: '-1d', env: 'prod',
    });
    expect(afterLink.body.steps.map((step: { actors: number }) => step.actors)).toEqual([1, 1]);

    const breakdown = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'signup_completed', date_from: '-1d', interval: 'day',
      breakdown: { property: '$utm_source' }, env: 'prod',
    });
    expect(breakdown.status).toBe(200);
    expect(breakdown.body.series).toEqual(expect.arrayContaining([expect.objectContaining({ breakdown_value: 'newsletter', value: 1 })]));
    expect(breakdown.body.meta.note).toContain('Session landing attribution');
    expect(breakdown.body.meta.note).toContain('not causal');

    const filtered = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'signup_completed', date_from: '-1d', interval: 'day',
      filters: [{ property: '$utm_source', op: 'eq', value: 'newsletter' }], env: 'prod',
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.series.reduce((sum: number, point: { value: number }) => sum + point.value, 0)).toBe(1);

    const trusted = await api(env, env.secretToken, 'PATCH', `${P()}/properties/event/%24utm_source`, { status: 'trusted' });
    expect(trusted.status).toBe(200);
    const trust = await api(env, env.secretToken, 'POST', `${P()}/measurement/trust`, {
      metric_key: 'signup_completed', env: 'prod', target_filters: [{ property: '$utm_source', op: 'eq', value: 'newsletter' }],
    });
    expect(trust.body).toMatchObject({ status: 'trusted', properties: [expect.objectContaining({ key: '$utm_source', status: 'trusted', coverage: 1 })] });

    const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=20`);
    const signup = events.body.events.find((event: { event: string }) => event.event === 'signup.completed');
    const session = events.body.events.find((event: { event: string }) => event.event === 'session.started');
    expect(signup).toMatchObject({ distinct_id: 'user-browser-1', session_id: 'browser-session-1', properties: { $utm_source: 'newsletter', landing_route: 'signup', referrer_origin: 'https://publisher.example' } });
    expect(session).toMatchObject({ distinct_id: 'anon-browser-1', session_id: 'browser-session-1' });
    expect(JSON.stringify(events.body)).not.toContain('unknown=do-not-store');
    expect(JSON.stringify(events.body)).not.toContain('publisher.example/article');
  });

  it('does not deliver queued wrapper events after consent is revoked', async () => {
    const consent = consentController(true);
    const client = createClient({ url: 'http://poolstatis.test', ingestKey: env.ingestToken, fetch: async (input, init) => injectedFetch(env, input, init), flushIntervalMs: 60_000 });
    const analytics = createAttributionClient({
      client, distinctId: 'anon-revoked', hasConsent: consent.has, subscribeConsent: consent.subscribe, route: 'checkout', createSessionId: () => 'browser-session-revoked',
      browser: { location: { href: 'https://app.example/checkout?utm_source=ads' }, document: { referrer: '' } },
    });
    await analytics.start();
    analytics.track('checkout.completed');
    consent.set(false);
    await client.flush();
    await client.shutdown();

    const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=50`);
    expect(events.body.events.map((event: { event: string }) => event.event)).not.toContain('checkout.completed');
    expect(events.body.events.map((event: { event: string }) => event.event)).not.toContain('never.sent');
  });

  it('strips legacy landing_path without retaining a raw URL in events or warnings', async () => {
    const compatible = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'bad-attribution-url',
      events: [{ event: 'signup.completed', distinct_id: 'bad-url', session_id: 'session-bad', properties: { landing_path: 'https://private.example/path?token=never-store' } }],
    });
    expect(compatible.status).toBe(200);
    expect(compatible.body).toMatchObject({ accepted: 1 });
    expect(JSON.stringify(compatible.body)).not.toContain('private.example');
    const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?event=signup.completed&limit=20`);
    const compatibleEvent = events.body.events.find((event: { distinct_id: string }) => event.distinct_id === 'bad-url');
    expect(compatibleEvent.properties).not.toHaveProperty('landing_route');
    expect(JSON.stringify(compatibleEvent)).not.toContain('private.example');
    const warnings = await api(env, env.secretToken, 'GET', `${P()}/ingest-warnings?env=prod&kind=rejected`);
    expect(warnings.status).toBe(200);
    expect(JSON.stringify(warnings.body)).not.toContain('private.example');
  });
});

async function injectedFetch(env: TestEnv, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const response = await env.app.inject({
    method: init?.method ?? 'GET',
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    payload: init?.body as string | undefined,
  });
  return new Response(response.body, { status: response.statusCode, headers: Object.fromEntries(response.headers as Record<string, string>) });
}

function consentController(initial: boolean) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    has: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: (next: boolean) => { value = next; listeners.forEach((listener) => listener()); },
  };
}
