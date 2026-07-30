import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let other: TestEnv;
const project = () => `/api/v1/projects/${env.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  other = await createTestEnv({ ingestBuffer: false, queryCache: false });
  await api(env, env.secretToken, 'POST', `${project()}/experience/surfaces`, {
    key: 'checkout',
    name: 'Checkout',
    purpose: 'Understand interaction evidence without mixing actor identities.',
  });
  await api(other, other.secretToken, 'POST', `/api/v1/projects/${other.projectSlug}/experience/surfaces`, {
    key: 'checkout',
    name: 'Checkout',
    purpose: 'Keep the tenant isolation fixture explicitly independent.',
  });

  const prod = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
    surface: 'checkout',
    batch_id: 'collision-prod',
    events: [
      {
        kind: 'page_viewed',
        distinct_id: 'actor-a',
        session_id: 'reused-session',
        route: 'checkout',
        sequence: 1,
      },
      {
        kind: 'element_clicked',
        distinct_id: 'actor-b',
        session_id: 'reused-session',
        route: 'checkout',
        sequence: 2,
        label: 'pay',
        x: 0.5,
        y: 0.5,
      },
    ],
  });
  expect(prod.status).toBe(200);

  const dev = await api(env, env.ingestDevToken, 'POST', '/i/v1/experience/events', {
    surface: 'checkout',
    batch_id: 'collision-dev',
    events: [{
      kind: 'scroll_depth',
      distinct_id: 'actor-dev',
      session_id: 'reused-session',
      route: 'checkout',
      sequence: 3,
      depth: 90,
    }],
  });
  expect(dev.status).toBe(200);

  const tenant = await api(other, other.ingestToken, 'POST', '/i/v1/experience/events', {
    surface: 'checkout',
    batch_id: 'collision-other',
    events: [{
      kind: 'client_error',
      distinct_id: 'actor-other',
      session_id: 'reused-session',
      route: 'checkout',
      sequence: 4,
      error_type: 'error',
    }],
  });
  expect(tenant.status).toBe(200);
});

afterAll(async () => {
  await env.close();
  await other.close();
});

describe('actor-safe experience_session', () => {
  it('returns typed ambiguity when a reused session id has multiple actors', async () => {
    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'experience_session',
      surface: 'checkout',
      session_id: 'reused-session',
      date_from: '-1d',
      env: 'prod',
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({
      code: 'experience_session_actor_ambiguous',
      retryable: false,
    });
  });

  it('requires exact actor context and returns canonical provenance without cross-env leakage', async () => {
    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'experience_session',
      surface: 'checkout',
      session_id: 'reused-session',
      actor_id: 'actor-a',
      date_from: '-1d',
      env: 'prod',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: 'experience_session',
      session_id: 'reused-session',
      actor: {
        requested_distinct_id: 'actor-a',
        distinct_id: 'actor-a',
        identity_status: 'unknown',
        raw_distinct_ids: ['actor-a'],
      },
      summary: {
        page_views: 1,
        clicks: 0,
        max_scroll_depth: 0,
        client_errors: 0,
      },
    });
    expect(result.body.events).toHaveLength(1);
    expect(result.body.events[0].kind).toBe('page_viewed');
  });

  it('uses active actor links when actor context is a superseded raw id', async () => {
    const linked = await api(env, env.secretToken, 'POST', `${project()}/identity-links`, {
      source_distinct_id: 'actor-a',
      target_distinct_id: 'canonical-a',
      env: 'prod',
    });
    expect(linked.status).toBe(201);

    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'experience_session',
      surface: 'checkout',
      session_id: 'reused-session',
      actor_id: 'actor-a',
      date_from: '-1d',
      env: 'prod',
    });
    expect(result.status).toBe(200);
    expect(result.body.actor).toMatchObject({
      requested_distinct_id: 'actor-a',
      distinct_id: 'canonical-a',
      identity_status: 'linked',
      raw_distinct_ids: ['actor-a'],
      links: [expect.objectContaining({
        source_distinct_id: 'actor-a',
        target_distinct_id: 'canonical-a',
      })],
    });
    expect(result.body.events).toHaveLength(1);
  });

  it('rejects empty actor context', async () => {
    const result = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'experience_session',
      surface: 'checkout',
      session_id: 'reused-session',
      actor_id: ' ',
      date_from: '-1d',
      env: 'prod',
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('validation_error');
  });

  it('does not invent actor provenance when actor context has no matching session events', async () => {
    const wrongActor = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'experience_session',
      surface: 'checkout',
      session_id: 'reused-session',
      actor_id: 'actor-does-not-match',
      date_from: '-1d',
      env: 'prod',
    });
    expect(wrongActor.status).toBe(404);
    expect(wrongActor.body.error).toMatchObject({
      code: 'experience_session_actor_not_found',
      retryable: false,
    });

    const missingSession = await api(env, env.secretToken, 'POST', `${project()}/query`, {
      kind: 'experience_session',
      surface: 'checkout',
      session_id: 'missing-session',
      actor_id: 'actor-a',
      date_from: '-1d',
      env: 'prod',
    });
    expect(missingSession.status).toBe(404);
    expect(missingSession.body.error.code).toBe('experience_session_actor_not_found');
  });
});
