import type { PoolstatisEvent } from './index.js';
import {
  ACQUISITION_UTM_KEYS,
  snapshotFromBrowser,
  type AttributionSnapshot,
} from './attribution.js';

export const BROWSER_CONTEXT_VERSION = '1';
export const BROWSER_PAGE_VIEW_EVENT = 'page.viewed';
export const BROWSER_PAGE_ENGAGEMENT_EVENT = 'page.engagement';
export const BROWSER_RESERVED_PROPERTIES = [
  '$browser_context', '$page_path', '$page_view_id', '$device_class', '$browser_family', '$os_family',
  '$language', '$timezone', '$viewport_bucket', '$screen_bucket', '$country',
  ...ACQUISITION_UTM_KEYS, 'landing_path', 'referrer_origin',
  'sequence', 'foreground_ms', 'elapsed_ms', 'max_scroll_pct', 'interaction_count', 'reason',
] as const;
export const BROWSER_OPTIONAL_CONTEXT_PROPERTIES = [
  '$device_class', '$browser_family', '$os_family', '$language',
  '$timezone', '$viewport_bucket', '$screen_bucket',
] as const;
export type BrowserOptionalContextProperty = typeof BROWSER_OPTIONAL_CONTEXT_PROPERTIES[number];

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
}

export type BrowserConsentPolicy = 'opt-in' | 'opt-out' | 'external';

interface BrowserAnalyticsBaseOptions {
  client: BrowserCaptureClient;
  browser?: BrowserLike;
  now?: () => number;
  /** Monotonic page clock. Defaults to performance.now() where available. */
  monotonicNow?: () => number;
  createId?: () => string;
  sessionTimeoutMs?: number;
  engagementHeartbeatMs?: number;
  /** Map the pathname to a finite, non-sensitive product route vocabulary. */
  mapPagePath?: (pathname: string) => string;
  /** Narrow the standard coarse context. Unknown properties are never emitted. */
  contextProperties?: readonly BrowserOptionalContextProperty[];
  /** Compose the existing bounded UTM snapshot into the same session and page-view events. */
  captureAcquisition?: boolean;
}

type HostConsent = {
  hasConsent: () => boolean;
  subscribeConsent: (listener: () => void) => () => void;
};

/**
 * Consent is integration-controlled. Existing integrations remain opt-in by
 * default; opt-out is an explicit host choice, and external delegates the
 * decision to a CMP or another host-owned consent source.
 */
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
const SESSION_TIMEOUT_MS = 30 * 60_000;
const ENGAGEMENT_HEARTBEAT_MS = 10_000;
const MAX_FOREGROUND_GAP_MS = 30_000;
const reserved = new Set<string>(BROWSER_RESERVED_PROPERTIES);

type EngagementReason =
  | 'heartbeat'
  | 'visibility_hidden'
  | 'blur'
  | 'route_change'
  | 'pagehide'
  | 'freeze'
  | 'destroy';

