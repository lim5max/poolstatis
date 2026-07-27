import type { PoolstatisEvent } from './index.js';

export const BROWSER_CONTEXT_VERSION = '1';
export const BROWSER_PAGE_VIEW_EVENT = 'page.viewed';
export const BROWSER_RESERVED_PROPERTIES = [
  '$browser_context', '$page_path', '$device_class', '$browser_family', '$os_family',
  '$language', '$timezone', '$viewport_bucket', '$screen_bucket', '$country',
] as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type HistoryMethod = (data: unknown, unused: string, url?: string | URL | null) => void;

export interface BrowserLike {
  location: { pathname: string };
  history: { pushState: HistoryMethod; replaceState: HistoryMethod };
  navigator: { userAgent: string; language: string };
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

export interface BrowserAnalyticsOptions {
  client: BrowserCaptureClient;
  hasConsent: () => boolean;
  subscribeConsent: (listener: () => void) => () => void;
  browser?: BrowserLike;
  now?: () => number;
  createId?: () => string;
  sessionTimeoutMs?: number;
}

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

export function createBrowserAnalytics(options: BrowserAnalyticsOptions) {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomId;
  const timeout = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  let browser: BrowserLike | null = null;
  let visitorId: string | null = null;
  let sessionId: string | null = null;
  let actorId: string | null = null;
  let lastPath: string | null = null;
  let started = false;
  let stopConsent: (() => void) | null = null;
  let restoreHistory: (() => void) | null = null;

  const resolveBrowser = () => options.browser
    ?? ((globalThis as { window?: BrowserLike }).window ?? null);

  const clear = () => {
    options.client.discardQueuedEvents((event) => event.properties?.$browser_context === BROWSER_CONTEXT_VERSION);
    browser?.localStorage.removeItem(VISITOR_KEY);
    browser?.sessionStorage.removeItem(SESSION_KEY);
    visitorId = null; sessionId = null; actorId = null; lastPath = null; started = false;
    restoreHistory?.(); restoreHistory = null;
  };

  const context = (): Record<string, unknown> => {
    const ua = browser!.navigator.userAgent;
    return {
      $browser_context: BROWSER_CONTEXT_VERSION,
      $page_path: boundedPath(browser!.location.pathname),
      $device_class: deviceClass(ua),
      $browser_family: browserFamily(ua),
      $os_family: osFamily(ua),
      $language: (browser!.navigator.language.split('-')[0] || 'unknown').toLowerCase().slice(0, 8),
      $timezone: timezone(),
      $viewport_bucket: sizeBucket(browser!.innerWidth),
      $screen_bucket: sizeBucket(browser!.screen.width),
    };
  };

  const ensureIdentity = () => {
    visitorId = browser!.localStorage.getItem(VISITOR_KEY);
    if (!visitorId) {
      visitorId = `visitor:${createId()}`;
      browser!.localStorage.setItem(VISITOR_KEY, visitorId);
    }
    const raw = browser!.sessionStorage.getItem(SESSION_KEY);
    let saved: { id?: string; last?: number } | null = null;
    try { saved = raw ? JSON.parse(raw) as { id?: string; last?: number } : null; } catch { saved = null; }
    if (!saved?.id || typeof saved.last !== 'number' || now() - saved.last > timeout) {
      sessionId = `session:${createId()}`;
    } else {
      sessionId = saved.id;
    }
    browser!.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionId, last: now() }));
    actorId ??= visitorId;
  };

  const capture = (event: string, properties: Record<string, unknown> = {}) => {
    if (!options.hasConsent() || !browser || !visitorId || !sessionId || !actorId) return;
    for (const key of Object.keys(properties)) {
      if (reserved.has(key)) throw new Error(`property ${key} is reserved by @poolstatis/sdk/browser`);
    }
    browser.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionId, last: now() }));
    options.client.capture({
      event,
      distinct_id: actorId,
      session_id: sessionId,
      properties: { ...properties, ...context() },
    });
  };

  const pageViewed = () => {
    const path = boundedPath(browser!.location.pathname);
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
    if (!options.hasConsent() || started) return;
    browser = resolveBrowser();
    if (!browser) return;
    ensureIdentity();
    started = true;
    bindNavigation();
    pageViewed();
  };

  stopConsent = options.subscribeConsent(() => {
    if (options.hasConsent()) start();
    else clear();
  });

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
    get visitorId() { return visitorId; },
    get sessionId() { return sessionId; },
    destroy() { restoreHistory?.(); stopConsent?.(); restoreHistory = null; stopConsent = null; },
  };
}
