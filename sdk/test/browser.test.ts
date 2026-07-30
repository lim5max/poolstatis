import { describe, expect, it } from 'vitest';
import {
  clearBrowserAnalyticsIdentity,
  createBrowserAnalytics as createBrowserAnalyticsContract,
  type BrowserAnalyticsOptions,
  type BrowserCaptureClient,
} from '../src/browser.js';
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
  const documentListeners = new Map<string, Set<() => void>>();
  let clock = now;
  let href = 'https://example.test/welcome';
  let heartbeat: (() => void) | null = null;
  let visible = true;
  let focused = true;
  let scrollY = 0;
  const browser = {
    location: {
      get pathname() { return new URL(href).pathname; },
      get href() { return href; },
    },
    document: {
      referrer: 'https://publisher.test/private/path?secret=1',
      get visibilityState() { return visible ? 'visible' as const : 'hidden' as const; },
      hasFocus: () => focused,
      documentElement: { scrollHeight: 2_000 },
      body: { scrollHeight: 2_000 },
      addEventListener(type: string, listener: () => void) {
        const set = documentListeners.get(type) ?? new Set();
        set.add(listener); documentListeners.set(type, set);
      },
      removeEventListener(type: string, listener: () => void) { documentListeners.get(type)?.delete(listener); },
    },
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
    get scrollY() { return scrollY; },
    localStorage,
    sessionStorage,
    setInterval(listener: () => void) { heartbeat = listener; return 1; },
    clearInterval() { heartbeat = null; },
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
    heartbeat: () => heartbeat?.(),
    setVisible(value: boolean) {
      visible = value;
      documentListeners.get('visibilitychange')?.forEach((listener) => listener());
    },
    setFocused(value: boolean) {
      focused = value;
      listeners.get(value ? 'focus' : 'blur')?.forEach((listener) => listener());
    },
    scrollTo(value: number) {
      scrollY = value;
      listeners.get('scroll')?.forEach((listener) => listener());
    },
    interact() { listeners.get('pointerdown')?.forEach((listener) => listener()); },
    pagehide() { listeners.get('pagehide')?.forEach((listener) => listener()); },
    pageshow() { listeners.get('pageshow')?.forEach((listener) => listener()); },
    freeze() { documentListeners.get('freeze')?.forEach((listener) => listener()); },
    resume() { documentListeners.get('resume')?.forEach((listener) => listener()); },
  };
}

function createBrowserAnalytics(options: BrowserAnalyticsOptions) {
  return createBrowserAnalyticsContract({
    mapPagePath: (pathname) => pathname === '/welcome'
      ? 'welcome'
      : pathname === '/pricing'
        ? 'pricing'
        : 'other',
    ...options,
  });
}

