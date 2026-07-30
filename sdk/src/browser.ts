import type { PoolstatisEvent } from './index.js';
import { snapshotFromBrowser, type AttributionSnapshot } from './attribution.js';

export const BROWSER_CONTEXT_VERSION = '1';
export const BROWSER_PAGE_VIEW_EVENT = 'page.viewed';
export const BROWSER_PAGE_ENGAGEMENT_EVENT = 'page.engagement';
export const BROWSER_OPTIONAL_CONTEXT_PROPERTIES = [
  '$device_class',
  '$browser_family',
  '$os_family',
  '$language',
  '$timezone',
  '$viewport_bucket',
  '$screen_bucket',
] as const;

export type BrowserOptionalContextProperty = typeof BROWSER_OPTIONAL_CONTEXT_PROPERTIES[number];
export type BrowserConsentPolicy = 'opt-in' | 'opt-out' | 'external';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type HistoryMethod = (data: unknown, unused: string, url?: string | URL | null) => void;

export interface BrowserLike {
  location: { pathname: string; href: string };
  document: {
    referrer: string;
    visibilityState?: 'visible' | 'hidden' | 'prerender';
    hasFocus?: () => boolean;
    documentElement?: { scrollHeight: number };
    body?: { scrollHeight: number };
    addEventListener?(type: string, listener: () => void): void;
    removeEventListener?(type: string, listener: () => void): void;
  };
  history: { pushState: HistoryMethod; replaceState: HistoryMethod };
  navigator: { userAgent: string; language: string; globalPrivacyControl?: boolean };
  screen: { width: number; height: number };
  innerWidth: number;
  innerHeight: number;
  scrollY?: number;
  localStorage: StorageLike;
  sessionStorage: StorageLike;
  setInterval?(listener: () => void, milliseconds: number): number;
  clearInterval?(handle: number): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface BrowserCaptureClient {
  capture(event: PoolstatisEvent): void;
  discardQueuedEvents(predicate: (event: PoolstatisEvent) => boolean): void;
  flush?(options?: { keepalive?: boolean }): Promise<void> | void;
}

interface BrowserAnalyticsBaseOptions {
  /** Receives only canonical page.viewed/page.engagement events. */
  client: BrowserCaptureClient;
  /** Optional neutral base-SDK path for custom product events. */
  neutralClient?: BrowserCaptureClient;
  browser?: BrowserLike;
  now?: () => number;
  monotonicNow?: () => number;
  createId?: () => string;
  sessionTimeoutMs?: number;
  engagementHeartbeatMs?: number;
  /** Mandatory finite product route mapper. Dynamic pathnames are never emitted. */
  mapPagePath: (pathname: string) => string;
  contextProperties?: readonly BrowserOptionalContextProperty[];
  captureAcquisition?: boolean;
}

type HostConsent = {
  hasConsent: () => boolean;
  subscribeConsent: (listener: () => void) => () => void;
};

export type BrowserAnalyticsOptions = BrowserAnalyticsBaseOptions & (
  | ({ consentPolicy?: 'opt-in' } & HostConsent)
  | ({ consentPolicy: 'opt-out' } & Partial<HostConsent>)
  | ({ consentPolicy: 'external' } & HostConsent)
);

export interface ActorLinkHandoff {
  source_distinct_id: string;
  target_distinct_id: string;
}

const VISITOR_KEY = 'poolstatis.browser.visitor';
const SESSION_KEY = 'poolstatis.browser.session';
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const MIN_HEARTBEAT_MS = 1_000;
const MAX_FOREGROUND_GAP_MS = 30_000;
const MAX_PAGE_DURATION_MS = 7 * 24 * 60 * 60_000;
const SAFE_ROUTE_KEY = /^[a-z][a-z0-9_.:-]{0,99}$/;

type EngagementReason =
  | 'heartbeat'
  | 'visibility_hidden'
  | 'blur'
  | 'route_change'
  | 'pagehide'
  | 'freeze'
  | 'duration_rollover'
  | 'destroy';

interface PageState {
  pageViewId: string;
  route: string;
  sessionId: string;
  actorId: string;
  startedAt: number;
  lastTickAt: number;
  foregroundActive: boolean;
  foregroundMs: number;
  maxScrollPct: number;
  interactionCount: number;
  sequence: number;
}

/** Clear browser identifiers without resolving browser globals during SSR import. */
export function clearBrowserAnalyticsIdentity(
  browserLike?: Pick<BrowserLike, 'localStorage' | 'sessionStorage'>,
): void {
  const candidate = browserLike
    ?? (globalThis as { window?: Pick<BrowserLike, 'localStorage' | 'sessionStorage'> }).window;
  if (!candidate) return;
  try { candidate.localStorage.removeItem(VISITOR_KEY); } catch { /* blocked storage */ }
  try { candidate.sessionStorage.removeItem(SESSION_KEY); } catch { /* blocked storage */ }
}

export function createBrowserAnalytics(options: BrowserAnalyticsOptions) {
  if (typeof options.mapPagePath !== 'function') {
    throw new Error('mapPagePath is required and must return a finite safe route key');
  }
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow
    ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const createId = options.createId ?? randomId;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const heartbeatMs = options.engagementHeartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < MIN_HEARTBEAT_MS) {
    throw new Error(`engagementHeartbeatMs must be an integer of at least ${MIN_HEARTBEAT_MS}`);
  }
  if (heartbeatMs >= MAX_PAGE_DURATION_MS) {
    throw new Error('engagementHeartbeatMs must be less than the seven-day page duration ceiling');
  }

