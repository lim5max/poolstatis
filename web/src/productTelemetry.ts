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
export type TelemetryTrust = 'trusted' | 'partial' | 'blocked' | 'unavailable';
export type TelemetryControlTowerSurface =
  | 'home' | 'web' | 'product' | 'funnels' | 'people' | 'ship' | 'usage' | 'setup'
  | 'definitions' | 'events' | 'registry' | 'experience' | 'experiments' | 'decisions'
  | 'saved_answers' | 'projects' | 'keys';
export type TelemetryAnswerState =
  | 'ready' | 'partial' | 'empty' | 'unavailable' | 'not_configured' | 'stale' | 'error';
export type TelemetryAttentionRule =
  | 'usage_cap_risk' | 'no_recent_data' | 'event_rejections' | 'tracking_plan_incomplete'
  | 'untrusted_properties' | 'identity_incomplete' | 'source_disconnected' | 'funnel_drop'
  | 'experiment_attention' | 'stale_answer' | 'setup_incomplete';
export type TelemetrySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type TelemetryAgeBucket = 'under_1h' | '1h_to_24h' | '1d_to_7d' | 'over_7d' | 'unknown';
export type TelemetryPrimaryAction =
  | 'open_usage' | 'open_setup' | 'open_web' | 'open_product' | 'open_funnels' | 'open_people'
  | 'open_ship' | 'open_saved_answers' | 'fix_tracking_plan' | 'fix_properties' | 'fix_identity'
  | 'fix_data_source' | 'copy_setup_task' | 'review_evidence' | 'retry' | 'change_scope'
  | 'create_saved_answer' | 'mark_official';
export type TelemetryWarningCountBucket = 'zero' | 'one' | 'two_to_five' | 'over_five';
export type TelemetryTaskCode =
  | 'instrument_events' | 'register_metrics' | 'trust_properties' | 'identify_actors'
  | 'connect_source' | 'connect_mcp' | 'fix_ingest' | 'verify_measurement';
export type TelemetryUsageCapState = 'within_limit' | 'approaching_limit' | 'exceeded' | 'unavailable';
export type TelemetryUsageForecastState = 'on_track' | 'at_risk' | 'exceeded' | 'unavailable';
export type TelemetryThresholdState = 'below' | 'approaching' | 'reached' | 'unavailable';
export type TelemetryRankBucket = 'first' | 'second_to_third' | 'fourth_to_tenth' | 'over_ten';
export type TelemetryShareBucket =
  | 'under_10_percent' | '10_to_25_percent' | '25_to_50_percent' | 'over_50_percent' | 'unknown';
export type TelemetryFunnelLossKind = 'count' | 'conversion_rate' | 'unavailable';
export type TelemetryStepCountBucket = 'two' | 'three' | 'four_to_five' | 'over_five';
export type TelemetrySetupGate =
  | 'create_project' | 'connect_source' | 'register_metrics' | 'receive_event'
  | 'identify_actor' | 'verify_measurement' | 'connect_mcp' | 'complete';
export type TelemetrySavedAnswerTemplate =
  | 'website_overview' | 'product_overview' | 'product_health' | 'product_metric'
  | 'funnel_conversion' | 'funnel_biggest_loss' | 'retention_health' | 'lifecycle_health' | 'custom_query';
