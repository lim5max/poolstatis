import {
  ExperienceCaptureError,
  type ExperienceCaptureBatch,
  type ExperienceCaptureEvent,
  type ExperienceCaptureOptions,
} from './index.js';

export interface BrowserExperienceClient {
  captureExperience(batch: ExperienceCaptureBatch, options?: ExperienceCaptureOptions): Promise<void>;
}

export interface BrowserExperienceEnvironment {
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
  /** A developer-provided safe route key such as `checkout`, never window.location.pathname. */
  route: string | (() => string);
  /** Explicit consent boundary. No listener is attached until this returns true. */
  hasConsent: () => boolean;
  /** Inject only for tests or non-window browser environments. */
  browser?: BrowserExperienceEnvironment;
  /** An opaque session id; generated automatically when omitted. */
  sessionId?: string;
  /** Memory cap across queued/retrying interaction events (default 1,000). */
  maxQueue?: number;
}

const MILESTONES = [25, 50, 75, 100] as const;
const LABEL = /^[a-z][a-z0-9_.:-]*$/;
// Keeps the worst-case JSON body comfortably below the browser's shared
// keepalive budget when the same batch is retried during pagehide.
const MAX_BATCH_EVENTS = 25;
const DEFAULT_MAX_QUEUE = 1_000;
const RETRY_DELAY_MS = 1_000;

/**
 * Optional privacy-safe browser observer. It records no DOM, text values,
 * selectors, raw URLs, stacks or error messages — only labelled interactions
 * associated with a purpose-tagged server surface.
 */
export class BrowserExperience {
  private readonly browser: BrowserExperienceEnvironment;
  private readonly sessionId: string;
  private readonly maxQueue: number;
  private readonly milestones = new Set<number>();
  private readonly pending: ExperienceCaptureEvent[] = [];
  private readonly retryBatches: ExperienceCaptureBatch[] = [];
  private sequence = 0;
  private started = false;
  private flushScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private inFlightBatch: ExperienceCaptureBatch | null = null;

  private readonly onClick = (event: { target?: unknown; clientX?: number; clientY?: number }) => {
    const label = labelFor(event.target);
    if (!label) return;
    const base = this.common();
    if (!base) return;
    const width = Math.max(1, this.browser.innerWidth);
    const height = Math.max(1, this.browser.innerHeight);
    this.enqueue({
      kind: 'element_clicked', ...base, label,
      x: clamp((event.clientX ?? 0) / width), y: clamp((event.clientY ?? 0) / height),
    });
  };

  private readonly onScroll = () => {
    const maxScroll = this.browser.document.documentElement.scrollHeight - this.browser.innerHeight;
    const depth = maxScroll <= 0 ? 100 : Math.floor(clamp(this.browser.scrollY / maxScroll) * 100);
    const newlyReached = MILESTONES.filter((milestone) => depth >= milestone && !this.milestones.has(milestone));
    if (newlyReached.length === 0) return;
    let base = this.common();
    if (!base) return;
    let firstMilestone = true;
    for (const milestone of newlyReached) {
      this.milestones.add(milestone);
      if (!firstMilestone) base = { ...base, sequence: ++this.sequence };
      this.enqueue({ kind: 'scroll_depth', ...base, depth: milestone });
      firstMilestone = false;
    }
  };

  private readonly onError = () => {
    const base = this.common();
    if (base) this.enqueue({ kind: 'client_error', ...base, error_type: 'error' });
  };

  private readonly onUnhandledRejection = () => {
    const base = this.common();
    if (base) this.enqueue({ kind: 'client_error', ...base, error_type: 'unhandled_rejection' });
  };

  private readonly onPageHide = () => {
    void this.flush({ keepalive: true });
  };

  constructor(private readonly options: BrowserExperienceOptions) {
    const browser = options.browser ?? browserFromGlobal();
    if (!browser) throw new Error('BrowserExperience requires a browser environment — do not construct it during SSR');
    this.browser = browser;
    this.sessionId = options.sessionId ?? opaqueId();
    this.maxQueue = Math.max(MAX_BATCH_EVENTS, options.maxQueue ?? DEFAULT_MAX_QUEUE);
  }

  /** Attach listeners once consent exists and record the initial route key. */
  async start(): Promise<void> {
    if (this.started || !this.options.hasConsent()) return;
    this.started = true;
    this.browser.addEventListener('click', this.onClick);
    this.browser.addEventListener('scroll', this.onScroll);
    this.browser.addEventListener('error', this.onError);
    this.browser.addEventListener('unhandledrejection', this.onUnhandledRejection);
    this.browser.addEventListener('pagehide', this.onPageHide);
    const base = this.common();
    if (base) this.enqueue({ kind: 'page_viewed', ...base });
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
    this.browser.removeEventListener('pagehide', this.onPageHide);
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (!this.options.hasConsent()) this.clearQueue();
  }