describe('@poolstatis/sdk/browser', () => {
  it('rejects heartbeat intervals that can create a browser hot loop', () => {
    const f = fixture();
    const c = consent(true);
    expect(() => createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      engagementHeartbeatMs: 0,
      hasConsent: c.hasConsent,
      subscribeConsent: c.subscribeConsent,
    })).toThrow('engagementHeartbeatMs');
    expect(() => createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      engagementHeartbeatMs: 999,
      hasConsent: c.hasConsent,
      subscribeConsent: c.subscribeConsent,
    })).toThrow('engagementHeartbeatMs');
  });

  it('rejects a heartbeat interval that cannot finalize before the server duration ceiling', () => {
    const f = fixture();
    const c = consent(true);
    expect(() => createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      engagementHeartbeatMs: 7 * 24 * 60 * 60 * 1_000,
      hasConsent: c.hasConsent,
      subscribeConsent: c.subscribeConsent,
    })).toThrow('engagementHeartbeatMs must be less than the seven-day page duration ceiling');
  });

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

  it('explicitly clears persisted browser identity when a host starts disabled', () => {
    const f = fixture();
    f.localStorage.setItem('poolstatis.browser.visitor', 'visitor:seeded');
    f.sessionStorage.setItem('poolstatis.browser.session', JSON.stringify({
      id: 'session:seeded',
      last: 1_000,
    }));

    clearBrowserAnalyticsIdentity(f.browser);

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
        $route_key: 'welcome', $device_class: 'mobile', $browser_family: 'safari',
        $os_family: 'ios', $language: 'en', $viewport_bucket: 'xs', $screen_bucket: 'xs',
      },
    });
    expect(JSON.stringify(first.queued)).not.toContain('Mozilla');

    first.browser.history.pushState({}, '', '/pricing?secret=1');
    expect(first.queued.at(-1)?.properties?.$route_key).toBe('pricing');
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

    const oldPageId = f.queued.filter((event) => event.event === 'page.viewed').at(-1)?.properties?.$page_view_id;
    analytics.resetIdentity();
    expect(analytics.visitorId).not.toBe(firstVisitor);
    expect(f.queued.at(-2)).toMatchObject({
      event: 'page.engagement',
      distinct_id: 'user-one',
      properties: { $page_view_id: oldPageId, reason: 'destroy' },
    });
    expect(f.queued.at(-1)).toMatchObject({
      event: 'page.viewed',
      distinct_id: analytics.visitorId,
      session_id: analytics.sessionId,
    });
    expect(f.queued.at(-1)?.properties?.$page_view_id).not.toBe(oldPageId);
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
      landing_route: 'welcome',
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
      mapPagePath: (pathname) => pathname === '/' ? 'home' : 'other',
      createId: () => 'mapped',
    });

    analytics.start();

    expect(f.queued[0]?.properties).toMatchObject({
      $route_key: 'other',
      landing_route: 'other',
      $utm_source: 'search',
    });
    expect(JSON.stringify(f.queued)).not.toContain('customer-42');
    expect(JSON.stringify(f.queued)).not.toContain('token');
  });

  it('lets a host narrow coarse context without expanding the fixed allowlist', () => {
    const c = consent(true);
    const f = fixture();
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      hasConsent: c.hasConsent,
      subscribeConsent: c.subscribeConsent,
      contextProperties: [
        '$device_class',
        '$browser_family',
        '$os_family',
        'private_value',
      ] as never,
      createId: () => 'narrowed',
    });

    analytics.start();

    expect(f.queued[0]?.properties).toMatchObject({
      $device_class: 'mobile',
      $browser_family: 'safari',
      $os_family: 'ios',
    });
    expect(f.queued[0]?.properties).not.toHaveProperty('$language');
    expect(f.queued[0]?.properties).not.toHaveProperty('$timezone');
    expect(f.queued[0]?.properties).not.toHaveProperty('$viewport_bucket');
    expect(f.queued[0]?.properties).not.toHaveProperty('private_value');
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
    expect(analytics.visitorId).toBeNull();
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
    expect(analytics.sessionId).toBeNull();
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

  it('emits one stable page id and cumulative foreground engagement snapshots', () => {
    const c = consent(true);
    const f = fixture();
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => `engagement-${++id}`,
    });

    analytics.start();
    const pageView = f.queued[0]!;
    expect(pageView.properties?.$page_view_id).toBe('page:engagement-3');

    for (let index = 0; index < 4; index += 1) {
      f.advance(10_000);
      f.heartbeat();
    }
    f.advance(5_000);
    f.pagehide();

    const snapshots = f.queued.filter((event) => event.event === 'page.engagement');
    expect(snapshots).toHaveLength(5);
    expect(snapshots.map((event) => event.properties?.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshots.at(-1)?.properties).toMatchObject({
      $page_view_id: 'page:engagement-3',
      foreground_ms: 45_000,
      elapsed_ms: 45_000,
      reason: 'pagehide',
    });
  });

  it('finalizes and rotates a long-lived page before the seven-day server ceiling', () => {
    const c = consent(true);
    const f = fixture();
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client,
      browser: f.browser,
      now: f.now,
      monotonicNow: f.now,
      engagementHeartbeatMs: 10_000,
      hasConsent: c.hasConsent,
      subscribeConsent: c.subscribeConsent,
      createId: () => `rollover-${++id}`,
    });

    analytics.start();
    const firstPage = f.queued[0]?.properties?.$page_view_id;
    f.advance(7 * 24 * 60 * 60 * 1_000 - 10_000);
    f.heartbeat();

    const pageViews = f.queued.filter((event) => event.event === 'page.viewed');
    const snapshots = f.queued.filter((event) => event.event === 'page.engagement');
    expect(pageViews).toHaveLength(2);
    expect(pageViews[1]).toMatchObject({
      session_id: analytics.sessionId,
      properties: { $route_key: 'welcome' },
    });
    expect(pageViews[1]?.properties?.$page_view_id).not.toBe(firstPage);
    expect(snapshots.at(-1)?.properties).toMatchObject({
      $page_view_id: firstPage,
      reason: 'duration_rollover',
    });
    expect(Number(snapshots.at(-1)?.properties?.elapsed_ms)).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1_000,
    );
  });

  it('keepalive-flushes a terminal snapshot after an earlier client unload handler drained the queue', async () => {
    const c = consent(true);
    const f = fixture();
    const delivered: PoolstatisEvent[] = [];
    const flushModes: boolean[] = [];
    const client: BrowserCaptureClient = {
      capture: (event) => f.queued.push(event),
      discardQueuedEvents: f.client.discardQueuedEvents,
      flush: async (options) => {
        flushModes.push(options?.keepalive === true);
        delivered.push(...f.queued.splice(0));
      },
    };
    f.browser.addEventListener('pagehide', () => { void client.flush?.({ keepalive: true }); });
    const analytics = createBrowserAnalytics({
      client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: (() => { let id = 0; return () => `terminal-${++id}`; })(),
    });

    analytics.start();
    f.advance(5_000);
    f.pagehide();
    await Promise.resolve();

    expect(flushModes).toEqual([true, true]);
    expect(delivered.map((event) => event.event)).toEqual(['page.viewed', 'page.engagement']);
    expect(delivered.at(-1)?.properties).toMatchObject({
      foreground_ms: 5_000,
      reason: 'pagehide',
    });
    expect(f.queued).toEqual([]);
  });

  it('stops foreground time across pagehide and document freeze until the page resumes', () => {
    const c = consent(true);
    const f = fixture();
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: (() => { let id = 0; return () => `lifecycle-${++id}`; })(),
    });

    analytics.start();
    f.advance(5_000);
    f.pagehide();
    f.advance(60_000);
    f.pageshow();
    f.advance(2_000);
    f.freeze();
    f.advance(60_000);
    f.resume();
    f.advance(3_000);
    f.pagehide();

    const snapshots = f.queued.filter((event) => event.event === 'page.engagement');
    expect(snapshots.map((event) => event.properties?.reason)).toEqual([
      'pagehide', 'freeze', 'pagehide',
    ]);
    expect(snapshots.map((event) => event.properties?.foreground_ms)).toEqual([
      5_000, 7_000, 10_000,
    ]);
  });

  it('excludes hidden time and caps one suspended foreground gap at thirty seconds', () => {
    const c = consent(true);
    const f = fixture();
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => `visibility-${++id}`,
    });

    analytics.start();
    f.advance(6_000);
    f.setVisible(false);
    f.advance(20 * 60_000);
    f.setVisible(true);
    f.advance(120_000);
    f.heartbeat();

    const snapshots = f.queued.filter((event) => event.event === 'page.engagement');
    expect(snapshots.map((event) => event.properties?.foreground_ms)).toEqual([6_000, 36_000]);
    expect(snapshots.at(-1)?.properties?.elapsed_ms).toBe(1_326_000);
  });

  it('starts a new page and session when a hidden tab resumes after inactivity', () => {
    const c = consent(true);
    const f = fixture();
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => `resume-${++id}`,
    });

    analytics.start();
    const firstSession = analytics.sessionId;
    const firstPage = f.queued[0]?.properties?.$page_view_id;
    f.advance(5_000);
    f.setVisible(false);
    f.advance(31 * 60_000);
    f.setVisible(true);

    const pageViews = f.queued.filter((event) => event.event === 'page.viewed');
    expect(pageViews).toHaveLength(2);
    expect(analytics.sessionId).not.toBe(firstSession);
    expect(pageViews[1]).toMatchObject({
      distinct_id: analytics.visitorId,
      session_id: analytics.sessionId,
    });
    expect(pageViews[1]?.properties?.$page_view_id).not.toBe(firstPage);
    expect(f.queued.find((event) => event.event === 'page.engagement')).toMatchObject({
      session_id: firstSession,
      properties: { $page_view_id: firstPage, reason: 'visibility_hidden' },
    });
  });

  it('flushes an SPA page before creating a new page id and keeps cumulative page state separate', () => {
    const c = consent(true);
    const f = fixture();
    let id = 0;
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => `spa-${++id}`,
    });

    analytics.start();
    f.advance(4_000);
    f.interact();
    f.browser.history.pushState({}, '', '/pricing');

    expect(f.queued.map((event) => event.event)).toEqual([
      'page.viewed',
      'page.engagement',
      'page.viewed',
    ]);
    expect(f.queued[1]?.properties).toMatchObject({
      $page_view_id: 'page:spa-3',
      foreground_ms: 4_000,
      interaction_count: 1,
      reason: 'route_change',
    });
    expect(f.queued[2]?.properties?.$page_view_id).toBe('page:spa-4');
  });

  it('does not emit engagement before consent or after consent is revoked', () => {
    const c = consent(false);
    const f = fixture();
    const analytics = createBrowserAnalytics({
      client: f.client, browser: f.browser, now: f.now, monotonicNow: f.now,
      hasConsent: c.hasConsent, subscribeConsent: c.subscribeConsent,
      createId: () => 'consent',
    });

    analytics.start();
    f.advance(10_000);
    f.heartbeat();
    expect(f.queued).toEqual([]);

    c.set(true);
    f.advance(10_000);
    f.heartbeat();
    expect(f.queued.some((event) => event.event === 'page.engagement')).toBe(true);

    c.set(false);
    expect(f.queued).toEqual([]);
    f.advance(10_000);
    f.heartbeat();
    expect(f.queued).toEqual([]);
  });
});