export type TelemetryOfficialState = 'official' | 'non_official';
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
  'control_tower.answer_viewed': {
    surface: TelemetryControlTowerSurface; state: TelemetryAnswerState;
    trust: TelemetryTrust; latency_bucket: TelemetryLatencyBucket;
  };
  'control_tower.attention_opened': {
    surface: TelemetryControlTowerSurface; rule_code: TelemetryAttentionRule;
    severity: TelemetrySeverity; age_bucket: TelemetryAgeBucket;
  };
  'control_tower.primary_action_clicked': {
    surface: TelemetryControlTowerSurface; action_code: TelemetryPrimaryAction; state: TelemetryAnswerState;
  };
  'control_tower.evidence_opened': {
    surface: TelemetryControlTowerSurface; trust: TelemetryTrust; warning_count_bucket: TelemetryWarningCountBucket;
  };
  'control_tower.empty_task_copied': {
    surface: TelemetryControlTowerSurface; task_code: TelemetryTaskCode; method: TelemetryCompletionMethod;
  };
  'usage.forecast_viewed': {
    cap_state: TelemetryUsageCapState; forecast_state: TelemetryUsageForecastState;
    threshold_state: TelemetryThresholdState;
  };
  'usage.contributor_opened': { rank_bucket: TelemetryRankBucket; share_bucket: TelemetryShareBucket };
  'funnel.biggest_loss_opened': {
    loss_kind: TelemetryFunnelLossKind; step_count_bucket: TelemetryStepCountBucket; trust: TelemetryTrust;
  };
  'setup.next_gate_opened': { gate_key: TelemetrySetupGate; state: TelemetryAnswerState };
  'saved_answer.created': { template_code: TelemetrySavedAnswerTemplate; official: false };
  'saved_answer.official_changed': {
    template_code: TelemetrySavedAnswerTemplate; next_state: TelemetryOfficialState;
  };
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

export interface ProductTelemetryOnceOptions extends ProductTelemetryOptions {
  idempotencyKey: string;
  persistence?: keyof typeof DEDUPE_STORAGE_KEYS;
}

const ANONYMOUS_ID_KEY = 'poolstatis.telemetry.anonymous_id';
const DEDUPE_STORAGE_KEYS = {
  session: 'poolstatis.telemetry.once.session.v2',
  local: 'poolstatis.telemetry.once.local.v2',
} as const;
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
const TRUST_STATES = new Set<TelemetryTrust>(['trusted', 'partial', 'blocked', 'unavailable']);
const HOME_TEMPLATES = new Set<TelemetryHomeTemplate>([
  'website_overview', 'product_overview', 'both_website', 'both_product', 'legacy_website', 'legacy_product',
]);
const HOME_ACTIONS = new Set<TelemetryHomeAction>([
  'open_web', 'explore_product', 'review_outcomes', 'open_primary_answer',
  'review_identity', 'open_current_answer', 'open_definitions',
]);
const CONTROL_TOWER_SURFACES = new Set<TelemetryControlTowerSurface>([
  'home', 'web', 'product', 'funnels', 'people', 'ship', 'usage', 'setup', 'definitions',
  'events', 'registry', 'experience', 'experiments', 'decisions', 'saved_answers', 'projects', 'keys',
]);
const ANSWER_STATES = new Set<TelemetryAnswerState>([
  'ready', 'partial', 'empty', 'unavailable', 'not_configured', 'stale', 'error',
]);
const ATTENTION_RULES = new Set<TelemetryAttentionRule>([
  'usage_cap_risk', 'no_recent_data', 'event_rejections', 'tracking_plan_incomplete',
  'untrusted_properties', 'identity_incomplete', 'source_disconnected', 'funnel_drop',
  'experiment_attention', 'stale_answer', 'setup_incomplete',
]);
const SEVERITIES = new Set<TelemetrySeverity>(['critical', 'high', 'medium', 'low', 'info']);
const AGE_BUCKETS = new Set<TelemetryAgeBucket>(['under_1h', '1h_to_24h', '1d_to_7d', 'over_7d', 'unknown']);
const PRIMARY_ACTIONS = new Set<TelemetryPrimaryAction>([
  'open_usage', 'open_setup', 'open_web', 'open_product', 'open_funnels', 'open_people', 'open_ship',
  'open_saved_answers', 'fix_tracking_plan', 'fix_properties', 'fix_identity', 'fix_data_source',
  'copy_setup_task', 'review_evidence', 'retry', 'change_scope', 'create_saved_answer', 'mark_official',
]);
const WARNING_COUNT_BUCKETS = new Set<TelemetryWarningCountBucket>(['zero', 'one', 'two_to_five', 'over_five']);
const TASK_CODES = new Set<TelemetryTaskCode>([
  'instrument_events', 'register_metrics', 'trust_properties', 'identify_actors',
  'connect_source', 'connect_mcp', 'fix_ingest', 'verify_measurement',
]);
const USAGE_CAP_STATES = new Set<TelemetryUsageCapState>(['within_limit', 'approaching_limit', 'exceeded', 'unavailable']);
const USAGE_FORECAST_STATES = new Set<TelemetryUsageForecastState>(['on_track', 'at_risk', 'exceeded', 'unavailable']);
const THRESHOLD_STATES = new Set<TelemetryThresholdState>(['below', 'approaching', 'reached', 'unavailable']);
const RANK_BUCKETS = new Set<TelemetryRankBucket>(['first', 'second_to_third', 'fourth_to_tenth', 'over_ten']);
const SHARE_BUCKETS = new Set<TelemetryShareBucket>([
  'under_10_percent', '10_to_25_percent', '25_to_50_percent', 'over_50_percent', 'unknown',
]);
const FUNNEL_LOSS_KINDS = new Set<TelemetryFunnelLossKind>(['count', 'conversion_rate', 'unavailable']);
const STEP_COUNT_BUCKETS = new Set<TelemetryStepCountBucket>(['two', 'three', 'four_to_five', 'over_five']);
const SETUP_GATES = new Set<TelemetrySetupGate>([
  'create_project', 'connect_source', 'register_metrics', 'receive_event',
  'identify_actor', 'verify_measurement', 'connect_mcp', 'complete',
]);
const SAVED_ANSWER_TEMPLATES = new Set<TelemetrySavedAnswerTemplate>([
  'website_overview', 'product_overview', 'product_health', 'product_metric', 'funnel_conversion',
  'funnel_biggest_loss', 'retention_health', 'lifecycle_health', 'custom_query',
]);
const OFFICIAL_STATES = new Set<TelemetryOfficialState>(['official', 'non_official']);
const memoryDedupeKeys = new Set<string>();