interface PageEngagementState {
  pageViewId: string;
  path: string;
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

/** Remove the first-party anonymous visitor and session without starting capture. */
export function clearBrowserAnalyticsIdentity(
  browserLike?: Pick<BrowserLike, 'localStorage' | 'sessionStorage'>,
): void {
  const candidate = browserLike
    ?? (globalThis as { window?: Pick<BrowserLike, 'localStorage' | 'sessionStorage'> }).window;
  if (!candidate) return;
  try { candidate.localStorage.removeItem(VISITOR_KEY); } catch { /* storage may be blocked */ }
  try { candidate.sessionStorage.removeItem(SESSION_KEY); } catch { /* storage may be blocked */ }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function boundedPath(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized.slice(0, 512) || '/';
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

function timezone(): string {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z_+-]+(?:\/[A-Za-z_+-]+){0,2}$/.test(value) ? value.slice(0, 64) : 'unknown';
  } catch {
    return 'unknown';
  }
}

function primaryLanguage(value: string): string {
  const language = (value.split('-')[0] || '').toLowerCase();
  return /^[a-z]{2,3}$/.test(language) ? language : 'unknown';
}

export function createBrowserAnalytics(options: BrowserAnalyticsOptions) {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow
    ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const createId = options.createId ?? randomId;
  const timeout = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  const heartbeatMs = options.engagementHeartbeatMs ?? ENGAGEMENT_HEARTBEAT_MS;
  let browser: BrowserLike | null = null;
  let visitorId: string | null = null;
  let sessionId: string | null = null;
  let actorId: string | null = null;
  let lastActivity: number | null = null;
  let lastPath: string | null = null;
  let acquisitionProperties: Omit<AttributionSnapshot, 'session_id'> | null = null;
  let started = false;
  let stopConsent: (() => void) | null = null;
  let restoreHistory: (() => void) | null = null;
  let restoreEngagement: (() => void) | null = null;
  let pageState: PageEngagementState | null = null;
  const contextProperties = new Set<BrowserOptionalContextProperty>(
    options.contextProperties ?? BROWSER_OPTIONAL_CONTEXT_PROPERTIES,
  );

  const resolveBrowser = () => options.browser
    ?? ((globalThis as { window?: BrowserLike }).window ?? null);

  const hostAllowsCollection = (): boolean => {
    if (options.consentPolicy === 'opt-out') return options.hasConsent?.() ?? true;
    return options.hasConsent();
  };

  const collectionAllowed = (): boolean => {
    if (!hostAllowsCollection()) return false;
    const candidate = browser ?? resolveBrowser();
    return candidate?.navigator.globalPrivacyControl !== true;
  };

  const storageGet = (storage: StorageLike, key: string): string | null => {
    try { return storage.getItem(key); } catch { return null; }
  };
  const storageSet = (storage: StorageLike, key: string, value: string): boolean => {
    try { storage.setItem(key, value); return true; } catch { return false; }
  };
  const storageRemove = (storage: StorageLike, key: string): void => {
    try { storage.removeItem(key); } catch { /* storage may be blocked by the browser */ }
  };

  const clear = () => {
    options.client.discardQueuedEvents((event) => event.properties?.$browser_context === BROWSER_CONTEXT_VERSION);
    if (browser) {
      storageRemove(browser.localStorage, VISITOR_KEY);
      storageRemove(browser.sessionStorage, SESSION_KEY);
    }
    visitorId = null; sessionId = null; actorId = null; lastActivity = null;
    lastPath = null; acquisitionProperties = null; started = false;
    restoreHistory?.(); restoreHistory = null;
    restoreEngagement?.(); restoreEngagement = null;
    pageState = null;
  };

  const context = (path = currentPagePath()): Record<string, unknown> => {
    const ua = browser!.navigator.userAgent;
    const optional: Record<BrowserOptionalContextProperty, unknown> = {
      $device_class: deviceClass(ua),
      $browser_family: browserFamily(ua),
      $os_family: osFamily(ua),
      $language: primaryLanguage(browser!.navigator.language),
      $timezone: timezone(),
      $viewport_bucket: sizeBucket(browser!.innerWidth),
      $screen_bucket: sizeBucket(browser!.screen.width),
    };
    const selected = Object.fromEntries(
      Object.entries(optional).filter(([key]) => (
        contextProperties.has(key as BrowserOptionalContextProperty)
      )),
    );
    return {
      $browser_context: BROWSER_CONTEXT_VERSION,
      $page_path: path,
      ...selected,
    };
  };

  const updateAcquisition = () => {
    if (!options.captureAcquisition || !browser || !sessionId) {
      acquisitionProperties = null;
      return;
    }
    const { session_id: _sessionId, ...snapshot } = snapshotFromBrowser(browser, sessionId);
    acquisitionProperties = { ...snapshot, landing_path: currentPagePath() };
  };

  const currentPagePath = (): string => {
    if (!browser) return '/other';
    try {
      return boundedPath(options.mapPagePath?.(browser.location.pathname) ?? browser.location.pathname);
    } catch {
      return '/other';
    }
  };

  const persistSession = () => {
    if (browser && sessionId && lastActivity !== null) {
      storageSet(browser.sessionStorage, SESSION_KEY, JSON.stringify({ id: sessionId, last: lastActivity }));
    }
  };

  const rotateSession = (time: number) => {
    sessionId = `session:${createId()}`;
    lastActivity = time;
    lastPath = null;
    updateAcquisition();
    persistSession();
  };

  const ensureIdentity = () => {
    visitorId = storageGet(browser!.localStorage, VISITOR_KEY);
    if (!visitorId) {
      visitorId = `visitor:${createId()}`;
      storageSet(browser!.localStorage, VISITOR_KEY, visitorId);
    }
    const raw = storageGet(browser!.sessionStorage, SESSION_KEY);
    let saved: { id?: string; last?: number } | null = null;
    try { saved = raw ? JSON.parse(raw) as { id?: string; last?: number } : null; } catch { saved = null; }
    const time = now();
    if (!saved?.id || typeof saved.last !== 'number' || time - saved.last > timeout) {
      rotateSession(time);
    } else {
      sessionId = saved.id;
      lastActivity = saved.last;
      updateAcquisition();
      persistSession();
    }
    actorId ??= visitorId;
  };

  const ensureActiveSession = (): boolean => {
    const time = now();
    const rotated = !sessionId || lastActivity === null || time - lastActivity > timeout;
    if (rotated) rotateSession(time);
    else {
      lastActivity = time;
      persistSession();
    }
    return rotated;
  };

  const captureInternal = (
    event: string,
    properties: Record<string, unknown>,
    identity?: { actorId: string; sessionId: string; path: string },
  ) => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
    options.client.capture({
      event,
      distinct_id: identity?.actorId ?? actorId,
      session_id: identity?.sessionId ?? sessionId!,
      properties: {
        ...(acquisitionProperties ?? {}),
        ...context(identity?.path),
        ...properties,
      },
    });
  };

