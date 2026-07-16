import { describe, expect, it } from 'vitest';
import { QueryCache } from '../src/services/queryCache.js';

describe('QueryCache', () => {
  it('coalesces concurrent identical reads', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new QueryCache({ ttlMs: 1_000, maxEntries: 10 });
    const load = async () => { calls += 1; await gate; return { value: 1 }; };

    const reads = [
      cache.getOrLoad('p1', 'trend', load),
      cache.getOrLoad('p1', 'trend', load),
    ];
    release();

    await expect(Promise.all(reads)).resolves.toEqual([{ value: 1 }, { value: 1 }]);
    expect(calls).toBe(1);
  });

  it('expires values, evicts the oldest entry, and never caches failures', async () => {
    let now = 1_000;
    const cache = new QueryCache({ ttlMs: 100, maxEntries: 1, now: () => now });
    const calls = new Map<string, number>();
    const load = async (key: string) => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return key;
    };

    await cache.getOrLoad('p1', 'a', () => load('a'));
    await cache.getOrLoad('p1', 'a', () => load('a'));
    expect(calls.get('a')).toBe(1);

    await cache.getOrLoad('p1', 'b', () => load('b'));
    await cache.getOrLoad('p1', 'a', () => load('a'));
    expect(calls.get('a')).toBe(2);

    now += 101;
    await cache.getOrLoad('p1', 'a', () => load('a'));
    expect(calls.get('a')).toBe(3);

    await expect(cache.getOrLoad('p1', 'failure', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    await expect(cache.getOrLoad('p1', 'failure', async () => 'recovered')).resolves.toBe('recovered');
  });

  it('invalidates only the written project', async () => {
    const cache = new QueryCache({ ttlMs: 1_000, maxEntries: 10 });
    let p1Calls = 0;
    let p2Calls = 0;
    const p1 = () => cache.getOrLoad('p1', 'trend', async () => ++p1Calls);
    const p2 = () => cache.getOrLoad('p2', 'trend', async () => ++p2Calls);

    await p1();
    await p2();
    cache.invalidateProject('p1');

    await expect(p1()).resolves.toBe(2);
    await expect(p2()).resolves.toBe(1);
  });
});
