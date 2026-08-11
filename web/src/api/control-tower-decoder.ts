import type {
  AnswerBlock,
  AttentionItem,
  ControlTowerAction,
  ControlTowerResult,
  EvidenceBlock,
  UsageControlResult,
} from './types';

const ANSWER_STATES = new Set(['ready', 'partial', 'empty', 'unavailable', 'not_configured', 'stale', 'error']);
const TRUST_STATES = new Set(['trusted', 'partial', 'blocked', 'unavailable']);
const FRESHNESS_STATES = new Set(['fresh', 'stale', 'unknown']);
const ATTENTION_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const ATTENTION_STATES = new Set(['open', 'acknowledged', 'resolved', 'unavailable']);
const ACTION_KINDS = new Set(['navigate', 'run_typed_query', 'copy_agent_task', 'open_confirmation', 'retry']);
const VALUE_UNITS = new Set(['count', 'percent', 'percentage_point', 'duration_ms', 'date', 'text']);
const DELTA_UNITS = new Set(['count', 'percent', 'percentage_point']);
const DELTA_DIRECTIONS = new Set(['up', 'down', 'flat', 'unknown']);

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  ? value as Record<string, unknown>
  : {};

function unavailableAction(): ControlTowerAction {
  return { id: 'reload_unavailable_contract', kind: 'retry', label: 'Reload' };
}

function decodeAction(value: unknown): ControlTowerAction {
  const action = record(value);
  return typeof action.kind === 'string' && ACTION_KINDS.has(action.kind)
    ? action as unknown as ControlTowerAction
    : unavailableAction();
}

function decodeEvidence(value: unknown, forceUnavailable = false): EvidenceBlock {
  const evidence = record(value);
  const state = !forceUnavailable && typeof evidence.state === 'string' && TRUST_STATES.has(evidence.state)
    ? evidence.state as EvidenceBlock['state']
    : 'unavailable';
  const freshness = typeof evidence.freshness === 'string' && FRESHNESS_STATES.has(evidence.freshness)
    ? evidence.freshness as EvidenceBlock['freshness']
    : 'unknown';
  return {
    ...(evidence as unknown as EvidenceBlock),
    state,
    freshness,
    source_refs: Array.isArray(evidence.source_refs)
      ? evidence.source_refs.filter((source) => {
        const kind = record(source).kind;
        return typeof kind === 'string' && ['metric', 'funnel', 'release', 'experiment', 'usage_ledger', 'operator_rule'].includes(kind);
      }) as EvidenceBlock['source_refs']
      : [],
    warnings: Array.isArray(evidence.warnings) ? evidence.warnings as EvidenceBlock['warnings'] : [],
    unavailable_reasons: Array.isArray(evidence.unavailable_reasons)
      ? evidence.unavailable_reasons as EvidenceBlock['unavailable_reasons']
      : [],
  };
}

function decodeAnswer(value: unknown, forceUnavailable = false): AnswerBlock {
  const answer = record(value);
  const state = !forceUnavailable && typeof answer.state === 'string' && ANSWER_STATES.has(answer.state)
    ? answer.state as AnswerBlock['state']
    : 'unavailable';
  const primary = record(answer.primary_value);
  const delta = record(answer.delta);
  const primaryValue = answer.primary_value === undefined
    ? undefined
    : typeof primary.unit === 'string' && VALUE_UNITS.has(primary.unit)
      ? primary as unknown as NonNullable<AnswerBlock['primary_value']>
      : undefined;
  const decodedDelta = answer.delta === undefined
    ? undefined
    : typeof delta.unit === 'string' && DELTA_UNITS.has(delta.unit)
      && typeof delta.direction === 'string' && DELTA_DIRECTIONS.has(delta.direction)
      ? delta as unknown as NonNullable<AnswerBlock['delta']>
      : undefined;
  return {
    ...(answer as unknown as AnswerBlock),
    state,
    ...(primaryValue ? { primary_value: primaryValue } : { primary_value: undefined }),
    ...(decodedDelta ? { delta: decodedDelta } : { delta: undefined }),
  };
}

