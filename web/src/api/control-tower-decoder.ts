import type { ControlTowerAction, ControlTowerResult, UsageControlResult } from './types';

type JsonRecord = Record<string, unknown>;

const ANSWER_STATES = ['ready', 'partial', 'empty', 'unavailable', 'not_configured', 'stale', 'error'] as const;
const TRUST_STATES = ['trusted', 'partial', 'blocked', 'unavailable'] as const;
const FRESHNESS_STATES = ['fresh', 'stale', 'unknown'] as const;
const ATTENTION_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const ATTENTION_STATES = ['open', 'acknowledged', 'resolved', 'unavailable'] as const;
const VALUE_UNITS = ['count', 'percent', 'percentage_point', 'duration_ms', 'date', 'text'] as const;
const DELTA_UNITS = ['count', 'percent', 'percentage_point'] as const;
const DELTA_DIRECTIONS = ['up', 'down', 'flat', 'unknown'] as const;
const AFFECTED_KINDS = ['answer', 'metric', 'funnel', 'project', 'customer'] as const;
const THRESHOLD_STATES = ['reached', 'projected', 'not_projected', 'not_applicable'] as const;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isNonNegativeNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const isNonNegativeInteger = (value: unknown): value is number => isInteger(value) && value >= 0;
const isRatio = (value: unknown): value is number => isFiniteNumber(value) && value >= 0 && value <= 1;
const isNullableNumber = (value: unknown): value is number | null => value === null || isFiniteNumber(value);
const isNullableNonNegativeNumber = (value: unknown): value is number | null => value === null || isNonNegativeNumber(value);
const isNullableRatio = (value: unknown): value is number | null => value === null || isRatio(value);
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const ISO_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const isIsoDate = (value: unknown): value is string => {
  if (!isString(value)) return false;
  const match = ISO_UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const parsed = new Date(canonical);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonical;
};
const inEnum = <T extends readonly string[]>(value: unknown, values: T): value is T[number] => isString(value) && values.includes(value);
const optionalString = (value: unknown) => value === undefined || isString(value);

function isAction(value: unknown): value is ControlTowerAction {
  if (!isRecord(value) || !isString(value.id) || !isString(value.label) || !isString(value.kind)) return false;
  switch (value.kind) {
    case 'navigate': return isString(value.href);
    case 'run_typed_query': return isRecord(value.query);
    case 'copy_agent_task': return isString(value.task);
    case 'open_confirmation': return isString(value.mutation) && isString(value.impact);
    case 'retry': return true;
    default: return false;
  }
}

function isAnswer(value: unknown): boolean {
  if (!isRecord(value) || !inEnum(value.state, ANSWER_STATES)
    || !isString(value.headline) || !isString(value.takeaway) || !isString(value.why_it_matters)) return false;
  if (value.primary_value !== undefined) {
    if (!isRecord(value.primary_value)
      || !(value.primary_value.value === null || isString(value.primary_value.value) || isFiniteNumber(value.primary_value.value))
      || !inEnum(value.primary_value.unit, VALUE_UNITS)
      || !isString(value.primary_value.formatted)) return false;
  }
  if (value.delta !== undefined && !isDelta(value.delta)) return false;
  return true;
}

function isDelta(value: unknown): boolean {
  return isRecord(value) && isNullableNumber(value.value)
    && inEnum(value.unit, DELTA_UNITS)
    && inEnum(value.direction, DELTA_DIRECTIONS)
    && isString(value.comparison_label);
}

function isSourceRef(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case 'metric': return isString(value.key) && isString(value.purpose);
    case 'funnel': return isString(value.key) && isString(value.goal);
    case 'release': return isString(value.id);
    case 'experiment': return isString(value.key);
    case 'usage_ledger': return value.meter === 'events_stored';
    case 'operator_rule': return isString(value.rule_id) && isNonNegativeInteger(value.rule_version);
    default: return false;
  }
}

function isWarning(value: unknown): boolean {
  return isRecord(value) && isString(value.code) && isString(value.message)
    && optionalString(value.remediation_action_id);
}

function isUnavailableReason(value: unknown): boolean {
  return isRecord(value) && isString(value.code) && isString(value.message)
    && optionalString(value.prerequisite_action_id);
}