  const neutralClient = options.neutralClient ?? options.client;
  const selectedContext = new Set<BrowserOptionalContextProperty>(
    options.contextProperties ?? BROWSER_OPTIONAL_CONTEXT_PROPERTIES,
  );
  let browser: BrowserLike | null = null;
  let visitorId: string | null = null;
  let actorId: string | null = null;
  let sessionId: string | null = null;
  let lastActivity: number | null = null;
  let lastRoute: string | null = null;
  let acquisition: Omit<AttributionSnapshot, 'session_id'> | null = null;
  let page: PageState | null = null;
  let started = false;
  let stopConsent: (() => void) | null = null;
  let restoreNavigation: (() => void) | null = null;
  let restoreEngagement: (() => void) | null = null;
  const ownedSessions = new Set<string>();

  const resolveBrowser = () => options.browser
    ?? ((globalThis as { window?: BrowserLike }).window ?? null);

  const hostAllowsCollection = () => {
    if (options.consentPolicy === 'opt-out') return options.hasConsent?.() ?? true;
    return options.hasConsent();
  };

  const collectionAllowed = () => {
    if (!hostAllowsCollection()) return false;
    const candidate = browser ?? resolveBrowser();
    return candidate?.navigator.globalPrivacyControl !== true;
  };

  const storageGet = (storage: StorageLike, key: string): string | null => {
    try { return storage.getItem(key); } catch { return null; }
  };
  const storageSet = (storage: StorageLike, key: string, value: string): void => {
    try { storage.setItem(key, value); } catch { /* blocked storage */ }
  };
  const storageRemove = (storage: StorageLike, key: string): void => {
    try { storage.removeItem(key); } catch { /* blocked storage */ }
  };

  const safeRoute = (): string => {
    if (!browser) return 'other';
    let mapped: string;
    try { mapped = options.mapPagePath(browser.location.pathname).trim(); } catch { mapped = 'other'; }
    if (!SAFE_ROUTE_KEY.test(mapped)) {
      throw new Error('mapPagePath must return a finite safe route key');
    }
    return mapped;
  };

  const persistSession = () => {
    if (browser && sessionId && lastActivity !== null) {
      storageSet(browser.sessionStorage, SESSION_KEY, JSON.stringify({ id: sessionId, last: lastActivity }));
    }
  };

  const updateAcquisition = () => {
    if (!options.captureAcquisition || !browser || !sessionId) {
      acquisition = null;
      return;
    }
    const { session_id: _sessionId, ...snapshot } = snapshotFromBrowser(browser, sessionId, safeRoute());
    acquisition = snapshot;
  };

  const rotateSession = (time: number) => {
    sessionId = `session:${createId()}`;
    ownedSessions.add(sessionId);
    lastActivity = time;
    lastRoute = null;
    persistSession();
    updateAcquisition();
  };

  const ensureIdentity = () => {
    visitorId = storageGet(browser!.localStorage, VISITOR_KEY);
    if (!visitorId) {
      visitorId = `visitor:${createId()}`;
      storageSet(browser!.localStorage, VISITOR_KEY, visitorId);
    }
    const raw = storageGet(browser!.sessionStorage, SESSION_KEY);
    let saved: { id?: unknown; last?: unknown } | null = null;
    try { saved = raw ? JSON.parse(raw) as { id?: unknown; last?: unknown } : null; } catch { saved = null; }
    const time = now();
    if (typeof saved?.id !== 'string'
      || typeof saved.last !== 'number'
      || !Number.isFinite(saved.last)
      || time - saved.last > sessionTimeoutMs) {
      rotateSession(time);
    } else {
      sessionId = saved.id;
      ownedSessions.add(sessionId);
      lastActivity = saved.last;
      persistSession();
      updateAcquisition();
    }
    actorId ??= visitorId;
  };

