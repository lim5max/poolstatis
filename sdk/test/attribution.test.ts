import { describe, expect, it } from 'vitest';
import { createAttributionClient, snapshotFromBrowser, type AttributionCaptureClient } from '../src/attribution.js';
import { createClient, type PoolstatisEvent } from '../src/index.js';

function fakeClient(): AttributionCaptureClient & { queued: PoolstatisEvent[]; flushed: number } {
  const result = {
    queued: [] as PoolstatisEvent[],
    flushed: 0,
    capture(event: PoolstatisEvent) { result.queued.push(event); },
    async flush() { result.flushed += 1; },
    discardQueuedEvents(predicate: (event: PoolstatisEvent) => boolean) {
      result.queued = result.queued.filter((event) => !predicate(event));
    },
  };
  return result;
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

describe('browser acquisition attribution', () => {
  it('captures one immutable tagged landing snapshot without raw URL data', async () => {
    const client = fakeClient();
    const browser = {
      location: { href: 'https://app.example/welcome?utm_source=%20News%20&utm_source=ignored&utm_campaign=Cafe%CC%81&unknown=secret#fragment' },
      document: { referrer: 'https://publisher.example/path?private=value' },
    };
    let actor = 'anon-7';
    const consent = consentController(true);
    const analytics = createAttributionClient({ client, browser, distinctId: () => actor, hasConsent: consent.has, subscribeConsent: consent.subscribe, route: () => 'welcome', createSessionId: () => 'session-1' });

    await analytics.start();
    browser.location.href = 'https://app.example/signup';
    actor = 'user-7';
    analytics.pageViewed({ $utm_source: 'spoofed' });
    analytics.track('signup.completed', { referrer_origin: 'https://spoofed.example', custom: 'kept' });

    expect(client.queued).toHaveLength(2);
    expect(client.queued.map((event) => event.event)).toEqual(['session.started', 'page.viewed']);
    expect(client.queued[0]).toMatchObject({
      distinct_id: 'anon-7', session_id: 'session-1',
      properties: { landing_route: 'welcome', referrer_origin: 'https://publisher.example', $utm_source: 'News', $utm_campaign: 'Café' },
    });

    await analytics.flush();
    expect(client.queued.slice(2)).toEqual([
      expect.objectContaining({ event: 'page.viewed', distinct_id: 'user-7', session_id: 'session-1', properties: expect.objectContaining({ $utm_source: 'News', landing_route: 'welcome' }) }),
      expect.objectContaining({ event: 'signup.completed', distinct_id: 'user-7', session_id: 'session-1', properties: expect.objectContaining({ custom: 'kept', referrer_origin: 'https://publisher.example', $utm_source: 'News' }) }),
    ]);
    expect(JSON.stringify(client.queued)).not.toContain('unknown=secret');
    expect(JSON.stringify(client.queued)).not.toContain('publisher.example/path');
  });

  it('keeps an untagged browser session isolated from a prior campaign', async () => {
    const tagged = snapshotFromBrowser({ location: { href: 'https://app.example/?utm_source=ads' }, document: { referrer: '' } }, 'one', 'home');
    const untagged = snapshotFromBrowser({ location: { href: 'https://app.example/pricing?unknown=ads' }, document: { referrer: '' } }, 'two', 'pricing');
    expect(tagged.$utm_source).toBe('ads');
    expect(untagged).toEqual({ session_id: 'two', landing_route: 'pricing' });
  });

  it('uses the same finite route-key grammar as Core', () => {
    const browser = { location: { href: 'https://app.example/' }, document: { referrer: '' } };
    expect(() => snapshotFromBrowser(browser, 'session', 'Checkout')).toThrow('finite safe route key');
    expect(() => snapshotFromBrowser(browser, 'session', '1checkout')).toThrow('finite safe route key');
    expect(() => snapshotFromBrowser(browser, 'session', 'checkout+secret')).toThrow('finite safe route key');
    expect(snapshotFromBrowser(browser, 'session', 'checkout.start').landing_route).toBe('checkout.start');
  });

  it('does not read browser values before consent and drops queued attribution on revocation', async () => {
    const client = fakeClient();
    const consent = consentController(false);
    let reads = 0;
    const browser = {
      location: { get href() { reads += 1; return 'https://app.example/?utm_source=ads'; } },
      document: { get referrer() { reads += 1; return 'https://publisher.example/private'; } },
    };
    const analytics = createAttributionClient({ client, browser, distinctId: 'anon', hasConsent: consent.has, subscribeConsent: consent.subscribe, route: 'home', createSessionId: () => 'session-2' });
    await analytics.start();
    expect(reads).toBe(0);
    expect(client.queued).toEqual([]);

    consent.set(true);
    await analytics.start();
    analytics.track('checkout.completed');
    consent.set(false);
    expect(analytics.sessionId).toBeNull();
    expect(client.queued).toEqual([]);
  });

  it('does not resolve global browser objects before consent', async () => {
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'location', { configurable: true, get: () => { throw new Error('location must not be read'); } });
    Object.defineProperty(globalThis, 'document', { configurable: true, get: () => { throw new Error('document must not be read'); } });
    try {
      const consent = consentController(false);
      const analytics = createAttributionClient({ client: fakeClient(), distinctId: 'anon', hasConsent: consent.has, subscribeConsent: consent.subscribe, route: 'home' });
      await analytics.start();
    } finally {
      if (location) Object.defineProperty(globalThis, 'location', location);
      else delete (globalThis as { location?: unknown }).location;
      if (document) Object.defineProperty(globalThis, 'document', document);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('removes a failed base-SDK retry as soon as the consent subscription revokes', async () => {
    const consent = consentController(true);
    let calls = 0;
    const client = createClient({
      url: 'https://analytics.example', ingestKey: 'pk_test', flushIntervalMs: 60_000,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response('{}', { status: 200 }); // consented start
        throw new Error('offline');
      },
    });
    const analytics = createAttributionClient({
      client, distinctId: 'anon', hasConsent: consent.has, subscribeConsent: consent.subscribe, route: 'home', createSessionId: () => 'retry-session',
      browser: { location: { href: 'https://app.example/?utm_source=ads' }, document: { referrer: '' } },
    });
    await analytics.start();
    analytics.track('signup.completed');
    await analytics.flush(); // the base SDK now holds the failed event as a retry batch
    const beforeRevocation = calls;
    consent.set(false);
    await client.flush();
    expect(calls).toBe(beforeRevocation);
    await client.shutdown();
  });

  it('keeps the base SDK free of browser location reads', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, get: () => { throw new Error('location must not be read'); } });
    try {
      const client = createClient({ url: 'https://analytics.example', ingestKey: 'pk_test', fetch: async () => new Response('{}', { status: 200 }) });
      void client.shutdown();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
      else delete (globalThis as { location?: unknown }).location;
    }
  });
});