  const currentScrollPct = (): number => {
    if (!browser) return 0;
    const height = Math.max(
      browser.document.documentElement?.scrollHeight ?? 0,
      browser.document.body?.scrollHeight ?? 0,
    );
    const scrollable = Math.max(0, height - browser.innerHeight);
    if (scrollable === 0) return 100;
    return Math.max(0, Math.min(100, Math.round(((browser.scrollY ?? 0) / scrollable) * 100)));
  };

  const updateEngagementClock = () => {
    if (!pageState) return;
    const time = monotonicNow();
    const delta = Math.max(0, Math.min(MAX_FOREGROUND_GAP_MS, time - pageState.lastTickAt));
    if (pageState.foregroundActive) pageState.foregroundMs += delta;
    pageState.lastTickAt = time;
    pageState.maxScrollPct = Math.max(pageState.maxScrollPct, currentScrollPct());
  };

  const flushEngagement = (reason: EngagementReason) => {
    if (!pageState || !collectionAllowed()) return;
    updateEngagementClock();
    pageState.sequence += 1;
    if (lastActivity !== null) {
      lastActivity = now();
      persistSession();
    }
    captureInternal(BROWSER_PAGE_ENGAGEMENT_EVENT, {
      $page_view_id: pageState.pageViewId,
      sequence: pageState.sequence,
      foreground_ms: Math.round(pageState.foregroundMs),
      elapsed_ms: Math.max(0, Math.round(monotonicNow() - pageState.startedAt)),
      max_scroll_pct: pageState.maxScrollPct,
      interaction_count: pageState.interactionCount,
      reason,
    }, {
      actorId: pageState.actorId,
      sessionId: pageState.sessionId,
      path: pageState.path,
    });
  };