  /** Send bounded chunks. Consent revocation drops every unsent interaction immediately. */
  async flush(options: ExperienceCaptureOptions = {}): Promise<void> {
    if (!this.options.hasConsent()) { this.clearQueue(); return; }
    if (options.keepalive) {
      // Browsers share a small keepalive body budget across the page. One
      // bounded batch gives the navigation-time interaction the best chance
      // of delivery without flooding that budget with the entire queue.
      const batch = this.inFlightBatch ?? this.nextBatch();
      if (!batch) return;
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      try {
        await this.options.client.captureExperience(batch, { keepalive: true });
      } catch (err) {
        if (batch !== this.inFlightBatch
          && err instanceof ExperienceCaptureError
          && err.retryable
          && this.canRetry(batch)) {
          this.retryBatches.unshift(batch);
        }
      }
      return;
    }
    if (this.flushing) return;
    const explicitWhileStopped = !this.started;
    this.flushing = true;
    try {
      while (true) {
        if (!this.started && !explicitWhileStopped) break;
        const batch = this.nextBatch();
        if (!batch) break;
        try {
          this.inFlightBatch = batch;
          await this.options.client.captureExperience(batch);
        } catch (err) {
          if (err instanceof ExperienceCaptureError && err.retryable && this.canRetry(batch)) {
            this.retryBatches.unshift(batch); // preserves the original batch_id for dedupe
            this.scheduleFlush(RETRY_DELAY_MS);
          }
          // The core client already reports both permanent and exhausted
          // transport failures through onError. Do not retain a bad batch forever.
          break;
        } finally {
          if (this.inFlightBatch === batch) this.inFlightBatch = null;
        }
      }
    } finally {
      this.flushing = false;
      if (this.pending.length > 0 && this.retryBatches.length === 0 && this.options.hasConsent()) this.scheduleFlush();
    }
  }

  private nextBatch(): ExperienceCaptureBatch | null {
    const retry = this.retryBatches.shift();
    if (retry) return retry;
    if (this.pending.length === 0) return null;
    return {
      surface: this.options.surface,
      batch_id: opaqueId(),
      events: this.pending.splice(0, MAX_BATCH_EVENTS),
    };
  }

  private common(): Omit<ExperienceCaptureEvent, 'kind' | 'label' | 'x' | 'y' | 'depth' | 'error_type'> | null {
    const route = typeof this.options.route === 'function' ? this.options.route() : this.options.route;
    if (!LABEL.test(route)) return null;
    return {
      distinct_id: typeof this.options.distinctId === 'function' ? this.options.distinctId() : this.options.distinctId,
      session_id: this.sessionId,
      route,
      sequence: ++this.sequence,
    } as Omit<ExperienceCaptureEvent, 'kind' | 'label' | 'x' | 'y' | 'depth' | 'error_type'>;
  }

  private enqueue(event: ExperienceCaptureEvent): void {
    if (!this.started || !this.options.hasConsent()) return;
    while (this.totalQueuedEvents() >= this.maxQueue) {
      if (this.pending.length > 0) this.pending.shift();
      else this.retryBatches.pop();
    }
    this.pending.push(event);
    this.scheduleFlush();
  }

  private canRetry(batch: ExperienceCaptureBatch): boolean {
    return this.totalQueuedEvents() + batch.events.length <= this.maxQueue;
  }

  private totalQueuedEvents(): number {
    return this.pending.length + this.retryBatches.reduce((total, batch) => total + batch.events.length, 0);
  }

  private scheduleFlush(delay = 0): void {
    if (!this.started) return;
    if (delay > 0) {
      if (this.retryTimer) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.started) void this.flush();
      }, delay);
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.started) void this.flush();
    });
  }

  private clearQueue(): void {
    this.pending.splice(0);
    this.retryBatches.splice(0);
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }
}

const labelAttributes = ['data-poolstatis-label', 'data-poolsatis-label'] as const;
const labelSelector = labelAttributes.map((attribute) => `[${attribute}]`).join(', ');

function labelFor(target: unknown): string | null {
  const element = target && typeof target === 'object'
    ? (target as { closest?: (selector: string) => unknown }).closest?.(labelSelector) as { getAttribute?: (name: string) => string | null } | null | undefined
    : undefined;
  for (const attribute of labelAttributes) {
    const label = element?.getAttribute?.(attribute) ?? null;
    if (label && LABEL.test(label)) return label;
  }
  return null;
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
  return candidate.document && candidate.addEventListener && candidate.removeEventListener
    ? candidate as BrowserExperienceEnvironment
    : null;
}
