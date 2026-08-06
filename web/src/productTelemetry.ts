export type TelemetryProjectMode = 'website' | 'product' | 'both';
export type TelemetryGoalId =
  | 'website_traffic' | 'website_pages' | 'website_conversion'
  | 'campaigns_referrals' | 'content_engagement' | 'activation'
  | 'feature_adoption' | 'retention' | 'release'
  | 'reliability_performance' | 'custom';
export type TelemetryEnvironment = 'prod' | 'dev' | 'staging' | 'other';
export type TelemetryCompletionMethod = 'clipboard' | 'manual';
export type TelemetryAgentId = 'codex' | 'claude-code' | 'cursor' | 'other';
export type TelemetryTaskSource = 'deterministic' | 'llm' | 'fallback';
export type TelemetryLatencyBucket = 'under_250ms' | '250ms_to_1s' | '1s_to_3s' | 'over_3s';
export type TelemetryElapsedBucket = 'under_1m' | '1m_to_5m' | '5m_to_15m' | '15m_to_1h' | 'over_1h';
export type TelemetryLengthBucket = '10_to_49' | '50_to_149' | '150_to_299' | '300_to_500';
export type TelemetryTrust = 'trusted' | 'partial' | 'unavailable';
export type TelemetryHomeTemplate =
  | 'website_overview' | 'product_overview'
  | 'both_website' | 'both_product'
  | 'legacy_website' | 'legacy_product';
export type TelemetryHomeAction =
  | 'open_web' | 'explore_product' | 'review_outcomes'
  | 'open_primary_answer' | 'review_identity'
  | 'open_current_answer' | 'open_definitions';

export interface ProductTelemetryInputMap {
  'onboarding.mode_selected': { mode: TelemetryProjectMode };
  'onboarding.goals_selected': { goal_ids: TelemetryGoalId[] };
  'onboarding.custom_goal_submitted': { length_bucket: TelemetryLengthBucket };
  'onboarding.key_copied': { environment: TelemetryEnvironment; method: TelemetryCompletionMethod };
  'onboarding.agent_selected': { agent_id: TelemetryAgentId };
  'onboarding.task_generated': { source: TelemetryTaskSource; latency_bucket: TelemetryLatencyBucket };
  'onboarding.task_copied': { agent_id: TelemetryAgentId; method: TelemetryCompletionMethod };
  'onboarding.first_event_received': { elapsed_bucket: TelemetryElapsedBucket };
  'onboarding.completed': { mode: TelemetryProjectMode; goal_ids: TelemetryGoalId[]; elapsed_bucket: TelemetryElapsedBucket };
  'onboarding.blocked': { blocker: string };
  'mcp.connect_started': Record<never, never>;
  'mcp.connected': Record<never, never>;
  'home.answer_viewed': { template_id: TelemetryHomeTemplate; trust: TelemetryTrust };
  'home.next_action_clicked': { action_id: TelemetryHomeAction };
}

export type ProductTelemetryEventName = keyof ProductTelemetryInputMap;

export interface ProductTelemetryOptions {
  distinctId?: string | null;
}

export type CaptureProductTelemetry = <Name extends ProductTelemetryEventName>(
  event: Name,
  properties: ProductTelemetryInputMap[Name],
  options?: ProductTelemetryOptions,
) => void;

export interface ProductTelemetryRuntime {
  telemetryKey?: string;
  apiUrl?: string;
  fetch?: (input: string, init: RequestInit) => Promise<unknown> | unknown;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  uuid?: () => string | null;
}

const ANONYMOUS_ID_KEY = 'poolstatis.telemetry.anonymous_id';
const DEDUPE_STORAGE_KEY = 'poolstatis.telemetry.once.v1';
const MAX_DEDUPE_KEYS = 256;
const INGEST_KEY = /^pk_[a-f0-9]{48}$/i;
const SAFE_ACTOR_ID = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const SAFE_ANONYMOUS_ID = /^anon_[a-z0-9-]{16,80}$/i;
const GOALS = new Set<TelemetryGoalId>([
  'website_traffic', 'website_pages', 'website_conversion',
  'campaigns_referrals', 'content_engagement', 'activation',
  'feature_adoption', 'retention', 'release',
  'reliability_performance', 'custom',
]);
const MODES = new Set<TelemetryProjectMode>(['website', 'product', 'both']);
const ENVIRONMENTS = new Set<TelemetryEnvironment>(['prod', 'dev', 'staging', 'other']);
const COMPLETION_METHODS = new Set<TelemetryCompletionMethod>(['clipboard', 'manual']);
const AGENTS = new Set<TelemetryAgentId>(['codex', 'claude-code', 'cursor', 'other']);
const TASK_SOURCES = new Set<TelemetryTaskSource>(['deterministic', 'llm', 'fallback']);
const LATENCY_BUCKETS = new Set<TelemetryLatencyBucket>(['under_250ms', '250ms_to_1s', '1s_to_3s', 'over_3s']);
const ELAPSED_BUCKETS = new Set<TelemetryElapsedBucket>(['under_1m', '1m_to_5m', '5m_to_15m', '15m_to_1h', 'over_1h']);
const LENGTH_BUCKETS = new Set<TelemetryLengthBucket>(['10_to_49', '50_to_149', '150_to_299', '300_to_500']);
const TRUST_STATES = new Set<TelemetryTrust>(['trusted', 'partial', 'unavailable']);
const HOME_TEMPLATES = new Set<TelemetryHomeTemplate>([
  'website_overview', 'product_overview', 'both_website', 'both_product', 'legacy_website', 'legacy_product',
]);
const HOME_ACTIONS = new Set<TelemetryHomeAction>([
  'open_web', 'explore_product', 'review_outcomes', 'open_primary_answer',
  'review_identity', 'open_current_answer', 'open_definitions',
]);
const memoryDedupeKeys = new Set<string>();