export function claimProductTelemetryOnce(
  idempotencyKey: string,
  persistence: keyof typeof DEDUPE_STORAGE_KEYS = 'session',
): boolean {
  const key = idempotencyKey.trim();
  if (!/^[a-z0-9][a-z0-9:._-]{0,239}$/i.test(key)) return false;
  const token = dedupeToken(key);
  const memoryKey = `${persistence}:${token}`;
  try {
    const storage = persistence === 'local' ? window.localStorage : window.sessionStorage;
    const storageKey = DEDUPE_STORAGE_KEYS[persistence];
    const keys = parseDedupeKeys(storage.getItem(storageKey));
    if (keys.includes(token)) return false;
    storage.setItem(storageKey, JSON.stringify([...keys.slice(-(MAX_DEDUPE_KEYS - 1)), token]));
    return true;
  } catch {
    if (memoryDedupeKeys.has(memoryKey)) return false;
    if (memoryDedupeKeys.size >= MAX_DEDUPE_KEYS) {
      const oldest = memoryDedupeKeys.values().next().value as string | undefined;
      if (oldest) memoryDedupeKeys.delete(oldest);
    }
    memoryDedupeKeys.add(memoryKey);
    return true;
  }
}

export function captureProductTelemetryOnce<Name extends ProductTelemetryEventName>(
  capture: CaptureProductTelemetry,
  event: Name,
  properties: ProductTelemetryInputMap[Name],
  options: ProductTelemetryOnceOptions,
): boolean {
  if (!claimProductTelemetryOnce(options.idempotencyKey, options.persistence)) return false;
  capture(event, properties, { distinctId: options.distinctId });
  return true;
}