function isEvidence(value: unknown): boolean {
  if (!isRecord(value) || !inEnum(value.state, TRUST_STATES) || !inEnum(value.freshness, FRESHNESS_STATES)
    || !isIsoDate(value.as_of) || !Array.isArray(value.source_refs) || !value.source_refs.every(isSourceRef)
    || !Array.isArray(value.warnings) || !value.warnings.every(isWarning)
    || !Array.isArray(value.unavailable_reasons) || !value.unavailable_reasons.every(isUnavailableReason)
    || !optionalString(value.aggregation)) return false;
  if (value.denominator !== undefined && (!isRecord(value.denominator)
    || !isString(value.denominator.label) || !isNullableNonNegativeNumber(value.denominator.value))) return false;
  if (value.sample !== undefined && (!isRecord(value.sample)
    || !isNullableNonNegativeNumber(value.sample.eligible)
    || !isNullableNonNegativeNumber(value.sample.observed)
    || !isNullableRatio(value.sample.coverage)
    || (isFiniteNumber(value.sample.eligible) && isFiniteNumber(value.sample.observed)
      && value.sample.observed > value.sample.eligible))) return false;
  return value.reproducible_query === undefined || isRecord(value.reproducible_query);
}

function isAttention(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id) && isString(value.rule_id) && isNonNegativeInteger(value.rule_version)
    && inEnum(value.severity, ATTENTION_SEVERITIES) && inEnum(value.state, ATTENTION_STATES)
    && isString(value.title) && isString(value.reason) && isString(value.impact)
    && Array.isArray(value.affected) && value.affected.every((affected) => isRecord(affected)
      && inEnum(affected.kind, AFFECTED_KINDS) && isString(affected.ref))
    && isEvidence(value.evidence)
    && (value.delta === undefined || isDelta(value.delta))
    && (value.priority === undefined || (isRecord(value.priority)
      && typeof value.priority.blocking_now === 'boolean'
      && isNullableString(value.priority.forecasted_at)
      && (value.priority.forecasted_at === null || isIsoDate(value.priority.forecasted_at))))
    && isAction(value.primary_action);
}

function isWindow(value: unknown): value is ControlTowerResult['scope']['window'] {
  return isRecord(value) && isIsoDate(value.from) && isIsoDate(value.to) && value.timezone === 'UTC'
    && Date.parse(value.from) <= Date.parse(value.to);
}

function isScope(value: unknown): boolean {
  if (!isRecord(value) || !isWindow(value.window)
    || !optionalString(value.organization_id) || !optionalString(value.project_slug) || !optionalString(value.environment)) return false;
  if (value.comparison !== undefined) {
    return isRecord(value.comparison) && isIsoDate(value.comparison.from) && isIsoDate(value.comparison.to)
      && Date.parse(value.comparison.from) <= Date.parse(value.comparison.to)
      && inEnum(value.comparison.basis, ['previous_period', 'previous_cycle', 'none'] as const);
  }
  return true;
}

function isControlTower(value: unknown): value is ControlTowerResult {
  return isRecord(value) && value.schema_version === 1 && isString(value.request_id)
    && isIsoDate(value.generated_at)
    && (value.home_answer_surface === undefined || inEnum(value.home_answer_surface, ['website', 'product', 'legacy'] as const))
    && (value.home_metric_key === undefined || isNullableString(value.home_metric_key))
    && (value.home_funnel_key === undefined || isNullableString(value.home_funnel_key))
    && isScope(value.scope) && isAnswer(value.answer)
    && Array.isArray(value.attention) && value.attention.every(isAttention)
    && isEvidence(value.evidence) && isAction(value.primary_action)
    && Array.isArray(value.secondary_actions) && value.secondary_actions.every(isAction);
}

function unavailableAction(): ControlTowerAction {
  return { id: 'reload_unavailable_contract', kind: 'retry', label: 'Reload' };
}

function unavailableControlTower(headline = 'Answer unavailable'): ControlTowerResult {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    request_id: 'unsupported_response_contract',
    generated_at: now,
    home_answer_surface: 'legacy',
    home_metric_key: null,
    home_funnel_key: null,
    scope: { window: { from: now, to: now, timezone: 'UTC' } },
    answer: {
      state: 'unavailable',
      headline,
      takeaway: 'The server response could not be verified against this client contract.',
      why_it_matters: 'Poolstatis will not present an unknown or malformed response as a successful answer.',
    },
    attention: [],
    evidence: {
      state: 'unavailable',
      as_of: now,
      freshness: 'unknown',
      source_refs: [],
      warnings: [],
      unavailable_reasons: [{
        code: 'unsupported_response_contract',
        message: 'Update the client or retry after the server contract is verified.',
      }],
    },
    primary_action: unavailableAction(),
    secondary_actions: [],
  };
}

export function decodeControlTowerResult(value: unknown): ControlTowerResult {
  return isControlTower(value) ? value : unavailableControlTower();
}