export function claimProductTelemetryOnce(idempotencyKey: string): boolean {
  const key = idempotencyKey.trim();
  if (!/^[a-z0-9][a-z0-9:._-]{0,239}$/i.test(key)) return false;
  try {
    const storage = window.sessionStorage;
    const keys = parseDedupeKeys(storage.getItem(DEDUPE_STORAGE_KEY));
    if (keys.includes(key)) return false;
    storage.setItem(DEDUPE_STORAGE_KEY, JSON.stringify([...keys.slice(-(MAX_DEDUPE_KEYS - 1)), key]));
    return true;
  } catch {
    if (memoryDedupeKeys.has(key)) return false;
    if (memoryDedupeKeys.size >= MAX_DEDUPE_KEYS) {
      const oldest = memoryDedupeKeys.values().next().value as string | undefined;
      if (oldest) memoryDedupeKeys.delete(oldest);
    }
    memoryDedupeKeys.add(key);
    return true;
  }
}

export function createProductTelemetry(runtime: ProductTelemetryRuntime): CaptureProductTelemetry {
  let ephemeralAnonymousId: string | null = null;
  let batchSequence = 0;

  const anonymousId = (): string | null => {
    if (ephemeralAnonymousId) return ephemeralAnonymousId;
    try {
      const stored = runtime.storage?.getItem(ANONYMOUS_ID_KEY);
      if (stored && SAFE_ANONYMOUS_ID.test(stored)) {
        ephemeralAnonymousId = stored;
        return stored;
      }
    } catch {
      // Storage is optional. Keep one page-lifetime id when it is blocked.
    }
    const opaque = runtime.uuid?.();
    if (!opaque || !/^[a-z0-9-]{16,80}$/i.test(opaque)) return null;
    ephemeralAnonymousId = `anon_${opaque}`;
    try { runtime.storage?.setItem(ANONYMOUS_ID_KEY, ephemeralAnonymousId); } catch { /* optional storage */ }
    return ephemeralAnonymousId;
  };

  return ((event, input, options) => {
    const telemetryKey = runtime.telemetryKey?.trim();
    if (!telemetryKey || !INGEST_KEY.test(telemetryKey) || !runtime.fetch) return;
    const properties = sanitizeProperties(event, input);
    if (!properties) return;
    const distinctId = validActorId(options?.distinctId) ?? anonymousId();
    const uuid = runtime.uuid?.();
    if (!distinctId || !uuid || !/^[a-z0-9-]{16,80}$/i.test(uuid)) return;
    batchSequence += 1;
    const body = {
      batch_id: `ui-${uuid}-${batchSequence}`,
      events: [{ event, distinct_id: distinctId, properties }],
    };
    try {
      const request = runtime.fetch(ingestEndpoint(runtime.apiUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${telemetryKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        keepalive: true,
      });
      if (request && typeof (request as Promise<unknown>).catch === 'function') {
        void (request as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Optional telemetry must never affect the product flow.
    }
  }) as CaptureProductTelemetry;
}

export const captureProductTelemetry = createProductTelemetry({
  telemetryKey: import.meta.env.VITE_POOLSTATIS_TELEMETRY_KEY as string | undefined,
  apiUrl: import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined,
  fetch: (input, init) => globalThis.fetch(input, init),
  storage: browserStorage(),
  uuid: secureUuid,
});

export function telemetryEnvironment(value: string | null | undefined): TelemetryEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'prod';
  if (normalized === 'dev' || normalized === 'development') return 'dev';
  if (normalized === 'staging' || normalized === 'stage') return 'staging';
  return 'other';
}

export function telemetryLatencyBucket(milliseconds: number): TelemetryLatencyBucket {
  if (milliseconds < 250) return 'under_250ms';
  if (milliseconds < 1000) return '250ms_to_1s';
  if (milliseconds < 3000) return '1s_to_3s';
  return 'over_3s';
}

export function telemetryElapsedBucket(milliseconds: number): TelemetryElapsedBucket {
  if (milliseconds < 60_000) return 'under_1m';
  if (milliseconds < 300_000) return '1m_to_5m';
  if (milliseconds < 900_000) return '5m_to_15m';
  if (milliseconds < 3_600_000) return '15m_to_1h';
  return 'over_1h';
}

export function telemetryLengthBucket(length: number): TelemetryLengthBucket {
  if (length < 50) return '10_to_49';
  if (length < 150) return '50_to_149';
  if (length < 300) return '150_to_299';
  return '300_to_500';
}

export function normalizeTelemetryCode(value: string): string | null {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
    .replace(/_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(normalized) ? normalized : null;
}

function validActorId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && SAFE_ACTOR_ID.test(normalized) ? normalized : null;
}

function secureUuid(): string | null {
  const value = globalThis.crypto?.randomUUID?.();
  if (value) return value;
  if (!globalThis.crypto?.getRandomValues) return null;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

function ingestEndpoint(apiUrl: string | undefined): string {
  if (!apiUrl) return '/i/v1/events';
  try {
    const parsed = new URL(apiUrl, globalThis.location?.origin ?? 'http://localhost');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '/i/v1/events';
    return `${parsed.origin}/i/v1/events`;
  } catch {
    return '/i/v1/events';
  }
}

function sanitizeProperties(event: ProductTelemetryEventName, input: unknown): Record<string, unknown> | null {
  const properties = isRecord(input) ? input : {};
  switch (event) {
    case 'onboarding.mode_selected': {
      const mode = allowed(properties.mode, MODES);
      return mode ? { mode } : null;
    }
    case 'onboarding.goals_selected': {
      const goalIds = allowedGoals(properties.goal_ids);
      return goalIds ? { goal_ids: goalIds, goal_count: goalIds.length } : null;
    }
    case 'onboarding.custom_goal_submitted': {
      const lengthBucket = allowed(properties.length_bucket, LENGTH_BUCKETS);
      return lengthBucket ? { length_bucket: lengthBucket } : null;
    }
    case 'onboarding.key_copied': {
      const environment = allowed(properties.environment, ENVIRONMENTS);
      const method = allowed(properties.method, COMPLETION_METHODS);
      return environment && method ? { environment, method } : null;
    }
    case 'onboarding.agent_selected': {
      const agentId = allowed(properties.agent_id, AGENTS);
      return agentId ? { agent_id: agentId } : null;
    }
    case 'onboarding.task_generated': {
      const source = allowed(properties.source, TASK_SOURCES);
      const latencyBucket = allowed(properties.latency_bucket, LATENCY_BUCKETS);
      return source && latencyBucket ? { source, latency_bucket: latencyBucket } : null;
    }
    case 'onboarding.task_copied': {
      const agentId = allowed(properties.agent_id, AGENTS);
      const method = allowed(properties.method, COMPLETION_METHODS);
      return agentId && method ? { agent_id: agentId, method } : null;
    }
    case 'onboarding.first_event_received': {
      const elapsedBucket = allowed(properties.elapsed_bucket, ELAPSED_BUCKETS);
      return elapsedBucket ? { elapsed_bucket: elapsedBucket } : null;
    }
    case 'onboarding.completed': {
      const mode = allowed(properties.mode, MODES);
      const goalIds = allowedGoals(properties.goal_ids);
      const elapsedBucket = allowed(properties.elapsed_bucket, ELAPSED_BUCKETS);
      return mode && goalIds && elapsedBucket
        ? { mode, goal_ids: goalIds, goal_count: goalIds.length, elapsed_bucket: elapsedBucket }
        : null;
    }
    case 'onboarding.blocked': {
      const blocker = typeof properties.blocker === 'string' ? normalizeTelemetryCode(properties.blocker) : null;
      return blocker ? { blocker } : null;
    }
    case 'mcp.connect_started':
    case 'mcp.connected':
      return {};
    case 'home.answer_viewed': {
      const templateId = allowed(properties.template_id, HOME_TEMPLATES);
      const trust = allowed(properties.trust, TRUST_STATES);
      return templateId && trust ? { template_id: templateId, trust } : null;
    }
    case 'home.next_action_clicked': {
      const actionId = allowed(properties.action_id, HOME_ACTIONS);
      return actionId ? { action_id: actionId } : null;
    }
    default:
      return null;
  }
}

function allowedGoals(value: unknown): TelemetryGoalId[] | null {
  if (!Array.isArray(value)) return null;
  const goalIds = [...new Set(value.filter((item): item is TelemetryGoalId => typeof item === 'string' && GOALS.has(item as TelemetryGoalId)))].slice(0, 3);
  return goalIds.length > 0 ? goalIds : null;
}

function allowed<Value extends string>(value: unknown, values: Set<Value>): Value | null {
  return typeof value === 'string' && values.has(value as Value) ? value as Value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDedupeKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => (
      typeof item === 'string' && /^[a-z0-9][a-z0-9:._-]{0,239}$/i.test(item)
    )).slice(-MAX_DEDUPE_KEYS);
  } catch {
    return [];
  }
}