function dedupeToken(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
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
    case 'control_tower.answer_viewed': {
      const surface = allowed(properties.surface, CONTROL_TOWER_SURFACES);
      const state = allowed(properties.state, ANSWER_STATES);
      const trust = allowed(properties.trust, TRUST_STATES);
      const latencyBucket = allowed(properties.latency_bucket, LATENCY_BUCKETS);
      return surface && state && trust && latencyBucket
        ? { surface, state, trust, latency_bucket: latencyBucket }
        : null;
    }
    case 'control_tower.attention_opened': {
      const surface = allowed(properties.surface, CONTROL_TOWER_SURFACES);
      const ruleCode = allowed(properties.rule_code, ATTENTION_RULES);
      const severity = allowed(properties.severity, SEVERITIES);
      const ageBucket = allowed(properties.age_bucket, AGE_BUCKETS);
      return surface && ruleCode && severity && ageBucket
        ? { surface, rule_code: ruleCode, severity, age_bucket: ageBucket }
        : null;
    }
    case 'control_tower.primary_action_clicked': {
      const surface = allowed(properties.surface, CONTROL_TOWER_SURFACES);
      const actionCode = allowed(properties.action_code, PRIMARY_ACTIONS);
      const state = allowed(properties.state, ANSWER_STATES);
      return surface && actionCode && state ? { surface, action_code: actionCode, state } : null;
    }
    case 'control_tower.evidence_opened': {
      const surface = allowed(properties.surface, CONTROL_TOWER_SURFACES);
      const trust = allowed(properties.trust, TRUST_STATES);
      const warningCountBucket = allowed(properties.warning_count_bucket, WARNING_COUNT_BUCKETS);
      return surface && trust && warningCountBucket
        ? { surface, trust, warning_count_bucket: warningCountBucket }
        : null;
    }
    case 'control_tower.empty_task_copied': {
      const surface = allowed(properties.surface, CONTROL_TOWER_SURFACES);
      const taskCode = allowed(properties.task_code, TASK_CODES);
      const method = allowed(properties.method, COMPLETION_METHODS);
      return surface && taskCode && method ? { surface, task_code: taskCode, method } : null;
    }
    case 'usage.forecast_viewed': {
      const capState = allowed(properties.cap_state, USAGE_CAP_STATES);
      const forecastState = allowed(properties.forecast_state, USAGE_FORECAST_STATES);
      const thresholdState = allowed(properties.threshold_state, THRESHOLD_STATES);
      return capState && forecastState && thresholdState
        ? { cap_state: capState, forecast_state: forecastState, threshold_state: thresholdState }
        : null;
    }
    case 'usage.contributor_opened': {
      const rankBucket = allowed(properties.rank_bucket, RANK_BUCKETS);
      const shareBucket = allowed(properties.share_bucket, SHARE_BUCKETS);
      return rankBucket && shareBucket ? { rank_bucket: rankBucket, share_bucket: shareBucket } : null;
    }
    case 'funnel.biggest_loss_opened': {
      const lossKind = allowed(properties.loss_kind, FUNNEL_LOSS_KINDS);
      const stepCountBucket = allowed(properties.step_count_bucket, STEP_COUNT_BUCKETS);
      const trust = allowed(properties.trust, TRUST_STATES);
      return lossKind && stepCountBucket && trust
        ? { loss_kind: lossKind, step_count_bucket: stepCountBucket, trust }
        : null;
    }
    case 'setup.next_gate_opened': {
      const gateKey = allowed(properties.gate_key, SETUP_GATES);
      const state = allowed(properties.state, ANSWER_STATES);
      return gateKey && state ? { gate_key: gateKey, state } : null;
    }
    case 'saved_answer.created': {
      const templateCode = allowed(properties.template_code, SAVED_ANSWER_TEMPLATES);
      return templateCode && properties.official === false ? { template_code: templateCode, official: false } : null;
    }
    case 'saved_answer.official_changed': {
      const templateCode = allowed(properties.template_code, SAVED_ANSWER_TEMPLATES);
      const nextState = allowed(properties.next_state, OFFICIAL_STATES);
      return templateCode && nextState ? { template_code: templateCode, next_state: nextState } : null;
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
      typeof item === 'string' && /^[a-f0-9]{16}$/.test(item)
    )).slice(-MAX_DEDUPE_KEYS);
  } catch {
    return [];
  }
}
