import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(() => env.close());

describe('browser experience surfaces and ingest', () => {
  const P = () => `/api/v1/projects/${env.projectSlug}`;

  it('accepts only whitelisted interaction fields for an active, purpose-tagged surface', async () => {
    const created = await api(env, env.secretToken, 'POST', `${P()}/experience/surfaces`, {
      key: 'checkout',
      name: 'Checkout',
      purpose: 'Understand friction before a buyer completes checkout.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({ key: 'checkout', status: 'active' }));

    const captured = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'checkout',
      events: [
        { kind: 'page_viewed', distinct_id: 'actor-1', session_id: 'session-1', route: '/checkout', sequence: 1 },
        {
          kind: 'element_clicked', distinct_id: 'actor-1', session_id: 'session-1', route: '/checkout',
          label: 'pay_now', x: 0.25, y: 0.5, sequence: 2,
        },
        { kind: 'scroll_depth', distinct_id: 'actor-1', session_id: 'session-1', route: '/checkout', depth: 75, sequence: 3 },
        {
          kind: 'client_error', distinct_id: 'actor-1', session_id: 'session-1', route: '/checkout',
          error_type: 'unhandled_rejection', sequence: 4,
        },
      ],
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ accepted: 4 });

    const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?env=prod&limit=10&distinct_id=actor-1`);
    expect(events.status).toBe(200);
    expect(events.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'experience.element_clicked', session_id: 'session-1', registered: true,
        properties: { surface: 'checkout', route: '/checkout', sequence: 2, label: 'pay_now', x: 0.25, y: 0.5 },
      }),
      expect.objectContaining({
        event: 'experience.client_error',
        properties: { surface: 'checkout', route: '/checkout', sequence: 4, error_type: 'unhandled_rejection' },
      }),
    ]));
  });

  it('rejects unsafe routes and stops capture when a surface is archived', async () => {
    const created = await api(env, env.secretToken, 'POST', `${P()}/experience/surfaces`, {
      key: 'settings',
      name: 'Settings',
      purpose: 'Find interaction friction in account settings.',
    });
    expect(created.status).toBe(201);

    const unsafe = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'settings',
      events: [{ kind: 'page_viewed', distinct_id: 'actor-2', session_id: 'session-2', route: '/settings?token=secret', sequence: 1 }],
    });
    expect(unsafe.status).toBe(400);

    const archived = await api(env, env.secretToken, 'POST', `${P()}/experience/surfaces/settings/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');

    const blocked = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'settings',
      events: [{ kind: 'page_viewed', distinct_id: 'actor-2', session_id: 'session-2', route: '/settings', sequence: 1 }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('experience_surface_not_active');
  });
});
