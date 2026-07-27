import { describe, expect, it } from 'vitest';
import { createBrowserAnalytics, type BrowserCaptureClient } from '../src/browser.js';
import type { PoolstatisEvent } from '../src/index.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function consent(initial: boolean) {
  let granted = initial;
  const listeners = new Set<() => void>();
  return {
    hasConsent: () => granted,
    subscribeConsent: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    set(value: boolean) { granted = value; listeners.forEach((listener) => listener()); },
  };
}

function fixture(now = 1_000, shared?: { localStorage: ReturnType<typeof storage>; sessionStorage: ReturnType<typeof storage> }) {
  const queued: PoolstatisEvent[] = [];
  const client: BrowserCaptureClient = {
    capture: (event) => queued.push(event),
    discardQueuedEvents: (predicate) => {
      for (let index = queued.length - 1; index >= 0; index -= 1) {
        if (predicate(queued[index]!)) queued.splice(index, 1);
      }
    },
  };
  const localStorage = shared?.localStorage ?? storage();
  const sessionStorage = shared?.sessionStorage ?? storage();
  const listeners = new Map<string, Set<() => void>>();
  let pathname = '/welcome';
  const browser = {
    location: { get pathname() { return pathname; } },
    history: {
      pushState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) pathname = new URL(String(url), 'https://example.test').pathname;
      },
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) pathname = new URL(String(url), 'https://example.test').pathname;
      },
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      language: 'en-US',
    },
    screen: { width: 390, height: 844 },
    innerWidth: 390,
    innerHeight: 760,
    localStorage,
    sessionStorage,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener); listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
  };
  return { client, queued, browser, localStorage, sessionStorage, setPath: (value: string) => { pathname = value; }, now: () => now };
}

describe('@poolstatis/sdk/browser', () => {
  it('waits for consent, persists one visitor, rotates inactive sessions, and tracks SPA paths only', () => {
    const c = consent(false);
    const first = fixture();
    const analytics = createBrowserAnalytics({
      client: first.client, browser: first.browser, now: first.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: (() => { let id = 0; return () => `id-${++id}`; })(),
    });
    analytics.start();
    expect(first.queued).toEqual([]);
    c.set(true);
    expect(first.queued).toHaveLength(1);
    expect(first.queued[0]).toMatchObject({
      event: 'page.viewed', distinct_id: 'visitor:id-1', session_id: 'session:id-2',
      properties: {
        $page_path: '/welcome', $device_class: 'mobile', $browser_family: 'safari',
        $os_family: 'ios', $language: 'en', $viewport_bucket: 'xs', $screen_bucket: 'xs',
      },
    });
    expect(JSON.stringify(first.queued)).not.toContain('Mozilla');

    first.browser.history.pushState({}, '', '/pricing?secret=1');
    expect(first.queued.at(-1)?.properties?.$page_path).toBe('/pricing');
    expect(JSON.stringify(first.queued)).not.toContain('secret');

    const link = analytics.identify('user-42');
    expect(link).toEqual({ source_distinct_id: 'visitor:id-1', target_distinct_id: 'user-42' });
    analytics.track('signup.completed');
    expect(first.queued.at(-1)).toMatchObject({ distinct_id: 'user-42', session_id: 'session:id-2' });
  });

  it('rejects reserved collisions and synchronously clears queued browser data and identifiers on revoke', () => {
    const c = consent(true);
    const f = fixture();
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => 'stable',
    });
    analytics.start();
    expect(() => analytics.track('checkout.completed', { $country: 'US' })).toThrow('reserved');
    c.set(false);
    expect(f.queued).toEqual([]);
    expect(f.localStorage.getItem('poolstatis.browser.visitor')).toBeNull();
    expect(f.sessionStorage.getItem('poolstatis.browser.session')).toBeNull();
  });

  it('keeps the visitor stable while rotating a session after inactivity', () => {
    const c = consent(true);
    const shared = { localStorage: storage(), sessionStorage: storage() };
    const first = fixture(1_000, shared);
    const a = createBrowserAnalytics({
      client: first.client, browser: first.browser, now: first.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: (() => { let id = 0; return () => `first-${++id}`; })(),
    });
    a.start();
    const visitor = a.visitorId;
    const session = a.sessionId;
    a.destroy();

    const second = fixture(31 * 60_000, shared);
    const b = createBrowserAnalytics({
      client: second.client, browser: second.browser, now: second.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => 'rotated',
    });
    b.start();
    expect(b.visitorId).toBe(visitor);
    expect(b.sessionId).not.toBe(session);
    expect(b.sessionId).toBe('session:rotated');
  });

  it('is importable in SSR without resolving browser globals', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, get: () => { throw new Error('window read'); } });
    try {
      await expect(import('../src/browser.js')).resolves.toBeTruthy();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
