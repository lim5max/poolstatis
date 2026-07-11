import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

interface Call { path: string; body: any; keepalive?: boolean }

function fakeFetch(behavior: { fail?: number } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fn = vi.fn(async (urlStr: string, init: RequestInit) => {
    n += 1;
    calls.push({ path: new URL(urlStr).pathname, body: JSON.parse(init.body as string), keepalive: (init as any).keepalive });
    if (behavior.fail && n <= behavior.fail) return { ok: false, status: 503 } as Response;
    return { ok: true, status: 200, json: async () => ({ accepted: 1 }) } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('@poolstatis/sdk', () => {
  it('batches events and sends a batch_id on flush', async () => {
    const { fn, calls } = fakeFetch();
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
    ph.track('signup.completed', 'u1', { plan: 'pro' });
    ph.track('doc.exported', 'u1');
    await ph.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/i/v1/events');
    expect(calls[0]!.body.events).toHaveLength(2);
    expect(typeof calls[0]!.body.batch_id).toBe('string');
  });

  it('auto-flushes when the batch fills', async () => {
    const { fn, calls } = fakeFetch();
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn, maxBatchSize: 2 });
    ph.track('a.b', 'u1');
    ph.track('a.b', 'u2'); // reaches maxBatchSize → triggers flush
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body.events).toHaveLength(2);
  });

  it('sends entities to the entities endpoint with merge payload', async () => {
    const { fn, calls } = fakeFetch();
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
    ph.identify('account', 'acc1', { plan: 'pro', trial: null });
    await ph.flush();
    expect(calls[0]!.path).toBe('/i/v1/entities');
    expect(calls[0]!.body.entities[0]).toEqual({ entity_type: 'account', entity_id: 'acc1', properties: { plan: 'pro', trial: null } });
  });

  it('retries a transient 5xx, then succeeds, without dropping the event', async () => {
    const { fn, calls } = fakeFetch({ fail: 1 }); // first call 503, second ok
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
    ph.track('a.b', 'u1');
    await ph.flush();
    expect(calls.length).toBe(2); // retried
    expect(calls[1]!.body.events).toHaveLength(1);
  });

  it('does not retry a 4xx and reports it', async () => {
    const calls: any[] = [];
    const onError = vi.fn();
    const fn = vi.fn(async (_u: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return { ok: false, status: 400 } as Response; }) as unknown as typeof fetch;
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn, onError });
    ph.track('bad', 'u1');
    await ph.flush();
    expect(calls.length).toBe(1); // no retry on client error
    expect(onError).toHaveBeenCalled();
  });

  it('requeues a fully-failed batch and resends it with the SAME batch_id (idempotent)', async () => {
    const bodies: any[] = [];
    let down = true;
    const fn = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return (down ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => ({}) }) as Response;
    }) as unknown as typeof fetch;
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
    ph.track('a.b', 'u1');
    await ph.flush();                       // 4 attempts, all 503 → requeued
    const firstId = bodies[0]!.batch_id;
    expect(bodies.length).toBe(4);
    expect(bodies.every((b) => b.batch_id === firstId)).toBe(true);
    down = false;
    await ph.flush();                       // drains retry → resent with the SAME id
    expect(bodies[bodies.length - 1]!.batch_id).toBe(firstId);
  });

  it('uses keepalive on shutdown-style flush', async () => {
    const { fn, calls } = fakeFetch();
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
    ph.track('a.b', 'u1');
    await ph.flush({ keepalive: true });
    expect(calls[0]!.keepalive).toBe(true);
  });

  it('still sends a keepalive (unload) flush while a periodic flush is in flight', async () => {
    // Regression: the unload keepalive flush must not be suppressed by an in-flight
    // periodic flush — that in-flight request is non-keepalive and dies on navigation.
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    const calls: Call[] = [];
    let n = 0;
    const fn = vi.fn(async (urlStr: string, init: RequestInit) => {
      n += 1;
      calls.push({ path: new URL(urlStr).pathname, body: JSON.parse(init.body as string), keepalive: (init as any).keepalive });
      if (n === 1) await firstDone; // first (periodic) flush hangs in-flight
      return { ok: true, status: 200, json: async () => ({ accepted: 1 }) } as Response;
    }) as unknown as typeof fetch;

    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
    ph.track('first.event', 'u1');
    const periodic = ph.flush();                          // grabs first.event, awaits the hung fetch
    await vi.waitFor(() => expect(calls.length).toBe(1)); // ensure it is in-flight
    ph.track('second.event', 'u1');                       // queued after the in-flight batch formed
    await ph.flush({ keepalive: true });                  // must NOT early-return

    const keepaliveCall = calls.find((c) => c.keepalive === true);
    expect(keepaliveCall).toBeTruthy();
    expect(keepaliveCall!.body.events.map((e: any) => e.event)).toContain('second.event');

    releaseFirst();
    await periodic;
  });

  it('evaluates a feature flag once per actor and key, then uses the cached variant', async () => {
    const calls: Call[] = [];
    const fn = vi.fn(async (urlStr: string, init: RequestInit) => {
      calls.push({ path: new URL(urlStr).pathname, body: JSON.parse(init.body as string), keepalive: (init as any).keepalive });
      return {
        ok: true,
        status: 200,
        json: async () => ({ key: 'checkout_copy', variant: { key: 'test', payload: { label: 'Pay now' } } }),
      } as Response;
    }) as unknown as typeof fetch;
    const ph = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });

    await expect(ph.getFeatureFlag('checkout_copy', 'u1', { sessionId: 's1' })).resolves.toEqual({
      key: 'test', payload: { label: 'Pay now' },
    });
    await expect(ph.getFeatureFlag('checkout_copy', 'u1', { sessionId: 'another-session' })).resolves.toEqual({
      key: 'test', payload: { label: 'Pay now' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: '/i/v1/flags/evaluate',
      body: { key: 'checkout_copy', distinct_id: 'u1', session_id: 's1' },
    });
  });
});