function isContributor(value: unknown): boolean {
  return isRecord(value) && isString(value.project_slug) && isString(value.project_name)
    && isString(value.environment) && isNonNegativeInteger(value.accepted_events)
    && isNullableRatio(value.share) && isNullableNumber(value.change_7d) && isNullableString(value.last_ingest_at)
    && (value.last_ingest_at === null || isIsoDate(value.last_ingest_at));
}

function isThreshold(value: unknown): boolean {
  if (!isRecord(value) || !isFiniteNumber(value.percent) || ![50, 75, 90, 100].includes(value.percent)
    || !inEnum(value.state, THRESHOLD_STATES)
    || !inEnum(value.notification_state, ['not_configured', 'armed', 'recorded'] as const)
    || !inEnum(value.audit_source, ['usage_ledger', 'organization_entitlement', 'usage_warning'] as const)
    || !isNullableNonNegativeNumber(value.configured_threshold)
    || !isNullableString(value.reached_or_projected_at)) return false;
  if (value.notification_state === 'not_configured') {
    if (value.configured_threshold !== null || value.audit_source !== 'usage_ledger') return false;
  } else if (value.configured_threshold === null) return false;
  else if (value.notification_state === 'armed' && value.audit_source !== 'organization_entitlement') return false;
  else if (value.notification_state === 'recorded' && value.audit_source !== 'usage_warning') return false;
  return value.reached_or_projected_at === null || isIsoDate(value.reached_or_projected_at);
}

function isUsageControl(value: unknown): value is UsageControlResult {
  if (!isControlTower(value) || !isRecord(value)) return false;
  const cap = value.cap;
  const pace = value.pace;
  const reconciliation = value.reconciliation;
  return value.meter === 'events_stored' && isWindow(value.cycle)
    && isRecord(cap) && inEnum(cap.state, ['finite', 'not_configured'] as const)
    && isNullableNonNegativeNumber(cap.value) && isNullableNonNegativeNumber(cap.remaining) && isNullableString(cap.consequence_at_100_percent)
    && (cap.state === 'finite'
      ? isNonNegativeNumber(cap.value) && isNonNegativeNumber(cap.remaining) && isString(cap.consequence_at_100_percent)
      : cap.value === null && cap.remaining === null && cap.consequence_at_100_percent === null)
    && isRecord(pace) && isNonNegativeInteger(pace.observed_days) && isNullableNonNegativeNumber(pace.events_per_day_7d)
    && isNullableNonNegativeNumber(pace.projected_cycle_end) && inEnum(pace.confidence, ['sufficient', 'insufficient'] as const)
    && Array.isArray(value.threshold_forecasts) && value.threshold_forecasts.length === 4
    && value.threshold_forecasts.every((threshold, index) => isThreshold(threshold)
      && threshold.percent === [50, 75, 90, 100][index])
    && Array.isArray(value.contributors) && value.contributors.every(isContributor)
    && isRecord(reconciliation) && isNonNegativeInteger(reconciliation.metered_quantity)
    && isNonNegativeInteger(reconciliation.attributed_quantity) && isInteger(reconciliation.difference)
    && isNonNegativeInteger(reconciliation.unattributed_quantity) && isNonNegativeInteger(reconciliation.overattributed_quantity)
    && reconciliation.difference === reconciliation.metered_quantity - reconciliation.attributed_quantity
    && reconciliation.unattributed_quantity === Math.max(0, reconciliation.difference)
    && reconciliation.overattributed_quantity === Math.max(0, -reconciliation.difference)
    && inEnum(reconciliation.state, ['reconciled', 'partial'] as const)
    && reconciliation.state === (reconciliation.difference === 0 ? 'reconciled' : 'partial');
}

function unavailableUsage(): UsageControlResult {
  const base = unavailableControlTower('Usage unavailable');
  return {
    ...base,
    meter: 'events_stored',
    cycle: base.scope.window,
    cap: { state: 'not_configured', value: null, remaining: null, consequence_at_100_percent: null },
    pace: { observed_days: 0, events_per_day_7d: null, projected_cycle_end: null, confidence: 'insufficient' },
    threshold_forecasts: ([50, 75, 90, 100] as const).map((percent) => ({
      percent, state: 'not_applicable', reached_or_projected_at: null,
      configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger',
    })),
    contributors: [],
    reconciliation: {
      metered_quantity: 0, attributed_quantity: 0, difference: 0,
      unattributed_quantity: 0, overattributed_quantity: 0, state: 'partial',
    },
  };
}

export function decodeUsageControlResult(value: unknown): UsageControlResult {
  return isUsageControl(value) ? value : unavailableUsage();
}
