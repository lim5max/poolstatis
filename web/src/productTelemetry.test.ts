import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimProductTelemetryOnce,
  createProductTelemetry,
  normalizeTelemetryCode,
  telemetryElapsedBucket,
  telemetryEnvironment,
  telemetryLatencyBucket,
  telemetryLengthBucket,
} from './productTelemetry';

const VALID_KEY = `pk_${'a'.repeat(48)}`;

function runtime(overrides: Record<string, unknown> = {}) {
  let sequence = 0;
  const values = new Map<string, string>();
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
  const uuid = vi.fn(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
  return {
    fetch,
    storage,
    uuid,
    capture: createProductTelemetry({
      telemetryKey: VALID_KEY,
      apiUrl: 'https://api.poolstatis.test/private/path?secret=no',
      fetch,
      storage,
      uuid,
      ...overrides,
    }),
  };
}

function request(fetch: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, any> };
}

describe('optional product telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('emits only the exact typed allowlist and never serializes custom text, tasks, credentials, or URLs', () => {
    const { capture, fetch } = runtime();
    const unsafe = {
      custom_goal: 'raw private goal', task: 'paste this task', key: 'pk_secret_value',
      url: 'https://example.test/private?q=secret', path: '/private', dom_text: 'form contents',
    };
    capture('onboarding.mode_selected', { mode: 'website', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.goals_selected', { goal_ids: ['website_traffic', 'custom', 'not_allowed'], ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.custom_goal_submitted', { length_bucket: '50_to_149', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.key_copied', { environment: 'prod', method: 'manual', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.agent_selected', { agent_id: 'codex', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.task_generated', { source: 'llm', latency_bucket: '250ms_to_1s', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.task_copied', { agent_id: 'codex', method: 'clipboard', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.first_event_received', { elapsed_bucket: '1m_to_5m', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.completed', { mode: 'website', goal_ids: ['website_traffic'], elapsed_bucket: '1m_to_5m', ...unsafe } as never, { distinctId: 'user_123' });
    capture('onboarding.blocked', { blocker: 'First Event-Observed', ...unsafe } as never, { distinctId: 'user_123' });
    capture('mcp.connect_started', unsafe as never, { distinctId: 'user_123' });
    capture('mcp.connected', unsafe as never, { distinctId: 'user_123' });
    capture('home.answer_viewed', { template_id: 'website_overview', trust: 'trusted', ...unsafe } as never, { distinctId: 'user_123' });
    capture('home.next_action_clicked', { action_id: 'open_web', ...unsafe } as never, { distinctId: 'user_123' });

    expect(fetch).toHaveBeenCalledTimes(14);
    expect(Array.from({ length: 14 }, (_, index) => request(fetch, index).body.events[0].properties)).toEqual([
      { mode: 'website' },
      { goal_ids: ['website_traffic', 'custom'], goal_count: 2 },
      { length_bucket: '50_to_149' },
      { environment: 'prod', method: 'manual' },
      { agent_id: 'codex' },
      { source: 'llm', latency_bucket: '250ms_to_1s' },
      { agent_id: 'codex', method: 'clipboard' },
      { elapsed_bucket: '1m_to_5m' },
      { mode: 'website', goal_ids: ['website_traffic'], goal_count: 1, elapsed_bucket: '1m_to_5m' },
      { blocker: 'first_event_observed' },
      {},
      {},
      { template_id: 'website_overview', trust: 'trusted' },
      { action_id: 'open_web' },
    ]);
    const serialized = fetch.mock.calls.map((call) => String((call[1] as RequestInit).body)).join(' ');
    expect(serialized).not.toContain('raw private goal');
    expect(serialized).not.toContain('paste this task');
    expect(serialized).not.toContain('pk_secret_value');
    expect(serialized).not.toContain('example.test');
    expect(serialized).not.toContain('/private');
    expect(serialized).not.toContain('form contents');
  });

  it('uses a configured API origin, keepalive, fresh retry-safe batches, and a stable authenticated id', () => {
    const { capture, fetch } = runtime();
    capture('onboarding.mode_selected', { mode: 'product' }, { distinctId: 'account:user_42' });
    capture('onboarding.agent_selected', { agent_id: 'cursor' }, { distinctId: 'account:user_42' });

    const first = request(fetch, 0);
    const second = request(fetch, 1);
    expect(first.url).toBe('https://api.poolstatis.test/i/v1/events');
    expect(first.init).toMatchObject({ method: 'POST', keepalive: true });
    expect((first.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALID_KEY}`);
    expect(first.body.events[0].distinct_id).toBe('account:user_42');
    expect(second.body.events[0].distinct_id).toBe('account:user_42');
    expect(first.body.batch_id).not.toBe(second.body.batch_id);
  });

  it('persists one opaque anonymous id instead of generating a new actor per event', () => {
    const { capture, fetch, storage, uuid } = runtime();
    capture('onboarding.mode_selected', { mode: 'both' });
    capture('onboarding.agent_selected', { agent_id: 'other' });

    const firstId = request(fetch, 0).body.events[0].distinct_id;
    const secondId = request(fetch, 1).body.events[0].distinct_id;
    expect(firstId).toMatch(/^anon_/);
    expect(secondId).toBe(firstId);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(uuid).toHaveBeenCalledTimes(3); // one actor id plus one fresh id per batch
  });

  it('sends nothing without an exact browser-safe pk_ key or for invalid event values', () => {
    for (const telemetryKey of [undefined, '', 'pk_short', `sk_${'a'.repeat(48)}`, `pk_${'z'.repeat(48)}`]) {
      const fetch = vi.fn();
      const capture = createProductTelemetry({ telemetryKey, fetch, storage: null, uuid: () => '00000000-0000-4000-8000-000000000001' });
      capture('onboarding.mode_selected', { mode: 'website' });
      expect(fetch).not.toHaveBeenCalled();
    }
    const { capture, fetch } = runtime();
    capture('onboarding.goals_selected', { goal_ids: [] });
    capture('onboarding.goals_selected', { goal_ids: ['not_allowed'] } as never);
    capture('onboarding.completed', { mode: 'product', goal_ids: [], elapsed_bucket: 'under_1m' });
    capture('onboarding.key_copied', { environment: 'prod', method: 'other' } as never);
    capture('onboarding.task_copied', { agent_id: 'codex', method: 'other' } as never);
    capture('home.next_action_clicked', { action_id: 'raw private action' } as never);
    capture('unknown.event' as never, { secret: 'value' } as never);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('claims bounded local idempotency keys once per exact project and environment scope', () => {
    expect(claimProductTelemetryOnce('home:alpha:prod:website_overview:trusted')).toBe(true);
    expect(claimProductTelemetryOnce('home:alpha:prod:website_overview:trusted')).toBe(false);
    expect(claimProductTelemetryOnce('home:beta:prod:website_overview:trusted')).toBe(true);
    expect(claimProductTelemetryOnce('home:alpha:dev:website_overview:trusted')).toBe(true);
    expect(claimProductTelemetryOnce('raw project path?q=secret')).toBe(false);
  });

  it('swallows synchronous and asynchronous transport failures', async () => {
    const sync = createProductTelemetry({
      telemetryKey: VALID_KEY, storage: null,
      uuid: () => '00000000-0000-4000-8000-000000000001',
      fetch: () => { throw new Error('offline'); },
    });
    expect(() => sync('mcp.connected', {})).not.toThrow();

    const asyncFailure = vi.fn().mockRejectedValue(new Error('offline'));
    const asyncCapture = createProductTelemetry({
      telemetryKey: VALID_KEY, storage: null,
      uuid: () => '00000000-0000-4000-8000-000000000001',
      fetch: asyncFailure,
    });
    expect(() => asyncCapture('mcp.connected', {}, { distinctId: 'user_1' })).not.toThrow();
    await Promise.resolve();
  });

  it('keeps bucket and normalization helpers bounded', () => {
    expect([telemetryLatencyBucket(20), telemetryLatencyBucket(400), telemetryLatencyBucket(1500), telemetryLatencyBucket(5000)])
      .toEqual(['under_250ms', '250ms_to_1s', '1s_to_3s', 'over_3s']);
    expect([telemetryElapsedBucket(20), telemetryElapsedBucket(60_000), telemetryElapsedBucket(300_000), telemetryElapsedBucket(900_000), telemetryElapsedBucket(3_600_000)])
      .toEqual(['under_1m', '1m_to_5m', '5m_to_15m', '15m_to_1h', 'over_1h']);
    expect([telemetryLengthBucket(10), telemetryLengthBucket(50), telemetryLengthBucket(150), telemetryLengthBucket(300)])
      .toEqual(['10_to_49', '50_to_149', '150_to_299', '300_to_500']);
    expect(['prod', 'production', 'dev', 'development', 'stage', 'staging', 'preview'].map(telemetryEnvironment))
      .toEqual(['prod', 'prod', 'dev', 'dev', 'staging', 'staging', 'other']);
    expect(normalizeTelemetryCode(' First Event-Observed ')).toBe('first_event_observed');
    expect(normalizeTelemetryCode('///')).toBeNull();
  });
});
