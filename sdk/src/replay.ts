import type { eventWithTime } from '@rrweb/types';
import {
  assertReplayPolicy,
  rrwebPrivacyOptions,
  sanitizeRecordedEvent,
  type ReplayPrivacyPolicy,
} from './replayPrivacy.js';

export type { ReplayPrivacyPolicy } from './replayPrivacy.js';

export interface ReplayConsent {
  granted: boolean;
  version: string;
}

export interface ReplayRecorderOptions {
  url: string;
  ingestKey: string;
  surface: string;
  route: string | (() => string);
  distinctId: string | (() => string);
  sessionId?: string;
  version?: string;
  consent: ReplayConsent;
  policy: ReplayPrivacyPolicy;
  allowedHosts: string[];
  retentionDays?: number;
  sampleRate?: number;
  fetch?: typeof fetch;
  /** Tests only: inject rrweb's record function without a dynamic import. */
  record?: ReplayRecord;
  browser?: ReplayBrowser;
  onError?: (error: unknown) => void;
}

export interface ReplayBrowser {
  location: { hostname: string };
  innerWidth: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  crypto?: Crypto;
}

type StopRecording = () => void;
export type ReplayRecord = (options: Record<string, unknown>) => StopRecording | undefined;

interface PendingChunk {
  sequence: number;
  checksum: string;
  events: unknown[];
  bytes: number;
}

const MAX_CHUNK_BYTES = 512 * 1024;
// Browser keepalive budgets are commonly shared and approximately 64 KiB.
// Normal chunks stay useful for real DOM snapshots; pagehide attempts only a
// separately measured small request and otherwise leaves the replay incomplete.
const MAX_KEEPALIVE_REQUEST_BYTES = 60 * 1024;
const MAX_CHUNK_EVENTS = 500;
const MAX_QUEUE_BYTES = 5 * 1024 * 1024;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const MAX_SESSION_EVENTS = 50_000;
const MAX_SESSION_CHUNKS = 120;
const MAX_DURATION_MS = 30 * 60 * 1000;
const FLUSH_MS = 10_000;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const SURFACE = /^[a-z][a-z0-9_]{0,119}$/;

export class ReplayRecorder {
  private readonly browser: ReplayBrowser;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (error: unknown) => void;
  private readonly sessionId: string;
  private replayId: string | null = null;
  private uploadToken: string | null = null;
  private stopRecording: StopRecording | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private current: unknown[] = [];
  private currentBytes = 2;
  private pending: PendingChunk[] = [];
  private sequence = 0;
  private acceptedBytes = 0;
  private acceptedEvents = 0;
  private started = false;
  private detached = false;
  private finalized = false;
  private stopInFlight: Promise<void> | null = null;
  private withdrawn = false;
  private starting: Promise<{ sampled: boolean; replayId: string | null }> | null = null;
  private pendingWithdrawal: { replayId: string; uploadToken: string } | null = null;
  private withdrawalInFlight: Promise<void> | null = null;
  private sampled = true;
  private sealing: Promise<void> = Promise.resolve();
  private drainMutex: Promise<void> = Promise.resolve();
  private aborters = new Set<AbortController>();

  private readonly onPageHide = () => { void this.flushInternal(true).catch(this.onError); };

  constructor(private readonly options: ReplayRecorderOptions) {
    const browser = options.browser ?? browserFromGlobal();
    if (!browser) throw new Error('ReplayRecorder requires a browser environment');
    this.browser = browser;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error('ReplayRecorder requires fetch');
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.onError = options.onError ?? (() => {});
    this.sessionId = options.sessionId ?? opaqueId();
  }

