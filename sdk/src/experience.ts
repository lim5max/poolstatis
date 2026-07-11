import type { ExperienceCaptureBatch, ExperienceCaptureEvent } from './index.js';

export interface BrowserExperienceClient {
  captureExperience(batch: ExperienceCaptureBatch): Promise<void>;
}

export interface BrowserExperienceEnvironment {
  location: { pathname: string };
  innerWidth: number;
  innerHeight: number;
  scrollY: number;
  document: { documentElement: { scrollHeight: number } };
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface BrowserExperienceOptions {
  client: BrowserExperienceClient;
  surface: string;
  /** A stable actor id, or a provider for products whose identity changes after login. */
  distinctId: string | (() => string);
  /** Explicit consent boundary. No listener is attached until this returns true. */
  hasConsent: () => boolean;
  /** Inject only for tests or non-window browser environments. */
  browser?: BrowserExperienceEnvironment;
  /** An opaque session id; generated automatically when omitted. */
  sessionId?: string;
}

const MILESTONES = [25, 50, 75, 100] as const;
const LABEL = /^[a-z][a-z0-9_.:-]*$/;

/**
 * Optional privacy-safe browser observer. It records no DOM, text values,
 * selectors, URL query/hash, stacks or error messages — only labelled
 * interactions associated with a purpose-tagged server surface.
 */
export class BrowserExperience {
  private readonly browser: BrowserExperienceEnvironment;
  private readonly sessionId: string;
  private readonly milestones = new Set<number>();
  private readonly pending: ExperienceCaptureEvent[] = [];
  private sequence = 0;
  private started = false;
  private flushScheduled = false;
  private flushing = false;

  private readonly onClick = (event: { target?: unknown; clientX?: number; clientY?: number }) => {
    const label = labelFor(event.target);
    if (!label) return;
    const width = Math.max(1, this.browser.innerWidth);
    const height = Math.max(1, this.browser.innerHeight);
    this.enqueue({
      kind: 'element_clicked', ...this.common(), label,
      x: clamp((event.clientX ?? 0) / width), y: clamp((event.clientY ?? 0) / height),
    });
  };

  private readonly onScroll = () => {
    const maxScroll = this.browser.document.documentElement.scrollHeight - this.browser.innerHeight;
    const depth = maxScroll <= 0 ? 100 : Math.floor(clamp(this.browser.scrollY / maxScroll) * 100);
    for (const milestone of MILESTONES) {
      if (depth >= milestone && !this.milestones.has(milestone)) {
        this.milestones.add(milestone);
        this.enqueue({ kind: 'scroll_depth', ...this.common(), depth: milestone });
      }
    }
  };

  private readonly onError = () => this.enqueue({ kind: 'client_error', ...this.common(), error_type: 'error' });
  private readonly onUnhandledRejection = () => this.enqueue({ kind: 'client_error', ...this.common(), error_type: 'unhandled_rejection' });

  constructor(private readonly options: BrowserExperienceOptions) {
    const browser = options.browser ?? browserFromGlobal();
    if (!browser) throw new Error('BrowserExperience requires a browser environment — do not construct it during SSR');
    this.browser = browser;
    this.sessionId = options.sessionId ?? opaqueId();
  }

  /** Attach listeners once consent exists and record the initial route. */
  async start(): Promise<void> {
    if (this.started || !this.options.hasConsent()) return;
    this.started = true;
    this.browser.addEventListener('click', this.onClick);
    this.browser.addEventListener('scroll', this.onScroll);
    this.browser.addEventListener('error', this.onError);
    this.browser.addEventListener('unhandledrejection', this.onUnhandledRejection);
    this.enqueue({ kind: 'page_viewed', ...this.common() });
    await this.flush();
  }

  /** Detach observers. Existing queued data is retained for an explicit flush. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.browser.removeEventListener('click', this.onClick);
    this.browser.removeEventListener('scroll', this.onScroll);
    this.browser.removeEventListener('error', this.onError);
    this.browser.removeEventListener('unhandledrejection', this.onUnhandledRejection);
  }

  /** Send pending interaction events. Revoked consent drops queued data. */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    if (!this.options.hasConsent()) { this.pending.splice(0); return; }
    this.flushing = true;
    const events = this.pending.splice(0);
    try {
      await this.options.client.captureExperience({ surface: this.options.surface, events });
    } catch (err) {
      this.pending.unshift(...events);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  private common(): Omit<ExperienceCaptureEvent, 'kind' | 'label' | 'x' | 'y' | 'depth' | 'error_type'> {
    return {
      distinct_id: typeof this.options.distinctId === 'function' ? this.options.distinctId() : this.options.distinctId,
      session_id: this.sessionId,
      route: safePath(this.browser.location.pathname),
      sequence: ++this.sequence,
    } as Omit<ExperienceCaptureEvent, 'kind' | 'label' | 'x' | 'y' | 'depth' | 'error_type'>;
  }

  private enqueue(event: ExperienceCaptureEvent): void {
    if (!this.started || !this.options.hasConsent()) return;
    this.pending.push(event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush().catch(() => {});
    });
  }
}

function labelFor(target: unknown): string | null {
  const closest = target && typeof target === 'object' ? (target as { closest?: (selector: string) => unknown }).closest : undefined;
  const element = closest?.('[data-poolsatis-label]') as { getAttribute?: (name: string) => string | null } | null | undefined;
  const label = element?.getAttribute?.('data-poolsatis-label') ?? null;
  return label && LABEL.test(label) ? label : null;
}

function safePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || '/';
  return path.startsWith('/') ? path : '/';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function opaqueId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.() ?? `experience-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserFromGlobal(): BrowserExperienceEnvironment | null {
  const candidate = globalThis as unknown as Partial<BrowserExperienceEnvironment>;
  return candidate.location && candidate.document && candidate.addEventListener && candidate.removeEventListener
    ? candidate as BrowserExperienceEnvironment
    : null;
}