  const ensureActiveSession = () => {
    const time = now();
    if (!sessionId || lastActivity === null || time - lastActivity > sessionTimeoutMs) {
      rotateSession(time);
      return true;
    }
    lastActivity = time;
    persistSession();
    return false;
  };

  const optionalContext = (): Record<string, string> => {
    const ua = browser!.navigator.userAgent;
    const context: Record<BrowserOptionalContextProperty, string> = {
      $device_class: deviceClass(ua),
      $browser_family: browserFamily(ua),
      $os_family: osFamily(ua),
      $language: primaryLanguage(browser!.navigator.language),
      $timezone: timezone(),
      $viewport_bucket: sizeBucket(browser!.innerWidth),
      $screen_bucket: sizeBucket(browser!.screen.width),
    };
    return Object.fromEntries(
      Object.entries(context).filter(([key]) => selectedContext.has(key as BrowserOptionalContextProperty)),
    );
  };

  const captureCanonical = (
    event: typeof BROWSER_PAGE_VIEW_EVENT | typeof BROWSER_PAGE_ENGAGEMENT_EVENT,
    properties: Record<string, unknown>,
    identity?: { actorId: string; sessionId: string; route: string },
  ) => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId || !sessionId) return;
    options.client.capture({
      event,
      distinct_id: identity?.actorId ?? actorId,
      session_id: identity?.sessionId ?? sessionId,
      properties: {
        ...(acquisition ?? {}),
        $browser_context: BROWSER_CONTEXT_VERSION,
        $route_key: identity?.route ?? safeRoute(),
        ...optionalContext(),
        ...properties,
      },
    });
  };

  const currentScrollPct = () => {
    if (!browser) return 0;
    const height = Math.max(
      browser.document.documentElement?.scrollHeight ?? 0,
      browser.document.body?.scrollHeight ?? 0,
    );
    const scrollable = Math.max(0, height - browser.innerHeight);
    if (scrollable === 0) return 100;
    return Math.max(0, Math.min(100, Math.round(((browser.scrollY ?? 0) / scrollable) * 100)));
  };

  const updateClock = () => {
    if (!page) return;
    const time = monotonicNow();
    const delta = Math.max(0, Math.min(MAX_FOREGROUND_GAP_MS, time - page.lastTickAt));
    if (page.foregroundActive) page.foregroundMs += delta;
    page.lastTickAt = time;
    page.maxScrollPct = Math.max(page.maxScrollPct, currentScrollPct());
  };

  const flushEngagement = (reason: EngagementReason) => {
    if (!page || !collectionAllowed()) return false;
    updateClock();
    page.sequence += 1;
    lastActivity = now();
    persistSession();
    const elapsedMs = Math.min(
      MAX_PAGE_DURATION_MS,
      Math.max(0, Math.round(monotonicNow() - page.startedAt)),
    );
    captureCanonical(BROWSER_PAGE_ENGAGEMENT_EVENT, {
      $page_view_id: page.pageViewId,
      sequence: page.sequence,
      foreground_ms: Math.min(Math.round(page.foregroundMs), elapsedMs),
      elapsed_ms: elapsedMs,
      max_scroll_pct: page.maxScrollPct,
      interaction_count: page.interactionCount,
      reason,
    }, { actorId: page.actorId, sessionId: page.sessionId, route: page.route });
    return true;
  };

  const terminalFlush = (reason: 'pagehide' | 'freeze') => {
    updateClock();
    if (page) page.foregroundActive = false;
    if (!flushEngagement(reason)) return;
    try {
      const pending = options.client.flush?.({ keepalive: true });
      if (pending) void pending.catch(() => {});
    } catch { /* lifecycle callbacks cannot surface transport errors */ }
  };

  const startPage = (route: string) => {
    if (!browser || !actorId || !sessionId) return false;
    const tick = monotonicNow();
    page = {
      pageViewId: `page:${createId()}`,
      route,
      sessionId,
      actorId,
      startedAt: tick,
      lastTickAt: tick,
      foregroundActive: browser.document.visibilityState !== 'hidden'
        && browser.document.visibilityState !== 'prerender'
        && (browser.document.hasFocus?.() ?? true),
      foregroundMs: 0,
      maxScrollPct: currentScrollPct(),
      interactionCount: 0,
      sequence: 0,
    };
    captureCanonical(BROWSER_PAGE_VIEW_EVENT, { $page_view_id: page.pageViewId });
    return true;
  };

  const pageViewed = () => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
    const route = safeRoute();
    if (route === lastRoute) return;
    const expired = !sessionId || lastActivity === null || now() - lastActivity > sessionTimeoutMs;
    if (page) flushEngagement('route_change');
    if (expired) rotateSession(now());
    else ensureActiveSession();
    lastRoute = route;
    startPage(route);
  };

  const resumeAfterIdle = () => {
    if (!sessionId || lastActivity === null || now() - lastActivity <= sessionTimeoutMs) return false;
    page = null;
    rotateSession(now());
    lastRoute = null;
    pageViewed();
    return true;
  };

  const rolloverLongPage = () => {
    if (!page || monotonicNow() - page.startedAt < MAX_PAGE_DURATION_MS - heartbeatMs) return false;
    const route = page.route;
    if (!flushEngagement('duration_rollover')) return false;
    page = null;
    return startPage(route);
  };

  const bindNavigation = () => {
    const onNavigation = () => pageViewed();
    const push = browser!.history.pushState;
    const replace = browser!.history.replaceState;
    browser!.history.pushState = function (...args) { push.apply(this, args); onNavigation(); };
    browser!.history.replaceState = function (...args) { replace.apply(this, args); onNavigation(); };
    browser!.addEventListener('popstate', onNavigation);
    restoreNavigation = () => {
      if (!browser) return;
      browser.history.pushState = push;
      browser.history.replaceState = replace;
      browser.removeEventListener('popstate', onNavigation);
    };
  };

  const bindEngagement = () => {
    const onVisibility = () => {
      updateClock();
      if (!page || !browser) return;
      const visible = browser.document.visibilityState !== 'hidden'
        && browser.document.visibilityState !== 'prerender';
      if (!visible && page.foregroundActive) {
        page.foregroundActive = false;
        flushEngagement('visibility_hidden');
        return;
      }
      if (visible && resumeAfterIdle()) return;
      page.foregroundActive = visible && (browser.document.hasFocus?.() ?? true);
    };
    const onFocus = () => {
      updateClock();
      if (resumeAfterIdle()) return;
      if (page && browser) page.foregroundActive = browser.document.visibilityState === 'visible';
    };
    const onBlur = () => {
      updateClock();
      if (page?.foregroundActive) {
        page.foregroundActive = false;
        flushEngagement('blur');
      }
    };
    const onScroll = () => {
      if (page) page.maxScrollPct = Math.max(page.maxScrollPct, currentScrollPct());
    };
    const onInteraction = () => { if (page?.foregroundActive) page.interactionCount += 1; };
    const onPageHide = () => terminalFlush('pagehide');
    const onFreeze = () => terminalFlush('freeze');
    const onResume = () => {
      updateClock();
      if (resumeAfterIdle()) return;
      if (page && browser) {
        page.foregroundActive = browser.document.visibilityState === 'visible'
          && (browser.document.hasFocus?.() ?? true);
      }
    };
    const heartbeat = () => {
      updateClock();
      if (page?.foregroundActive && !rolloverLongPage()) flushEngagement('heartbeat');
    };
    const timer = browser!.setInterval
      ? browser!.setInterval(heartbeat, heartbeatMs)
      : globalThis.setInterval(heartbeat, heartbeatMs) as unknown as number;
    browser!.document.addEventListener?.('visibilitychange', onVisibility);
    browser!.document.addEventListener?.('freeze', onFreeze);
    browser!.document.addEventListener?.('resume', onResume);
    browser!.addEventListener('focus', onFocus);
    browser!.addEventListener('blur', onBlur);
    browser!.addEventListener('scroll', onScroll);
    browser!.addEventListener('pointerdown', onInteraction);
    browser!.addEventListener('keydown', onInteraction);
    browser!.addEventListener('pagehide', onPageHide);
    browser!.addEventListener('pageshow', onResume);
    restoreEngagement = () => {
      if (!browser) return;
      if (browser.clearInterval) browser.clearInterval(timer);
      else globalThis.clearInterval(timer);
      browser.document.removeEventListener?.('visibilitychange', onVisibility);
      browser.document.removeEventListener?.('freeze', onFreeze);
      browser.document.removeEventListener?.('resume', onResume);
      browser.removeEventListener('focus', onFocus);
      browser.removeEventListener('blur', onBlur);
      browser.removeEventListener('scroll', onScroll);
      browser.removeEventListener('pointerdown', onInteraction);
      browser.removeEventListener('keydown', onInteraction);
      browser.removeEventListener('pagehide', onPageHide);
      browser.removeEventListener('pageshow', onResume);
    };
  };

  const clear = () => {
    const predicate = (event: PoolstatisEvent) => (
      event.properties?.$browser_context === BROWSER_CONTEXT_VERSION
      || (event.session_id !== undefined && ownedSessions.has(event.session_id))
    );
    options.client.discardQueuedEvents(predicate);
    if (neutralClient !== options.client) neutralClient.discardQueuedEvents(predicate);
    restoreNavigation?.();
    restoreEngagement?.();
    restoreNavigation = null;
    restoreEngagement = null;
    if (browser) {
      storageRemove(browser.localStorage, VISITOR_KEY);
      storageRemove(browser.sessionStorage, SESSION_KEY);
    }
    visitorId = null;
    actorId = null;
    sessionId = null;
    lastActivity = null;
    lastRoute = null;
    acquisition = null;
    page = null;
    started = false;
    ownedSessions.clear();
  };

  const start = () => {
    if (!collectionAllowed() || started) return;
    browser = resolveBrowser();
    if (!browser) return;
    ensureIdentity();
    started = true;
    bindNavigation();
    pageViewed();
    bindEngagement();
  };

  stopConsent = options.subscribeConsent?.(() => {
    if (collectionAllowed()) start();
    else clear();
  }) ?? null;

  return {
    start,
    track(event: string, properties: Record<string, unknown> = {}) {
      if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
      ensureActiveSession();
      neutralClient.capture({
        event,
        distinct_id: actorId,
        session_id: sessionId!,
        properties: { ...properties },
      });
    },
    pageViewed,
    identify(userId: string): ActorLinkHandoff {
      if (!visitorId) throw new Error('browser analytics must be started with consent before identify');
      const target = userId.trim();
      if (!target || target.length > 200) throw new Error('user id must be 1..200 characters');
      actorId = target;
      return { source_distinct_id: visitorId, target_distinct_id: target };
    },
    resetIdentity() {
      if (!browser) return;
      if (page && collectionAllowed()) flushEngagement('destroy');
      storageRemove(browser.localStorage, VISITOR_KEY);
      storageRemove(browser.sessionStorage, SESSION_KEY);
      page = null;
      visitorId = null;
      actorId = null;
      sessionId = null;
      lastActivity = null;
      lastRoute = null;
      acquisition = null;
      if (!collectionAllowed()) return;
      let staleVisitor: string | null;
      let staleSession: string | null;
      try {
        staleVisitor = browser.localStorage.getItem(VISITOR_KEY);
        staleSession = browser.sessionStorage.getItem(SESSION_KEY);
      } catch {
        throw new Error(
          'browser identity reset could not verify cleared storage; collection remains disabled until storage access is restored',
        );
      }
      if (staleVisitor !== null) {
        throw new Error(
          'browser identity reset found a stale visitor; collection remains disabled until storage access is restored',
        );
      }
      if (staleSession !== null) {
        throw new Error(
          'browser identity reset found a stale session; collection remains disabled until storage access is restored',
        );
      }
      ensureIdentity();
      pageViewed();
    },
    get visitorId() { return visitorId; },
    get sessionId() { return sessionId; },
    destroy() {
      if (collectionAllowed()) flushEngagement('destroy');
      restoreNavigation?.();
      restoreEngagement?.();
      stopConsent?.();
      restoreNavigation = null;
      restoreEngagement = null;
      stopConsent = null;
      page = null;
      started = false;
    },
  };
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function sizeBucket(width: number): 'xs' | 'sm' | 'md' | 'lg' | 'xl' {
  if (width < 480) return 'xs';
  if (width < 768) return 'sm';
  if (width < 1024) return 'md';
  if (width < 1440) return 'lg';
  return 'xl';
}

function browserFamily(ua: string): 'chrome' | 'safari' | 'firefox' | 'edge' | 'other' {
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

function osFamily(ua: string): 'android' | 'ios' | 'macos' | 'windows' | 'linux' | 'other' {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function deviceClass(ua: string): 'desktop' | 'mobile' | 'tablet' {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobile|iPhone|iPod|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

function primaryLanguage(value: string): string {
  const language = (value.split('-')[0] ?? '').toLowerCase();
  return /^[a-z]{2,3}$/.test(language) ? language : 'unknown';
}

function timezone(): string {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z_+-]+(?:\/[A-Za-z_+-]+){0,2}$/.test(value) ? value.slice(0, 64) : 'unknown';
  } catch {
    return 'unknown';
  }
}