function decodeAttention(value: unknown): AttentionItem {
  const item = record(value);
  const severity = typeof item.severity === 'string' && ATTENTION_SEVERITIES.has(item.severity)
    ? item.severity as AttentionItem['severity']
    : 'info';
  const state = typeof item.state === 'string' && ATTENTION_STATES.has(item.state)
    ? item.state as AttentionItem['state']
    : 'unavailable';
  return {
    ...(item as unknown as AttentionItem),
    severity,
    state,
    affected: Array.isArray(item.affected) ? item.affected as AttentionItem['affected'] : [],
    evidence: decodeEvidence(item.evidence),
    primary_action: decodeAction(item.primary_action),
  };
}

export function decodeControlTowerResult(value: unknown, forceUnavailable = false): ControlTowerResult {
  const result = record(value);
  const futureSchema = result.schema_version !== 1;
  const unavailable = forceUnavailable || futureSchema;
  return {
    ...(result as unknown as ControlTowerResult),
    schema_version: 1,
    answer: decodeAnswer(result.answer, unavailable),
    attention: Array.isArray(result.attention) ? result.attention.map(decodeAttention) : [],
    evidence: decodeEvidence(result.evidence, unavailable),
    primary_action: unavailable ? unavailableAction() : decodeAction(result.primary_action),
    secondary_actions: unavailable || !Array.isArray(result.secondary_actions)
      ? []
      : result.secondary_actions.map(decodeAction),
  };
}

export function decodeUsageControlResult(value: unknown): UsageControlResult {
  const result = record(value);
  const cap = record(result.cap);
  const pace = record(result.pace);
  const reconciliation = record(result.reconciliation);
  const thresholds = Array.isArray(result.threshold_forecasts) ? result.threshold_forecasts.map(record) : [];
  const unknownUsageEnum = result.meter !== 'events_stored'
    || !['finite', 'not_configured'].includes(String(cap.state))
    || !['sufficient', 'insufficient'].includes(String(pace.confidence))
    || !['reconciled', 'partial'].includes(String(reconciliation.state))
    || thresholds.some((threshold) => ![50, 75, 90, 100].includes(Number(threshold.percent))
      || !['reached', 'projected', 'not_projected', 'not_applicable'].includes(String(threshold.state))
      || threshold.notification_state !== 'not_configured'
      || threshold.audit_source !== 'usage_ledger');
  const base = decodeControlTowerResult(result, unknownUsageEnum);
  const capKnown = ['finite', 'not_configured'].includes(String(cap.state));

  return {
    ...(result as unknown as UsageControlResult),
    ...base,
    meter: 'events_stored',
    cap: capKnown ? cap as unknown as UsageControlResult['cap'] : {
      state: 'not_configured', value: null, remaining: null, consequence_at_100_percent: null,
    },
    pace: {
      ...(pace as unknown as UsageControlResult['pace']),
      confidence: ['sufficient', 'insufficient'].includes(String(pace.confidence))
        ? pace.confidence as UsageControlResult['pace']['confidence']
        : 'insufficient',
    },
    threshold_forecasts: thresholds
      .filter((threshold) => [50, 75, 90, 100].includes(Number(threshold.percent)))
      .map((threshold) => ({
        ...(threshold as unknown as UsageControlResult['threshold_forecasts'][number]),
        state: ['reached', 'projected', 'not_projected', 'not_applicable'].includes(String(threshold.state))
          ? threshold.state as UsageControlResult['threshold_forecasts'][number]['state']
          : 'not_applicable',
        reached_or_projected_at: ['reached', 'projected'].includes(String(threshold.state))
          && typeof threshold.reached_or_projected_at === 'string'
          ? threshold.reached_or_projected_at
          : null,
        notification_state: 'not_configured',
        audit_source: 'usage_ledger',
      })),
    contributors: Array.isArray(result.contributors)
      ? result.contributors as UsageControlResult['contributors']
      : [],
    reconciliation: {
      ...(reconciliation as unknown as UsageControlResult['reconciliation']),
      state: ['reconciled', 'partial'].includes(String(reconciliation.state))
        ? reconciliation.state as UsageControlResult['reconciliation']['state']
        : 'partial',
    },
  };
}
