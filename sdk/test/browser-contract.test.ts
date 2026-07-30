import { describe, expect, it } from 'vitest';
import {
  clearBrowserAnalyticsIdentity,
  createBrowserAnalytics,
  type BrowserCaptureClient,
} from '../src/browser.js';
import { snapshotFromBrowser } from '../src/attribution.js';
import type { PoolstatisEvent } from '../src/index.js';

function storage(onRead?: () => void) {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { onRead?.(); return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

function fixture() {
  let now = 1_000;
  let consent = false;
  let gpc = false;
  let path = '/customer/secret';
  let heartbeat: (() => void) | undefined;
  const queued: PoolstatisEvent[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  const consentListeners = new Set<() => void>();
  const localStorage = storage();
  const sessionStorage = storage();
  const client: BrowserCaptureClient = {
    capture: (event) => queued.push(event),
    discardQueuedEvents: (predicate) => {
      for (let index = queued.length - 1; index >= 0; index -= 1) {
        if (predicate(queued[index]!)) queued.splice(index, 1);
      }
    },
    flush: async () => {},
  };
  const browser = {
    location: {
      get pathname() { return path; },
      get href() { return `https://example.test${path}?utm_source=search&token=secret`; },
    },
    document: {
      referrer: 'https://referrer.test/private?secret=1',
      visibilityState: 'visible' as const,
      hasFocus: () => true,
      documentElement: { scrollHeight: 1_000 },
      body: { scrollHeight: 1_000 },
      addEventListener(type: string, listener: () => void) {
        const set = documentListeners.get(type) ?? new Set();
        set.add(listener);
        documentListeners.set(type, set);
      },
      removeEventListener(type: string, listener: () => void) {
        documentListeners.get(type)?.delete(listener);
      },
    },
    history: {
      pushState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) path = new URL(String(url), 'https://example.test').pathname;
      },
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) path = new URL(String(url), 'https://example.test').pathname;
      },
    },
    navigator: {
      userAgent: 'Mozilla/5.0 Chrome/120.0',
      language: 'en-US',
      get globalPrivacyControl() { return gpc; },
    },
    screen: { width: 1440, height: 900 },
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    localStorage,
    sessionStorage,
    setInterval(listener: () => void) { heartbeat = listener; return 1; },
    clearInterval() { heartbeat = undefined; },
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    browser,
    client,
    queued,
    hasConsent: () => consent,
    subscribeConsent: (listener: () => void) => {
      consentListeners.add(listener);
      return () => consentListeners.delete(listener);
    },
    setConsent(value: boolean) {
      consent = value;
      consentListeners.forEach((listener) => listener());
    },
    setGpc(value: boolean) { gpc = value; },
    now: () => now,
    advance(ms: number) { now += ms; },
    heartbeat() { heartbeat?.(); },
    pagehide() { listeners.get('pagehide')?.forEach((listener) => listener()); },
  };
}

