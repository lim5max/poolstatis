import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;
const enc = encodeURIComponent;

beforeAll(async () => {
  env = await createTestEnv();
  await activeMetric(env, {
    key: 'app_opened',
    source: { event: 'app.opened', filters: [] },
  });
  await activeMetric(env, {
    key: 'doc_exported',
    source: { event: 'doc.exported', filters: [] },
  });
  await api(env, env.secretToken, 'POST', `${P()}/entity-types`, {
    name: 'user', description: 'End users, for the person summary + filter tests.',
  });
  await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
    entities: [{ entity_type: 'user', entity_id: 'u_a', properties: { name: 'Ada', email: 'ada@x.io', plan: 'pro' } }],
  });
  await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    events: [
      { event: 'app.opened', distinct_id: 'u_a', properties: { plan: 'pro' } },
      { event: 'app.opened', distinct_id: 'u_a', properties: { plan: 'pro' } },
      { event: 'app.opened', distinct_id: 'u_a', properties: { plan: 'pro' } },
      { event: 'doc.exported', distinct_id: 'u_a', properties: { plan: 'pro' } },
      { event: 'app.opened', distinct_id: 'u_b', properties: { plan: 'free' } },
      // numeric-property events (no `plan`) for the range-filter tests
      { event: 'checkout.completed', distinct_id: 'u_c', properties: { amount: 9 } },
      { event: 'checkout.completed', distinct_id: 'u_c', properties: { amount: 100 } },
      { event: 'checkout.completed', distinct_id: 'u_c', properties: { amount: 1000 } },
    ],
  });
});
afterAll(() => env.close());

describe('person summary endpoint', () => {
  it('derives canonical engagement stats and fails closed on arbitrary identity entities', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/persons/u_a?env=prod`);
    expect(res.status).toBe(200);
    expect(res.body.summary.total_events).toBe(4);
    expect(res.body.summary.distinct_events).toBe(2);
    expect(res.body.summary.first_seen).toBeTruthy();
    expect(res.body.summary.top_events[0]).toEqual({ event: 'app.opened', count: 3 });
    expect(res.body.summary.session_count).toBeNull();
    expect(res.body.entity).toBeNull();
    expect(res.body.capabilities.identity_entity).toMatchObject({
      available: false,
      source: null,
    });
    expect(res.body.activity.events.every((event: any) =>
      Object.keys(event.properties).length === 0
    )).toBe(true);
  });

  it('returns a zeroed summary + null entity for an unknown actor', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/persons/nobody?env=prod`);
    expect(res.status).toBe(200);
    expect(res.body.summary.total_events).toBe(0);
    expect(res.body.summary.first_seen).toBeNull();
    expect(res.body.entity).toBeNull();
    expect(res.body.identity.status).toBe('unknown');
  });
});

describe('event sample filters', () => {
  it('filters by a property (eq)', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100&prop=${enc('plan:eq:free')}`);
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events.every((e: any) => e.properties.plan === 'free')).toBe(true);
  });

  it('filters by is_set', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100&prop=${enc('plan:is_set:')}`);
    expect(res.body.events.every((e: any) => 'plan' in e.properties)).toBe(true);
    expect(res.body.events.length).toBe(5);
  });

  it('filters by actor + event together', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100&distinct_id=u_a&event=app.opened`);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events.every((e: any) => e.distinct_id === 'u_a' && e.event === 'app.opened')).toBe(true);
  });

  it('rejects a malformed prop token', async () => {
    const res = await api(env, env.secretToken, 'GET', `${P()}/events/sample?prop=garbage`);
    expect(res.status).toBe(400);
  });

  it('compares numeric range filters numerically, not lexically', async () => {
    // The regression: text comparison makes '9' > '100' true and '1000' > '100' false.
    const gt = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100&prop=${enc('amount:gt:100')}`);
    expect(gt.status).toBe(200);
    const gtAmounts = gt.body.events.map((e: any) => e.properties.amount).sort((a: number, b: number) => a - b);
    expect(gtAmounts).toEqual([1000]); // strictly > 100: only 1000, NOT 9

    const gte = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100&prop=${enc('amount:gte:100')}`);
    expect(gte.body.events.map((e: any) => e.properties.amount).sort((a: number, b: number) => a - b)).toEqual([100, 1000]);

    const lt = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=100&prop=${enc('amount:lt:100')}`);
    expect(lt.body.events.map((e: any) => e.properties.amount)).toEqual([9]); // 9 < 100, and 1000 is NOT
  });
});