  const capture = (event: string, properties: Record<string, unknown> = {}) => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
    for (const key of Object.keys(properties)) {
      if (reserved.has(key)) throw new Error(`property ${key} is reserved by @poolstatis/sdk/browser`);
    }
    ensureActiveSession();
    captureInternal(event, properties);
  };

  const pageViewed = () => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
    const path = currentPagePath();
    if (path === lastPath) return;
    const sessionExpired = !sessionId || lastActivity === null || now() - lastActivity > timeout;
    if (pageState) flushEngagement('route_change');
    if (sessionExpired) rotateSession(now());
    else ensureActiveSession();
    lastPath = path;
    const tick = monotonicNow();
    pageState = {
      pageViewId: `page:${createId()}`,
      path,
      sessionId: sessionId!,
      actorId,
      startedAt: tick,
      lastTickAt: tick,
      foregroundActive: (
        browser.document.visibilityState !== 'hidden'
        && browser.document.visibilityState !== 'prerender'
        && (browser.document.hasFocus?.() ?? true)
      ),
      foregroundMs: 0,
      maxScrollPct: currentScrollPct(),
      interactionCount: 0,
      sequence: 0,
    };
    captureInternal(BROWSER_PAGE_VIEW_EVENT, { $page_view_id: pageState.pageViewId });
  };

  const resumeAfterIdle = (): boolean => {
    if (!sessionId || lastActivity === null || now() - lastActivity <= timeout) return false;
    pageState = null;
    rotateSession(now());
    lastPath = null;
    pageViewed();
    return true;
  };

  const bindNavigation = () => {
    const onNavigation = () => pageViewed();
    const originalPush = browser!.history.pushState;
    const originalReplace = browser!.history.replaceState;
    browser!.history.pushState = function (...args) { originalPush.apply(this, args); onNavigation(); };
    browser!.history.replaceState = function (...args) { originalReplace.apply(this, args); onNavigation(); };
    browser!.addEventListener('popstate', onNavigation);
    restoreHistory = () => {
      if (!browser) return;
      browser.history.pushState = originalPush;
      browser.history.replaceState = originalReplace;
      browser.removeEventListener('popstate', onNavigation);
    };
  };

  const bindEngagement = () => {
    const onVisibility = () => {
      updateEngagementClock();
      if (!pageState || !browser) return;
      const visible = browser.document.visibilityState !== 'hidden'
        && browser.document.visibilityState !== 'prerender';
      if (!visible && pageState.foregroundActive) {
        pageState.foregroundActive = false;
        flushEngagement('visibility_hidden');
        return;
      }
      if (visible && resumeAfterIdle()) return;
      pageState.foregroundActive = visible && (browser.document.hasFocus?.() ?? true);
    };
    const onFocus = () => {
      updateEngagementClock();
      if (resumeAfterIdle()) return;
      if (pageState && browser) {
        pageState.foregroundActive = browser.document.visibilityState !== 'hidden'
          && browser.document.visibilityState !== 'prerender';
      }
    };
    const onBlur = () => {
      updateEngagementClock();
      if (pageState?.foregroundActive) {
        pageState.foregroundActive = false;
        flushEngagement('blur');
      }
    };
    const onScroll = () => {
      if (pageState) pageState.maxScrollPct = Math.max(pageState.maxScrollPct, currentScrollPct());
    };
    const onInteraction = () => {
      if (pageState?.foregroundActive) pageState.interactionCount += 1;
    };
    const onPageHide = () => flushEngagement('pagehide');
    const onFreeze = () => flushEngagement('freeze');
    const timer = browser!.setInterval
      ? browser!.setInterval(() => {
          updateEngagementClock();
          if (pageState?.foregroundActive) flushEngagement('heartbeat');
        }, heartbeatMs)
      : globalThis.setInterval(() => {
          updateEngagementClock();
          if (pageState?.foregroundActive) flushEngagement('heartbeat');
        }, heartbeatMs) as unknown as number;
    browser!.document.addEventListener?.('visibilitychange', onVisibility);
    browser!.addEventListener('focus', onFocus);
    browser!.addEventListener('blur', onBlur);
    browser!.addEventListener('scroll', onScroll);
    browser!.addEventListener('pointerdown', onInteraction);
    browser!.addEventListener('keydown', onInteraction);
    browser!.addEventListener('pagehide', onPageHide);
    browser!.addEventListener('freeze', onFreeze);
    restoreEngagement = () => {
      if (!browser) return;
      if (browser.clearInterval) browser.clearInterval(timer);
      else globalThis.clearInterval(timer);
      browser.document.removeEventListener?.('visibilitychange', onVisibility);
      browser.removeEventListener('focus', onFocus);
      browser.removeEventListener('blur', onBlur);
      browser.removeEventListener('scroll', onScroll);
      browser.removeEventListener('pointerdown', onInteraction);
      browser.removeEventListener('keydown', onInteraction);
      browser.removeEventListener('pagehide', onPageHide);
      browser.removeEventListener('freeze', onFreeze);
    };
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
    track: capture,
    pageViewed,
    identify(userId: string): ActorLinkHandoff {
      if (!visitorId) throw new Error('browser analytics must be started with consent before identify');
      const target = userId.trim();
      if (!target || target.length > 200) throw new Error('user id must be 1..200 characters');
      actorId = target;
      return { source_distinct_id: visitorId, target_distinct_id: target };
    },
    resetIdentity(): void {
      if (!browser) return;
      if (pageState && collectionAllowed()) flushEngagement('destroy');
      pageState = null;
      storageRemove(browser.localStorage, VISITOR_KEY);
      storageRemove(browser.sessionStorage, SESSION_KEY);
      if (!collectionAllowed()) {
        visitorId = null; sessionId = null; actorId = null; lastActivity = null;
        lastPath = null; acquisitionProperties = null;
        return;
      }
      visitorId = `visitor:${createId()}`;
      actorId = visitorId;
      storageSet(browser.localStorage, VISITOR_KEY, visitorId);
      sessionId = null; lastActivity = null;
      lastPath = null; acquisitionProperties = null;
      if (started && collectionAllowed()) rotateSession(now());
      const persistedVisitor = storageGet(browser.localStorage, VISITOR_KEY);
      if (persistedVisitor !== null && persistedVisitor !== visitorId) {
        throw new Error('browser identity rotated in memory but local storage kept a stale visitor; reload only after storage access is restored');
      }
      const persistedSession = storageGet(browser.sessionStorage, SESSION_KEY);
      if (persistedSession !== null) {
        let persistedSessionId: string | null = null;
        try {
          const parsed = JSON.parse(persistedSession) as { id?: unknown };
          persistedSessionId = typeof parsed.id === 'string' ? parsed.id : null;
        } catch { /* malformed storage is stale by definition */ }
        if (persistedSessionId !== sessionId) {
          throw new Error('browser identity rotated in memory but session storage kept a stale session; reload only after storage access is restored');
        }
      }
      if (started && collectionAllowed()) pageViewed();
    },
    get visitorId() { return visitorId; },
    get sessionId() { return sessionId; },
    destroy() {
      if (collectionAllowed()) flushEngagement('destroy');
      restoreHistory?.(); restoreEngagement?.(); stopConsent?.();
      restoreHistory = null; restoreEngagement = null; stopConsent = null;
      pageState = null; started = false;
    },
  };
}
