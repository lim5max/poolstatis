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
  let clock = now;
  let href = 'https://example.test/welcome';
  const browser = {
    location: {
      get pathname() { return new URL(href).pathname; },
      get href() { return href; },
    },
    document: { referrer: 'https://publisher.test/private/path?secret=1' },
    history: {
      pushState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) href = new URL(String(url), href).href;
      },
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) href = new URL(String(url), href).href;
      },
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      language: 'en-US',
      globalPrivacyControl: false,
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
  return {
    client, queued, browser, localStorage, sessionStorage,
    setPath: (value: string) => { href = new URL(value, href).href; },
    advance: (milliseconds: number) => { clock += milliseconds; },
    now: () => clock,
  };
}

describe('@poolstatis/sdk/browser', () => {
  it('keeps opt-in as the default and starts opt-out without a host consent callback', () => {
    const defaultConsent = consent(false);
    const optIn = fixture();
    createBrowserAnalytics({
      client: optIn.client,
      browser: optIn.browser,
      hasConsent: defaultConsent.hasConsent,
      subscribeConsent: defaultConsent.subscribeConsent,
      createId: () => 'opt-in',
    }).start();
    expect(optIn.queued).toEqual([]);

    const optOut = fixture();
    createBrowserAnalytics({
      client: optOut.client,
      browser: optOut.browser,
      consentPolicy: 'opt-out',
      createId: (() => { let id = 0; return () => `opt-out-${++id}`; })(),
    }).start();
    expect(optOut.queued).toHaveLength(1);
    expect(optOut.queued[0]).toMatchObject({
      event: 'page.viewed',
      distinct_id: 'visitor:opt-out-1',
      session_id: 'session:opt-out-2',
    });
  });

  it('fails closed for Global Privacy Control in every policy mode', () => {
    const f = fixture();
    f.browser.navigator.globalPrivacyControl = true;
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      consentPolicy: 'opt-out',
      createId: () => 'never-created',
    });

    analytics.start();

    expect(f.queued).toEqual([]);
    expect(f.localStorage.getItem('poolstatis.browser.visitor')).toBeNull();
    expect(f.sessionStorage.getItem('poolstatis.browser.session')).toBeNull();
  });

  it('uses host-managed state for external consent and drops queued data on withdrawal', () => {
    const external = consent(false);
    const f = fixture();
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      consentPolicy: 'external',
      hasConsent: external.hasConsent,
      subscribeConsent: external.subscribeConsent,
      createId: () => 'external',
    });

    analytics.start();
    expect(f.queued).toEqual([]);
    external.set(true);
    expect(f.queued).toHaveLength(1);
    external.set(false);
    expect(f.queued).toEqual([]);
    expect(f.localStorage.getItem('poolstatis.browser.visitor')).toBeNull();
  });

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
    analytics.resetIdentity();
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

  it('rotates an idle session inside a live SPA and resets identity between product users', () => {
    const c = consent(true);
    const f = fixture();
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => `id-${++id}`,
    });
    analytics.start();
    const firstVisitor = analytics.visitorId;
    const firstSession = analytics.sessionId;
    analytics.identify('user-one');
    f.advance(31 * 60_000);
    f.browser.history.pushState({}, '', '/after-idle');
    expect(analytics.sessionId).not.toBe(firstSession);
    expect(f.queued.at(-1)?.session_id).toBe(analytics.sessionId);

    const queuedBeforeReset = [...f.queued];
    analytics.resetIdentity();
    expect(f.queued).toEqual(queuedBeforeReset);
    expect(analytics.visitorId).not.toBe(firstVisitor);
    const secondLink = analytics.identify('user-two');
    expect(secondLink.source_distinct_id).toBe(analytics.visitorId);
    expect(secondLink.target_distinct_id).toBe('user-two');
  });

  it('composes the existing bounded acquisition snapshot into one page view and tolerates blocked storage', () => {
    const c = consent(true);
    const f = fixture();
    f.setPath('/welcome?utm_source=search&utm_campaign=launch&private=drop');
    const blockedStorage = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    f.browser.localStorage = blockedStorage;
    f.browser.sessionStorage = blockedStorage;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      captureAcquisition: true,
      createId: (() => { let id = 0; return () => `id-${++id}`; })(),
    });
    expect(() => analytics.start()).not.toThrow();
    expect(f.queued).toHaveLength(1);
    expect(f.queued[0]?.properties).toMatchObject({
      $utm_source: 'search',
      $utm_campaign: 'launch',
      landing_path: '/welcome',
      referrer_origin: 'https://publisher.test',
    });
    expect(JSON.stringify(f.queued)).not.toContain('private');
    expect(JSON.stringify(f.queued)).not.toContain('/private/path');
  });

  it('applies a host finite page mapper to page and landing paths', () => {
    const c = consent(true);
    const f = fixture();
    f.setPath('/invite/customer-42?token=secret&utm_source=search');
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      hasConsent: c.hasConsent,
      subscribeConsent: c.subscribeConsent,
      captureAcquisition: true,
      mapPagePath: (pathname) => pathname === '/' ? '/' : '/other',
      createId: () => 'mapped',
    });

    analytics.start();

    expect(f.queued[0]?.properties).toMatchObject({
      $page_path: '/other',
      landing_path: '/other',
      $utm_source: 'search',
    });
    expect(JSON.stringify(f.queued)).not.toContain('customer-42');
    expect(JSON.stringify(f.queued)).not.toContain('token');
  });

  it('rotates in memory and reports a stale readable visitor when storage cannot be overwritten', () => {
    const c = consent(true);
    const f = fixture();
    const stickyStorage = {
      getItem: (key: string) => key === 'poolstatis.browser.visitor' ? 'visitor:stale' : null,
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    f.browser.localStorage = stickyStorage;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => 'fresh',
    });
    analytics.start();
    expect(analytics.visitorId).toBe('visitor:stale');
    expect(() => analytics.resetIdentity()).toThrow('stale visitor');
    expect(analytics.visitorId).toBe('visitor:fresh');
  });

  it('reports a stale readable session when account reset cannot overwrite session storage', () => {
    const c = consent(true);
    const f = fixture();
    f.browser.sessionStorage = {
      getItem: () => JSON.stringify({ id: 'session:stale', last: f.now() }),
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => 'fresh',
    });
    analytics.start();
    expect(analytics.sessionId).toBe('session:stale');
    expect(() => analytics.resetIdentity()).toThrow('stale session');
    expect(analytics.sessionId).toBe('session:fresh');
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