describe('@poolstatis/sdk/browser contract', () => {
  it('does not read storage before opt-in and clears on withdrawal', () => {
    let reads = 0;
    const f = fixture();
    f.browser.localStorage = storage(() => { reads += 1; });
    f.browser.sessionStorage = storage(() => { reads += 1; });
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      hasConsent: f.hasConsent,
      subscribeConsent: f.subscribeConsent,
      mapPagePath: () => 'account',
      createId: () => 'id',
    });
    analytics.start();
    expect(reads).toBe(0);
    f.setConsent(true);
    expect(reads).toBeGreaterThan(0);
    expect(f.queued).toHaveLength(1);
    f.setConsent(false);
    expect(f.queued).toEqual([]);
    expect(analytics.visitorId).toBeNull();
  });

  it('honors GPC for opt-in, opt-out and external modes', () => {
    for (const consentPolicy of ['opt-in', 'opt-out', 'external'] as const) {
      const f = fixture();
      f.setConsent(true);
      f.setGpc(true);
      const analytics = createBrowserAnalytics({
        client: f.client,
        browser: f.browser,
        consentPolicy,
        hasConsent: f.hasConsent,
        subscribeConsent: f.subscribeConsent,
        mapPagePath: () => 'home',
      });
      analytics.start();
      expect(f.queued).toEqual([]);
    }
  });

  it('requires a finite safe route key and keeps product events neutral', () => {
    const f = fixture();
    f.setConsent(true);
    expect(() => createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      hasConsent: f.hasConsent,
      subscribeConsent: f.subscribeConsent,
    })).toThrow('mapPagePath');

    const neutral: PoolstatisEvent[] = [];
    const analytics = createBrowserAnalytics({
      client: f.client,
      neutralClient: {
        capture: (event) => neutral.push(event),
        discardQueuedEvents: () => {},
      },
      browser: f.browser,
      hasConsent: f.hasConsent,
      subscribeConsent: f.subscribeConsent,
      mapPagePath: () => 'account',
      createId: () => 'safe',
    });
    analytics.start();
    analytics.track('checkout.completed', { plan: 'pro' });
    expect(neutral[0]).toMatchObject({
      event: 'checkout.completed',
      properties: { plan: 'pro' },
    });
    expect(neutral[0]?.properties).not.toHaveProperty('$browser_context');
    expect(JSON.stringify(f.queued)).not.toContain('/customer/secret');
    expect(f.queued[0]?.properties).toMatchObject({ $route_key: 'account' });
  });

  it('drops URL-shaped attribution values instead of storing query payloads', () => {
    const snapshot = snapshotFromBrowser({
      location: {
        href: 'https://example.test/?utm_source=https%3A%2F%2Ftracker.test%2Fpath%3Ftoken%3Dsecret&utm_medium=paid-search',
      },
      document: { referrer: '' },
    }, 'session', 'home');
    expect(snapshot).not.toHaveProperty('$utm_source');
    expect(snapshot.$utm_medium).toBe('paid-search');
  });

  it('uses monotonic foreground time and keepalive terminal flush', async () => {
    const f = fixture();
    f.setConsent(true);
    const flushes: boolean[] = [];
    f.client.flush = async (options) => { flushes.push(options?.keepalive === true); };
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      now: f.now,
      monotonicNow: f.now,
      hasConsent: f.hasConsent,
      subscribeConsent: f.subscribeConsent,
      mapPagePath: () => 'home',
      createId: () => 'engagement',
    });
    analytics.start();
    f.advance(10_000);
    f.heartbeat();
    f.advance(2_000);
    f.pagehide();
    await Promise.resolve();
    expect(f.queued.filter((event) => event.event === 'page.engagement').at(-1)?.properties)
      .toMatchObject({ foreground_ms: 12_000, reason: 'pagehide' });
    expect(flushes).toContain(true);
  });

  it('rotates visitor and session identity on account switch', () => {
    const f = fixture();
    f.setConsent(true);
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      hasConsent: f.hasConsent,
      subscribeConsent: f.subscribeConsent,
      mapPagePath: () => 'home',
      createId: () => `id-${++id}`,
    });
    analytics.start();
    const firstVisitor = analytics.visitorId;
    const firstSession = analytics.sessionId;
    analytics.identify('user-one');
    analytics.resetIdentity();
    expect(analytics.visitorId).not.toBe(firstVisitor);
    expect(analytics.sessionId).not.toBe(firstSession);
  });

  it('fails closed when storage keeps stale identity during account reset', () => {
    const f = fixture();
    f.setConsent(true);
    const localValues = new Map<string, string>();
    const sessionValues = new Map<string, string>();
    f.browser.localStorage = {
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: () => {},
    };
    f.browser.sessionStorage = {
      getItem: (key) => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: () => {},
    };
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      hasConsent: f.hasConsent,
      subscribeConsent: f.subscribeConsent,
      mapPagePath: () => 'home',
      createId: (() => {
        let id = 0;
        return () => `stale-${++id}`;
      })(),
    });
    analytics.start();
    expect(() => analytics.resetIdentity()).toThrow('stale visitor');
  });

  it('is SSR import safe', async () => {
    await expect(import('../src/browser.js')).resolves.toBeTruthy();
    expect(() => clearBrowserAnalyticsIdentity()).not.toThrow();
  });
});
