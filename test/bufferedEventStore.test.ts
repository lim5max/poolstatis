import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import { BufferedEventStore } from '../src/stores/bufferedEventStore.js';
import type { EventStore, StorableEvent } from '../src/stores/eventStore.js';

interface FakeEventStore extends EventStore {
  appends: StorableEvent[][];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BufferedEventStore', () => {
  it('coalesces concurrent appends into one delegate append', async () => {
    vi.useFakeTimers();
    const delegate = fakeEventStore();
    const store = new BufferedEventStore(delegate, {
      maxEvents: 10,
      maxDelayMs: 5,
      maxPendingEvents: 100,
    });

    const writes = Promise.all([
      store.append([event('a')]),
      store.append([event('b')]),
    ]);
    await vi.advanceTimersByTimeAsync(5);
    await writes;

    expect(delegate.appends).toHaveLength(1);
    expect(delegate.appends[0]?.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('flushes immediately once maxEvents is reached', async () => {
    const delegate = fakeEventStore();
    const store = new BufferedEventStore(delegate, {
      maxEvents: 2,
      maxDelayMs: 10_000,
      maxPendingEvents: 100,
    });

    await Promise.all([
      store.append([event('a')]),
      store.append([event('b')]),
    ]);

    expect(delegate.appends).toHaveLength(1);
    expect(delegate.appends[0]).toHaveLength(2);
  });

  it('rejects new appends with 503 when the pending queue is full', async () => {
    vi.useFakeTimers();
    const delegate = fakeEventStore();
    const store = new BufferedEventStore(delegate, {
      maxEvents: 2,
      maxDelayMs: 10_000,
      maxPendingEvents: 2,
    });

    const first = store.append([event('a')]);
    await expect(store.append([event('b'), event('c')])).rejects.toMatchObject({
      statusCode: 503,
      code: 'ingest_backpressure',
    } satisfies Partial<ApiError>);

    await vi.advanceTimersByTimeAsync(10_000);
    await first;
  });

  it('propagates delegate append failures to every caller in the flushed batch', async () => {
    vi.useFakeTimers();
    const delegate = fakeEventStore({ fail: new Error('database down') });
    const store = new BufferedEventStore(delegate, {
      maxEvents: 10,
      maxDelayMs: 1,
      maxPendingEvents: 100,
    });

    const writes = Promise.all([
      store.append([event('a')]),
      store.append([event('b')]),
    ]);
    const assertion = expect(writes).rejects.toThrow('database down');
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
  });

  it('never exceeds the physical maxEvents batch while a flush is in flight', async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const delegate = fakeEventStore();
    const originalAppend = delegate.append.bind(delegate);
    let calls = 0;
    delegate.append = async (events) => {
      const result = await originalAppend(events);
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await firstGate;
      }
      return result;
    };
    const store = new BufferedEventStore(delegate, {
      maxEvents: 2,
      maxDelayMs: 10_000,
      maxPendingEvents: 20,
    });

    const first = Promise.all([store.append([event('a')]), store.append([event('b')])]);
    await started;
    const following = Promise.all('cdefghij'.split('').map((name) => store.append([event(name)])));
    releaseFirst();
    await Promise.all([first, following]);

    expect(delegate.appends.map((batch) => batch.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it('counts the in-flight batch toward maxPendingEvents backpressure', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const delegate = fakeEventStore();
    delegate.append = async (events) => {
      delegate.appends.push(events);
      started();
      await gate;
      return { inserted: events.length };
    };
    const store = new BufferedEventStore(delegate, {
      maxEvents: 2,
      maxDelayMs: 10_000,
      maxPendingEvents: 2,
    });

    const inFlight = Promise.all([store.append([event('a')]), store.append([event('b')])]);
    await firstStarted;
    const rejection = Promise.race([
      store.append([event('c')]).then(() => null, (error: unknown) => error),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    const error = await rejection;
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'ingest_backpressure',
    } satisfies Partial<ApiError>);
    release();
    await inFlight;
  });

  it('bounds idempotent appends before they can queue on the database pool', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    let twoStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { twoStarted = resolve; });
    const delegate = fakeEventStore();
    delegate.appendIdempotent = async (batch) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) twoStarted();
      await gate;
      active -= 1;
      return { inserted: batch.events.length };
    };
    const store = new BufferedEventStore(delegate, {
      maxEvents: 2,
      maxDelayMs: 10,
      maxPendingEvents: 3,
      maxConcurrentIdempotentAppends: 2,
    });

    const first = store.appendIdempotent(idempotent('batch-1', 'a'));
    const second = store.appendIdempotent(idempotent('batch-2', 'b'));
    await started;
    const queued = store.appendIdempotent(idempotent('batch-3', 'c'));
    await expect(store.appendIdempotent(idempotent('batch-4', 'd'))).rejects.toMatchObject({
      statusCode: 503,
      code: 'ingest_backpressure',
    } satisfies Partial<ApiError>);

    release();
    await expect(Promise.all([first, second, queued])).resolves.toEqual([
      { inserted: 1 }, { inserted: 1 }, { inserted: 1 },
    ]);
    expect(peak).toBe(2);
  });

  it('charges invalid-only idempotent batches at least one queue slot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delegate = fakeEventStore();
    delegate.appendIdempotent = async (batch) => { await gate; return { inserted: batch.events.length }; };
    const store = new BufferedEventStore(delegate, {
      maxEvents: 2,
      maxDelayMs: 10,
      maxPendingEvents: 2,
      maxConcurrentIdempotentAppends: 1,
    });
    const empty = (batchId: string) => ({ ...idempotent(batchId, 'unused'), events: [] });

    const first = store.appendIdempotent(empty('empty-1'));
    const second = store.appendIdempotent(empty('empty-2'));
    await expect(store.appendIdempotent(empty('empty-3'))).rejects.toMatchObject({
      statusCode: 503,
      code: 'ingest_backpressure',
    } satisfies Partial<ApiError>);

    release();
    await Promise.all([first, second]);
  });
});

function fakeEventStore(options: { fail?: Error } = {}): FakeEventStore {
  const appends: StorableEvent[][] = [];
  return {
    appends,
    append: async (events: StorableEvent[]) => {
      appends.push(events);
      if (options.fail) throw options.fail;
      return { inserted: events.length };
    },
    trend: vi.fn(),
    funnel: vi.fn(),
    retention: vi.fn(),
    lifecycle: vi.fn(),
    stickiness: vi.fn(),
    sample: vi.fn(),
    eventNames: vi.fn(),
    eventStats: vi.fn(),
    entityStatusEvidence: vi.fn(),
    purge: vi.fn(),
    actorSummary: vi.fn(),
  } as unknown as FakeEventStore;
}

function event(name: string): StorableEvent {
  return {
    projectId: '00000000-0000-0000-0000-000000000001',
    env: 'prod',
    event: name,
    timestamp: new Date('2026-06-26T00:00:00.000Z'),
    distinctId: 'u1',
    sessionId: null,
    properties: {},
    registered: true,
  };
}

function idempotent(batchId: string, name: string) {
  return {
    dedupe: 'ingest_24h' as const,
    projectId: '00000000-0000-0000-0000-000000000001',
    env: 'prod',
    batchId,
    events: [event(name)],
  };
}