  async start(): Promise<{ sampled: boolean; replayId: string | null }> {
    if (this.withdrawn) throw new Error('session replay consent was withdrawn');
    if (this.started) return { sampled: this.sampled, replayId: this.replayId };
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startInternal(): Promise<{ sampled: boolean; replayId: string | null }> {
    this.validateStartPolicy();
    await this.deletePendingManifest();
    const sampleRate = this.options.sampleRate ?? 1;
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error('replay sampleRate must be between 0 and 1');
    this.sampled = sampleRate === 1 || (sampleRate > 0 && Math.random() < sampleRate);
    if (!this.sampled) {
      this.started = true;
      return { sampled: false, replayId: null };
    }

    try {
      const route = this.route();
      const policyHash = await digest(JSON.stringify(normalizedPolicy(this.options.policy)), this.browser.crypto);
      const created = await this.request('/i/v1/replays', 'POST', {
        surface: this.options.surface,
        route,
        session_id: this.sessionId,
        distinct_id: this.distinctId(),
        host: this.browser.location.hostname,
        version: this.options.version ?? 'unversioned',
        device: this.browser.innerWidth < 768 ? 'mobile' : 'desktop',
        consent_version: this.options.consent.version,
        policy: normalizedPolicy(this.options.policy),
        policy_hash: policyHash,
        retention_days: this.options.retentionDays ?? 7,
      }) as { replay?: { id?: unknown }; upload_token?: unknown };
      if (typeof created.replay?.id !== 'string' || typeof created.upload_token !== 'string') {
        throw new Error('replay create response is invalid');
      }
      this.replayId = created.replay.id;
      this.uploadToken = created.upload_token;
      if (this.withdrawn) throw new Error('session replay consent was withdrawn');

      const record = this.options.record ?? (await import('@rrweb/record')).record as ReplayRecord;
      if (this.withdrawn) throw new Error('session replay consent was withdrawn');
      const privacy = rrwebPrivacyOptions(this.options.policy);
      const stop = record({
        emit: (event: eventWithTime) => this.accept(event),
        checkoutEveryNms: 60_000,
        checkoutEveryNth: 10_000,
        sampling: { mousemove: 50, scroll: 100, input: 'last' },
        ...privacy,
        plugins: [],
      });
      if (typeof stop !== 'function') throw new Error('rrweb recorder did not start');
      if (this.withdrawn) {
        stop();
        throw new Error('session replay consent was withdrawn');
      }
      this.stopRecording = stop;
      this.started = true;
      this.browser.addEventListener('pagehide', this.onPageHide);
      this.flushTimer = setInterval(() => { void this.flush(); }, FLUSH_MS);
      this.durationTimer = setTimeout(() => { void this.stop().catch(this.onError); }, MAX_DURATION_MS);
      return { sampled: true, replayId: this.replayId };
    } catch (error) {
      const replayId = this.replayId;
      const uploadToken = this.uploadToken;
      this.stopRecording?.();
      this.stopRecording = null;
      this.replayId = null;
      this.uploadToken = null;
      this.current = [];
      this.currentBytes = 2;
      this.pending = [];
      this.sequence = 0;
      this.sealing = Promise.resolve();
      this.drainMutex = Promise.resolve();
      this.detached = false;
      this.finalized = false;
      this.stopInFlight = null;
      this.acceptedBytes = 0;
      this.acceptedEvents = 0;
      this.started = false;
      if (replayId && uploadToken) {
        this.pendingWithdrawal = { replayId, uploadToken };
        if (!this.withdrawn) await this.deletePendingManifest().catch(() => {});
      }
      throw error;
    }
  }

  async flush(): Promise<void> {
    return this.flushInternal(false);
  }

  private async flushInternal(keepalive: boolean): Promise<void> {
    if (!this.sampled || !this.replayId || !this.uploadToken || this.detached) return;
    this.seal();
    await this.sealing;
    return this.serializeDrain(keepalive);
  }

  async stop(): Promise<void> {
    if (this.finalized) return;
    if (this.stopInFlight) return this.stopInFlight;
    const operation = this.stopInternal();
    this.stopInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.stopInFlight === operation) this.stopInFlight = null;
    }
  }

  private async stopInternal(): Promise<void> {
    const starting = this.starting;
    if (starting) await starting;
    if (!this.started) return;
    this.detach();
    if (!this.sampled || !this.replayId || !this.uploadToken) {
      this.finalized = true;
      return;
    }
    this.seal();
    await this.sealing;
    await this.serializeDrain(false);
    if (this.sequence > 0) {
      await this.requestWithRetry(`/i/v1/replays/${this.replayId}/complete`, 'POST', {
        upload_token: this.uploadToken,
        last_sequence: this.sequence - 1,
      }, false);
    }
    this.finalized = true;
  }

  async withdraw(): Promise<void> {
    this.withdrawn = true;
    if (this.withdrawalInFlight) return this.withdrawalInFlight;
    const operation = this.withdrawInternal();
    this.withdrawalInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.withdrawalInFlight === operation) this.withdrawalInFlight = null;
    }
  }

  private async withdrawInternal(): Promise<void> {
    const starting = this.starting;
    if (starting) await starting.catch(() => {});
    const replayId = this.replayId;
    const uploadToken = this.uploadToken;
    if (replayId && uploadToken) this.pendingWithdrawal = { replayId, uploadToken };
    this.detach();
    this.current = [];
    this.pending = [];
    this.currentBytes = 2;
    this.replayId = null;
    this.uploadToken = null;
    this.started = false;
    for (const aborter of this.aborters) aborter.abort();
    this.aborters.clear();
    await this.deletePendingManifest();
  }

  private async deletePendingManifest(): Promise<void> {
    const pending = this.pendingWithdrawal;
    if (!pending) return;
    await this.requestWithRetry(`/i/v1/replays/${pending.replayId}`, 'DELETE', {
      upload_token: pending.uploadToken,
    }, false);
    if (this.pendingWithdrawal === pending) this.pendingWithdrawal = null;
  }

  private accept(event: eventWithTime): void {
    if (this.detached || this.withdrawn || !this.options.consent.granted) return;
    const safe = sanitizeRecordedEvent(event, this.options.policy, this.route());
    const bytes = new TextEncoder().encode(JSON.stringify(safe)).byteLength + 1;
    if (bytes > MAX_CHUNK_BYTES) return;
    if (this.current.length >= MAX_CHUNK_EVENTS || this.currentBytes + bytes > MAX_CHUNK_BYTES) this.seal();
    if (this.sequence >= MAX_SESSION_CHUNKS
        || this.acceptedEvents >= MAX_SESSION_EVENTS
        || this.acceptedBytes + bytes > MAX_SESSION_BYTES) {
      this.detach();
      void this.stop().catch(this.onError);
      return;
    }
    this.current.push(safe);
    this.currentBytes += bytes;
    this.acceptedBytes += bytes;
    this.acceptedEvents += 1;
    if (this.acceptedEvents >= MAX_SESSION_EVENTS || this.acceptedBytes >= MAX_SESSION_BYTES) {
      this.detach();
      void this.stop().catch(this.onError);
    }
  }

  private seal(): void {
    if (this.current.length === 0) return;
    const events = this.current;
    const sequence = this.sequence++;
    this.current = [];
    this.currentBytes = 2;
    this.sealing = this.sealing.then(async () => {
      const json = JSON.stringify(events);
      const chunk: PendingChunk = {
        sequence,
        checksum: await digest(json, this.browser.crypto),
        events,
        bytes: new TextEncoder().encode(json).byteLength,
      };
      this.pending.push(chunk);
      while (this.pending.reduce((sum, item) => sum + item.bytes, 0) > MAX_QUEUE_BYTES) this.pending.shift();
    });
  }

  private serializeDrain(keepalive: boolean): Promise<void> {
    const operation = this.drainMutex.then(() => this.drain(keepalive));
    this.drainMutex = operation.catch(() => {});
    return operation;
  }

  private async drain(keepalive: boolean): Promise<void> {
    while (this.pending.length > 0) {
      const chunk = this.pending[0]!;
      const body = {
        upload_token: this.uploadToken,
        sequence: chunk.sequence,
        checksum: chunk.checksum,
        events: chunk.events,
      };
      if (keepalive && new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_KEEPALIVE_REQUEST_BYTES) return;
      await this.requestWithRetry(`/i/v1/replays/${this.replayId}/chunks`, 'PUT', body, keepalive);
      this.pending.shift();
      if (keepalive) return;
    }
  }

  private async requestWithRetry(path: string, method: 'PUT' | 'POST' | 'DELETE', body: unknown, keepalive: boolean): Promise<unknown> {
    let last: unknown;
    const attempts = keepalive ? 1 : MAX_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.request(path, method, body, keepalive);
      } catch (error) {
        last = error;
        if (!(error instanceof ReplayTransportError) || !error.retryable || attempt === attempts - 1) break;
        await delay(250 * 2 ** attempt);
      }
    }
    this.onError(last);
    throw last;
  }

  private async request(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    keepalive = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    this.aborters.add(controller);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.options.url.replace(/\/$/, '')}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.options.ingestKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
          keepalive,
        });
      } catch (error) {
        if (timedOut) throw new ReplayTransportError('replay request timed out', true);
        if (error instanceof ReplayTransportError) throw error;
        throw new ReplayTransportError(error instanceof Error ? error.message : 'replay network request failed', true);
      }
      const payload = await response.json().catch(() => null) as { error?: { message?: string; retryable?: boolean } } | null;
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
          || payload?.error?.retryable === true;
        throw new ReplayTransportError(payload?.error?.message ?? `replay request rejected: ${response.status}`, retryable);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      this.aborters.delete(controller);
    }
  }

  private validateStartPolicy(): void {
    if (!this.options.consent.granted || !IDENTIFIER.test(this.options.consent.version)) {
      throw new Error('session replay requires affirmative versioned consent');
    }
    if (!SURFACE.test(this.options.surface)) throw new Error('replay surface must be a stable key');
    if (!IDENTIFIER.test(this.options.version ?? 'unversioned')) throw new Error('replay version must be a stable identifier');
    const retention = this.options.retentionDays ?? 7;
    if (!Number.isInteger(retention) || retention < 1 || retention > 30) throw new Error('replay retentionDays must be between 1 and 30');
    assertReplayPolicy(this.options.policy, this.options.allowedHosts, this.browser.location.hostname, this.route());
  }

  private route(): string {
    return typeof this.options.route === 'function' ? this.options.route() : this.options.route;
  }

  private distinctId(): string {
    const value = typeof this.options.distinctId === 'function' ? this.options.distinctId() : this.options.distinctId;
    if (!value || value.length > 200) throw new Error('replay distinctId must contain between 1 and 200 characters');
    return value;
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.stopRecording?.();
    this.stopRecording = null;
    this.browser.removeEventListener('pagehide', this.onPageHide);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.flushTimer = null;
    this.durationTimer = null;
  }
}

class ReplayTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ReplayTransportError';
  }
}

function normalizedPolicy(policy: ReplayPrivacyPolicy): Required<ReplayPrivacyPolicy> {
  return {
    version: policy.version,
    text: policy.text,
    maskSelectors: policy.maskSelectors ?? [],
    blockSelectors: policy.blockSelectors ?? [],
  };
}

async function digest(value: string, cryptoOverride?: Crypto): Promise<string> {
  const crypto = cryptoOverride ?? globalThis.crypto;
  if (!crypto?.subtle) throw new Error('session replay requires Web Crypto');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function opaqueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `replay-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function browserFromGlobal(): ReplayBrowser | null {
  if (typeof window === 'undefined') return null;
  return window;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
