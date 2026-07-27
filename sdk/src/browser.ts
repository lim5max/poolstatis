import type { PoolstatisEvent } from './index.js';
import {
  ACQUISITION_UTM_KEYS,
  snapshotFromBrowser,
  type AttributionSnapshot,
} from './attribution.js';

export const BROWSER_CONTEXT_VERSION = '1';
export const BROWSER_PAGE_VIEW_EVENT = 'page.viewed';
export const BROWSER_RESERVED_PROPERTIES = [
  '$browser_context', '$page_path', '$device_class', '$browser_family', '$os_family',
  '$language', '$timezone', '$viewport_bucket', '$screen_bucket', '$country',
  ...ACQUISITION_UTM_KEYS, 'landing_path', 'referrer_origin',
] as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type HistoryMethod = (data: unknown, unused: string, url?: string | URL | null) => void;

export interface BrowserLike {
  location: { pathname: string; href: string };
  document: { referrer: string };
  history: { pushState: HistoryMethod; replaceState: HistoryMethod };
  navigator: { userAgent: string; language: string; globalPrivacyControl?: boolean };
  screen: { width: number; height: number };
  innerWidth: number;
  innerHeight: number;
  localStorage: StorageLike;
  sessionStorage: StorageLike;
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
  createId?: () => string;
  sessionTimeoutMs?: number;
  /** Map the pathname to a finite, non-sensitive product route vocabulary. */
  mapPagePath?: (pathname: string) => string;
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
const reserved = new Set<string>(BROWSER_RESERVED_PROPERTIES);

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
  const createId = options.createId ?? randomId;
  const timeout = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
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
  };

  const context = (): Record<string, unknown> => {
    const ua = browser!.navigator.userAgent;
    return {
      $browser_context: BROWSER_CONTEXT_VERSION,
      $page_path: currentPagePath(),
      $device_class: deviceClass(ua),
      $browser_family: browserFamily(ua),
      $os_family: osFamily(ua),
      $language: primaryLanguage(browser!.navigator.language),
      $timezone: timezone(),
      $viewport_bucket: sizeBucket(browser!.innerWidth),
      $screen_bucket: sizeBucket(browser!.screen.width),
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

  const capture = (event: string, properties: Record<string, unknown> = {}) => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
    for (const key of Object.keys(properties)) {
      if (reserved.has(key)) throw new Error(`property ${key} is reserved by @poolstatis/sdk/browser`);
    }
    ensureActiveSession();
    options.client.capture({
      event,
      distinct_id: actorId,
      session_id: sessionId!,
      properties: { ...properties, ...(acquisitionProperties ?? {}), ...context() },
    });
  };

  const pageViewed = () => {
    if (!collectionAllowed() || !browser || !visitorId || !actorId) return;
    ensureActiveSession();
    const path = currentPagePath();
    if (path === lastPath) return;
    lastPath = path;
    capture(BROWSER_PAGE_VIEW_EVENT);
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

  const start = () => {
    if (!collectionAllowed() || started) return;
    browser = resolveBrowser();
    if (!browser) return;
    ensureIdentity();
    started = true;
    bindNavigation();
    pageViewed();
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
    },
    get visitorId() { return visitorId; },
    get sessionId() { return sessionId; },
    destroy() { restoreHistory?.(); stopConsent?.(); restoreHistory = null; stopConsent = null; },
  };
}
