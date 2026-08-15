import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ReplayRecorder, type ReplayBrowser, type ReplayRecord } from '../src/replay.js';
import { sanitizeRecordedEvent } from '../src/replayPrivacy.js';

function browser(): ReplayBrowser {
  return {
    location: { hostname: 'app.example.test' },
    innerWidth: 1280,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    crypto: globalThis.crypto,
  };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const policy = { version: 'privacy-v1', text: 'masked' as const, maskSelectors: [], blockSelectors: [] };

function options(fetchImpl: typeof fetch, record: ReplayRecord, extra: Record<string, unknown> = {}) {
  return {
    url: 'https://api.example.test', ingestKey: 'pk_safe', surface: 'workspace', route: 'workspace',
    distinctId: 'actor-1', consent: { granted: true, version: 'consent-v1' }, policy,
    allowedHosts: ['app.example.test'], fetch: fetchImpl, record, browser: browser(), ...extra,
  };
}

describe('ReplayRecorder', () => {
  it('exposes replay only through the versioned opt-in package contract', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.version).toBe('0.4.0');
    expect(packageJson.exports['./replay']).toEqual({
      types: './dist/replay.d.ts',
      import: './dist/replay.js',
    });
    expect(packageJson.peerDependencies['@rrweb/record']).toBe('2.1.1');
    expect(packageJson.peerDependenciesMeta['@rrweb/record']).toEqual({ optional: true });
  });

  it('fails closed before recorder/network when consent or host policy is absent', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const record = vi.fn() as ReplayRecord;
    const denied = new ReplayRecorder(options(fetchImpl, record, { consent: { granted: false, version: 'consent-v1' } }));
    await expect(denied.start()).rejects.toThrow('affirmative');
    const wrongHost = new ReplayRecorder(options(fetchImpl, record, { allowedHosts: ['other.example.test'] }));
    await expect(wrongHost.start()).rejects.toThrow('host policy');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('masks attributes, inputs, raw URLs and secret-looking strings client-side', () => {
    const safe = sanitizeRecordedEvent({
      type: 2, timestamp: 1, data: { node: {
        type: 2, tagName: 'input', attributes: {
          value: 'alice@example.com', 'aria-label': 'Alice', title: 'Bearer abcdefghijklmnop',
          'data-user': 'alice@example.com', src: 'https://evil.test/x', id: 'alice@example.com',
        }, childNodes: [{ type: 3, textContent: 'Private text' }],
      } },
    }, policy, 'workspace');
    const serialized = JSON.stringify(safe);
    for (const value of ['alice@example.com', 'Private text', 'Bearer abcdefghijklmnop', 'evil.test', 'data-user']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('masks unknown rrweb strings by default and sanitizes style text in visible mode', () => {
    const masked = sanitizeRecordedEvent({
      type: 3,
      timestamp: 1,
      data: { source: 0, arbitraryFutureField: 'Alice private workspace', nested: { vendor: 'customer-secret' } },
    }, policy, 'workspace');
    const maskedJson = JSON.stringify(masked);
    expect(maskedJson).not.toContain('Alice private workspace');
    expect(maskedJson).not.toContain('customer-secret');

    const visiblePolicy = { ...policy, text: 'visible' as const };
    const visible = sanitizeRecordedEvent({
      type: 2,
      timestamp: 2,
      data: { node: { type: 0, childNodes: [{
        type: 2,
        tagName: 'body',
        attributes: {},
        childNodes: [
          {
            type: 2,
            tagName: 'style',
            attributes: {},
            childNodes: [{
              type: 3,
              textContent: '@import "//evil.test/private.css"; .private-panel { height:48rem; overflow-y:auto; background-image:url(https://evil.test/pixel); content:"alice@example.test" }',
            }],
          },
          {
            type: 2,
            tagName: 'div',
            attributes: { CONTENTEDITABLE: true },
            childNodes: [{ type: 3, textContent: 'Editable Alice Secret' }],
          },
          { type: 2, tagName: 'p', attributes: {}, childNodes: [{ type: 3, textContent: 'Visible public label' }] },
        ],
      }] } },
    }, visiblePolicy, 'workspace');
    const input = sanitizeRecordedEvent({
      type: 3, timestamp: 3, data: { source: 5, id: 4, text: 'Typed Alice Secret', isChecked: false },
    }, visiblePolicy, 'workspace');
    const visibleJson = JSON.stringify([visible, input]);
    expect(visibleJson).toContain('height:48rem;overflow-y:auto');
    expect(visibleJson).toContain('Visible public label');
    for (const forbidden of [
      'evil.test', 'background-image', 'content:', 'alice@example.test',
      'Editable Alice Secret', 'Typed Alice Secret', '@import',
    ]) expect(visibleJson).not.toContain(forbidden);
  });

  it('keeps bounded layout CSS aligned with tokenized selectors across repeated passes', () => {
    const event = {
      type: 2, timestamp: 1, data: { node: { type: 2, tagName: 'main', attributes: {
        id: 'alice-private-panel', class: 'scroll-content',
        _cssText: '@import "https://evil.test/x"; #alice-private-panel .scroll-content { height:48rem; overflow-y:auto; background-image:url(https://evil.test/pixel); content:"alice@example.test"; --private-size:12rem; width:var(--private-size) }',
      }, childNodes: [] } },
    };
    const once = sanitizeRecordedEvent(event, policy, 'workspace');
    const twice = sanitizeRecordedEvent(once, policy, 'workspace');
    expect(twice).toEqual(once);
    const serialized = JSON.stringify(once);
    const id = serialized.match(/"id":"(rr-[0-9a-f]{8})"/)?.[1];
    const className = serialized.match(/"class":"(rr-[0-9a-f]{8})"/)?.[1];
    expect(serialized).toContain(`#${id} .${className}{height:48rem;overflow-y:auto;--rr-`);
    expect(serialized).toContain('width:var(--rr-');
    for (const forbidden of ['alice-private-panel', 'scroll-content', 'alice@example.test', 'evil.test', 'background-image', 'content:']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('sanitizes rrweb CSS mutations and enforces explicit selectors client-side', () => {
    const visiblePolicy = {
      ...policy,
      text: 'visible' as const,
      blockSelectors: ['.private-block'],
      maskSelectors: ['[data-mask-me]'],
    };
    const events = [{
      type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [{
        type: 2, tagName: 'body', attributes: {}, childNodes: [
          { type: 2, tagName: 'section', attributes: { class: 'private-block' }, childNodes: [{ type: 3, textContent: 'Blocked Alice Secret' }] },
          { type: 2, tagName: 'p', attributes: { 'data-mask-me': '' }, childNodes: [{ type: 3, textContent: 'Masked Alice Secret' }] },
          { type: 2, tagName: 'p', attributes: {}, childNodes: [{ type: 3, textContent: 'Visible public label' }] },
        ],
      }] } },
    }, {
      type: 3, timestamp: 2, data: {
        source: 8,
        replace: '@import "//evil.test/x"; .private-panel { height:48rem; background-image:url(https://evil.test/pixel) }',
      },
    }, {
      type: 3, timestamp: 3, data: {
        source: 13, id: 2, index: [0], set: { property: 'height', value: '32rem', priority: 'important' },
      },
    }];
    const serialized = JSON.stringify(events.map((event) => sanitizeRecordedEvent(event, visiblePolicy, 'workspace')));
    expect(serialized).toContain('height:48rem');
    expect(serialized).toContain('"property":"height","value":"32rem","priority":"important"');
    expect(serialized).toContain('Visible public label');
    for (const forbidden of [
      'evil.test', '@import', 'background-image', 'Blocked Alice Secret', 'Masked Alice Secret',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('serializes flush and stop so two drains cannot shift away the next chunk', async () => {
    let emit: ((event: any) => void) | null = null;
    const record: ReplayRecord = (config) => {
      emit = config.emit as (event: any) => void;
      return () => {};
    };
    let releaseFirst!: () => void;
    const firstPut = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requests: Array<{ url: string; body: any }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      requests.push({ url: String(url), body });
      if (String(url).endsWith('/i/v1/replays')) {
        return response(201, { replay: { id: '11111111-1111-1111-1111-111111111111' }, upload_token: 'rt_'.padEnd(70, 'a') });
      }
      if (String(url).endsWith('/chunks') && body.sequence === 0) await firstPut;
      return response(200, { accepted: true });
    }) as unknown as typeof fetch;
    const recorder = new ReplayRecorder(options(fetchImpl, record));
    await recorder.start();
    emit!({ type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [] } } });
    const flushing = recorder.flush();
    await vi.waitFor(() => expect(requests.some((request) => request.body.sequence === 0)).toBe(true));
    emit!({ type: 3, timestamp: 2, data: { source: 1, positions: [{ x: 1, y: 1, id: 1, timeOffset: 0 }] } });
    const stopping = recorder.stop();
    releaseFirst();
    await Promise.all([flushing, stopping]);
    const sequences = requests.filter((request) => request.url.endsWith('/chunks')).map((request) => request.body.sequence);
    expect(sequences).toEqual([0, 1]);
  });

  it('rolls back failed initialization and can start again', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith('/i/v1/replays')) {
        return response(201, { replay: { id: '22222222-2222-2222-2222-222222222222' }, upload_token: 'rt_'.padEnd(70, 'b') });
      }
      return response(200, { deleted: true });
    }) as unknown as typeof fetch;
    let attempts = 0;
    const record: ReplayRecord = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('recorder init failed');
      return () => {};
    };
    const recorder = new ReplayRecorder(options(fetchImpl, record));
    await expect(recorder.start()).rejects.toThrow('init failed');
    expect(calls.some((url) => url.endsWith('/22222222-2222-2222-2222-222222222222'))).toBe(true);
    await expect(recorder.start()).resolves.toMatchObject({ sampled: true, replayId: expect.any(String) });
    expect(attempts).toBe(2);
    await recorder.withdraw();
  });

  it('can retry finalization after all bounded complete attempts fail transiently', async () => {
    let emit: ((event: any) => void) | null = null;
    const record: ReplayRecord = (config) => {
      emit = config.emit as (event: any) => void;
      return () => {};
    };
    let completeCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/i/v1/replays')) {
        return response(201, { replay: { id: '77777777-7777-7777-7777-777777777777' }, upload_token: 'rt_'.padEnd(70, 'g') });
      }
      if (String(url).endsWith('/complete')) {
        completeCalls += 1;
        return completeCalls <= 4
          ? response(503, { error: { message: 'temporary complete outage', retryable: true } })
          : response(200, { status: 'playable' });
      }
      return response(200, { accepted: true });
    }) as unknown as typeof fetch;
    const recorder = new ReplayRecorder(options(fetchImpl, record));
    await recorder.start();
    emit!({ type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [] } } });
    await expect(recorder.stop()).rejects.toThrow('temporary complete outage');
    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(completeCalls).toBe(5);
  });

  it('withdraws a manifest created while start is still in flight without starting rrweb', async () => {
    let resolveCreate!: () => void;
    const createPending = new Promise<void>((resolve) => { resolveCreate = resolve; });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith('/i/v1/replays')) {
        await createPending;
        return response(201, { replay: { id: '66666666-6666-6666-6666-666666666666' }, upload_token: 'rt_'.padEnd(70, 'f') });
      }
      return response(200, { deleted: true });
    }) as unknown as typeof fetch;
    const record = vi.fn(() => () => {}) as ReplayRecord;
    const recorder = new ReplayRecorder(options(fetchImpl, record));
    const starting = recorder.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const withdrawing = recorder.withdraw();
    resolveCreate();
    await expect(starting).rejects.toThrow('consent was withdrawn');
    await withdrawing;
    expect(record).not.toHaveBeenCalled();
    expect(calls.some((url) => url.endsWith('/66666666-6666-6666-6666-666666666666'))).toBe(true);
    await expect(recorder.start()).rejects.toThrow('consent was withdrawn');
  });

  it('retains an in-flight manifest withdrawal after bounded transport failure', async () => {
    let resolveCreate!: () => void;
    const createPending = new Promise<void>((resolve) => { resolveCreate = resolve; });
    let deleteCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/i/v1/replays')) {
        await createPending;
        return response(201, {
          replay: { id: '88888888-8888-8888-8888-888888888888' },
          upload_token: 'rt_'.padEnd(70, 'h'),
        });
      }
      deleteCalls += 1;
      return deleteCalls <= 4
        ? response(503, { error: { message: 'temporary withdrawal outage', retryable: true } })
        : response(200, { deleted: true });
    }) as unknown as typeof fetch;
    const record = vi.fn(() => () => {}) as ReplayRecord;
    const recorder = new ReplayRecorder(options(fetchImpl, record));
    const starting = recorder.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const firstWithdrawal = recorder.withdraw();
    resolveCreate();
    await expect(starting).rejects.toThrow('consent was withdrawn');
    await expect(firstWithdrawal).rejects.toThrow('temporary withdrawal outage');
    expect(deleteCalls).toBe(4);
    await expect(recorder.withdraw()).resolves.toBeUndefined();
    expect(deleteCalls).toBe(5);
    expect(record).not.toHaveBeenCalled();
  }, 10_000);

  it('uses keepalive only for one bounded pagehide chunk and leaves completion explicit', async () => {
    let emit: ((event: any) => void) | null = null;
    let pagehide: (() => void) | null = null;
    const replayBrowser = browser();
    replayBrowser.addEventListener = vi.fn((type, listener) => { if (type === 'pagehide') pagehide = listener; });
    const record: ReplayRecord = (config) => { emit = config.emit as (event: any) => void; return () => {}; };
    const requests: Array<RequestInit> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return String(url).endsWith('/i/v1/replays')
        ? response(201, { replay: { id: '33333333-3333-3333-3333-333333333333' }, upload_token: 'rt_'.padEnd(70, 'c') })
        : response(200, { accepted: true });
    }) as unknown as typeof fetch;
    const recorder = new ReplayRecorder(options(fetchImpl, record, { browser: replayBrowser }));
    await recorder.start();
    emit!({ type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [] } } });
    pagehide!();
    await vi.waitFor(() => expect(requests.some((request) => request.keepalive === true)).toBe(true));
    expect(requests.filter((request) => String(request.body).includes('last_sequence'))).toHaveLength(0);
    await recorder.withdraw();
  });

  it('does not misreport an oversized pagehide chunk as delivered', async () => {
    let emit: ((event: any) => void) | null = null;
    let pagehide: (() => void) | null = null;
    const replayBrowser = browser();
    replayBrowser.addEventListener = vi.fn((type, listener) => { if (type === 'pagehide') pagehide = listener; });
    const record: ReplayRecord = (config) => { emit = config.emit as (event: any) => void; return () => {}; };
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return String(url).endsWith('/i/v1/replays')
        ? response(201, { replay: { id: '55555555-5555-5555-5555-555555555555' }, upload_token: 'rt_'.padEnd(70, 'e') })
        : response(200, { accepted: true });
    }) as unknown as typeof fetch;
    const recorder = new ReplayRecorder(options(fetchImpl, record, { browser: replayBrowser }));
    await recorder.start();
    emit!({ type: 2, timestamp: 1, data: { node: { type: 3, textContent: 'x'.repeat(80_000), id: 1 } } });
    pagehide!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.filter((request) => request.url.endsWith('/chunks'))).toHaveLength(0);
    expect(requests.some((request) => request.init.keepalive === true)).toBe(false);
    await recorder.stop();
    expect(requests.filter((request) => request.url.endsWith('/chunks'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/complete'))).toHaveLength(1);
  });

  it('preserves sequence gaps when the bounded memory queue drops old chunks', async () => {
    let emit: ((event: any) => void) | null = null;
    const record: ReplayRecord = (config) => { emit = config.emit as (event: any) => void; return () => {}; };
    const uploaded: number[] = [];
    let completedLast: number | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/i/v1/replays')) {
        return response(201, { replay: { id: '44444444-4444-4444-4444-444444444444' }, upload_token: 'rt_'.padEnd(70, 'd') });
      }
      if (String(url).endsWith('/chunks')) uploaded.push(body.sequence);
      if (String(url).endsWith('/complete')) completedLast = body.last_sequence;
      return response(200, { accepted: true });
    }) as unknown as typeof fetch;
    const recorder = new ReplayRecorder(options(fetchImpl, record));
    await recorder.start();
    for (let index = 0; index < 120; index += 1) {
      emit!({
        type: index === 0 ? 2 : 3,
        timestamp: index + 1,
        data: index === 0
          ? { node: { type: 3, textContent: 'x'.repeat(80_000), id: 1 } }
          : { source: 0, texts: [{ id: 1, value: 'x'.repeat(80_000) }], adds: [], removes: [], attributes: [] },
      });
    }
    await recorder.stop();
    expect(uploaded[0]).toBeGreaterThan(0);
    expect(completedLast).toBe(uploaded.at(-1));
    expect(uploaded).not.toContain(0);
  });
});
