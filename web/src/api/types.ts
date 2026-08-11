// Mirrors the Platform API response shapes (src/http/server.ts + services).
import type { AnalysisQueryInput, VisualizationSpec } from '../analysis/visualization';

export type SavedAnswerState = 'ready' | 'partial' | 'empty' | 'unavailable' | 'not_configured' | 'stale' | 'error';
export type SavedAnswerTrust = 'trusted' | 'partial' | 'blocked' | 'unavailable';

export interface SavedAnswerSnapshot {
  state: SavedAnswerState;
  headline: string;
  takeaway: string;
  primary_value?: {
    value: number | string | null;
    unit: 'count' | 'percent' | 'percentage_point' | 'duration_ms' | 'date' | 'text';
    formatted: string;
  };
  delta?: {
    value: number | null;
    unit: 'count' | 'percent' | 'percentage_point';
    direction: 'up' | 'down' | 'flat' | 'unknown';
    comparison_label: string;
  };
  why_it_matters: string;
}

export interface SavedEvidenceSnapshot {
  state: SavedAnswerTrust;
  as_of: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  source_refs: Array<Record<string, unknown>>;
  aggregation?: string;
  denominator?: { label: string; value: number | null };
  sample?: { eligible: number | null; observed: number | null; coverage: number | null };
  warnings: Array<{ code: string; message: string; remediation_action_id?: string }>;
  unavailable_reasons: Array<{ code: string; message: string; prerequisite_action_id?: string }>;
  reproducible_query?: AnalysisQueryInput;
}

export interface SavedAnswer {
  id: string;
  project: string;
  env: string;
  title: string;
  description: string | null;
  template_key: string | null;
  schema_version: 1;
  visualization_spec: VisualizationSpec;
  answer: SavedAnswerSnapshot;
  evidence: SavedEvidenceSnapshot;
  status: 'active' | 'archived';
  official: boolean;
  created_by: { kind: 'secret' | 'personal' | 'user'; role: 'owner' | 'admin' | null };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SavedAnswerAudit {
  id: string;
  action: 'created' | 'updated' | 'official_changed' | 'archived';
  performed_by: { kind: 'secret' | 'personal' | 'user'; role: 'owner' | 'admin' | null };
  schema_version: 1;
  spec_fingerprint: string;
  previous_status: SavedAnswer['status'] | null;
  next_status: SavedAnswer['status'];
  previous_official: boolean | null;
  next_official: boolean;
  created_at: string;
}

export type CreateSavedAnswerInput = Pick<
  SavedAnswer,
  'title' | 'schema_version' | 'visualization_spec' | 'answer' | 'evidence'
> & Partial<Pick<SavedAnswer, 'description' | 'template_key'>>;

export type UpdateSavedAnswerInput = Partial<Pick<
  CreateSavedAnswerInput,
  'title' | 'description' | 'template_key' | 'schema_version' | 'visualization_spec' | 'answer' | 'evidence'
>>;

export type MeasurementReadinessSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'none';
export type MeasurementReadinessGroupKey = 'tracking_plan' | 'properties' | 'identity' | 'data_sources';
export interface MeasurementReadinessRepairAction {
  action_code: 'activate_metric' | 'repair_funnel' | 'review_property' | 'verify_identity' | 'connect_data_source' | 'verify_data_source';
  kind: 'navigate';
  label: string;
  href: string;
}
export interface MeasurementReadinessGap {
  code: 'metric_inactive' | 'funnel_definition_incomplete' | 'property_untrusted'
    | 'identity_evidence_unavailable' | 'identity_coverage_incomplete'
    | 'data_source_missing' | 'data_source_unverified';
  severity: Exclude<MeasurementReadinessSeverity, 'none'>;
  definition_ref: string | null;
  affected_answer_ids: string[];
  repair_action: MeasurementReadinessRepairAction;
}
export interface MeasurementReadinessGroup {
  key: MeasurementReadinessGroupKey;
  label: string;
  healthy_count: number;
  incomplete_count: number;
  highest_severity: MeasurementReadinessSeverity;
  gaps: MeasurementReadinessGap[];
  repair_action: MeasurementReadinessRepairAction | null;
  evidence: Record<string, number>;
}
export interface MeasurementReadiness {
  schema_version: 1;
  generated_at: string;
  project: string;
  env: string;
  summary: {
    healthy_count: number;
    incomplete_count: number;
    highest_severity: MeasurementReadinessSeverity;
  };
  groups: MeasurementReadinessGroup[];
  fix_next: (MeasurementReadinessRepairAction & {
    group: MeasurementReadinessGroupKey;
    gap_code: MeasurementReadinessGap['code'];
    severity: Exclude<MeasurementReadinessSeverity, 'none'>;
    affected_answer_ids: string[];
  }) | null;
}

export type MetricCategory = string;

export interface MetricCategoryDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  domain: 'product' | 'business' | 'technical' | 'custom';
  color: string;
  is_system: boolean;
  metric_count: number;
}

export type MetricType = 'count' | 'unique_actors' | 'value' | 'conversion' | 'state';
export type MetricStatus = 'proposed' | 'active' | 'deprecated';

export interface Metric {
  id: string;
  key: string;
  name: string;
  purpose: string;
  category: MetricCategory | null;
  tags: string[];
  type: MetricType;
  source: Record<string, unknown>;
  status: MetricStatus;
  owner: string | null;
  deprecation_reason: string | null;
  deprecated_at: string | null;
}

export interface FunnelStep {
  metric_key: string;
  label: string;
}

export interface Funnel {
  id: string;
  key: string;
  name: string;
  goal: string;
  steps: FunnelStep[];
  window_seconds: number;
}

export type FeatureFlagStatus = 'draft' | 'active' | 'archived';

export interface FeatureFlagVariant {
  key: string;
  rollout_percentage: number;
  payload?: Record<string, unknown>;
}

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  purpose: string;
  env: string | null;
  status: FeatureFlagStatus;
  salt: string;
  variants: FeatureFlagVariant[];
  created_at: string;
  updated_at: string;
}

export interface NotificationDestination {
  id: string; key: string; name: string; kind: 'in_product' | 'outbox';
  status: 'active' | 'disabled'; created_at: string; updated_at: string;
}

export interface MonitorPolicy {
  id: string; policy_key: string; name: string; current_version: number;
  status: 'active' | 'paused' | 'archived'; next_evaluation_at: string;
  revision: {
    metric_key: string; env: string; comparison_rule: string; threshold: number;
    minimum_sample: number; window_minutes: number; cadence_minutes: number;
    cooldown_seconds: number; owner: string; destination_ids: string[];
    proposal_kind: 'pause' | 'rollback' | null; version: number;
  };
}

export interface InsightFeedSchedule {
  id: string; schedule_key: string; name: string; current_version: number;
  status: 'active' | 'paused' | 'archived'; next_run_at: string;
  revision: {
    metric_key: string; env: string; window_days: number; timezone: string;
    frequency: 'daily' | 'weekly'; local_time: string; weekday: number | null;
    destination_ids: string[]; owner: string; version: number;
  };
}

export interface AutomationProposal {
  id: string; kind: 'pause' | 'rollback'; status: 'proposed' | 'approved' | 'rejected';
  target: Record<string, unknown>; payload: Record<string, unknown>; undo: Record<string, unknown>;
  confirmation_fingerprint: string; proposed_by?: string; reviewed_by?: string | null;
  reviewed_at?: string | null; review_rationale: string | null; created_at: string;
}

export interface MonitorFinding {
  id: string; policy_id: string; policy_key: string; policy_name: string; severity: string;
  snapshot: Record<string, unknown>; evidence: Record<string, unknown>;
  notification_state: 'queued' | 'not_configured'; created_at: string;
}

export interface InsightFeedSnapshot {
  id: string; schedule_id: string; schedule_key: string; schedule_name: string;
  resolved_window: Record<string, unknown>; definition_fingerprint: string;
  answer: { state: string; headline: string; takeaway: string; primary_value?: number };
  evidence: Record<string, unknown>; created_at: string;
}

export interface AutomationInboxNotification {
  id: string; delivery_id: string; payload: {
    kind: string; code: string; answer: { state: string; headline: string; takeaway: string };
    evidence: Record<string, unknown>; action: { kind: string; resource_id: string };
  }; created_at: string;
}

export interface NotificationDelivery {
  id: string; destination_id: string | null; destination_key: string | null;
  destination_kind: 'in_product' | 'outbox' | null; finding_id: string | null; feed_run_id: string | null;
  status: string; attempt_count: number; last_error_code: string | null; created_at: string; updated_at: string;
}

export type ExperimentStatus = 'draft' | 'running' | 'concluded';
export type ExperimentSnapshotIntegrity = 'legacy_unfrozen' | 'backfilled_current' | 'frozen_at_start';

export interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string;
  flag_key: string;
  primary_metric_key: string;
  secondary_metric_keys: string[];
  env: string | null;
  control_variant_key: string | null;
  snapshot_integrity: ExperimentSnapshotIntegrity;
  status: ExperimentStatus;
  started_at: string | null;
  concluded_at: string | null;
  decision: {
    outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive';
    rationale: string;
    ship_variant_key?: string;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentResult {
  key: string;
  status: ExperimentStatus;
  env: string;
  control_variant_key: string | null;
  snapshot_integrity: ExperimentSnapshotIntegrity;
  primary_metric: Pick<Metric, 'key' | 'name' | 'purpose'>;
  started_at: string;
  concluded_at: string | null;
  variants: Array<{
    key: string;
    exposed: number;
    converted: number;
    conversion_rate: number;
    uplift_vs_control: number | null;
    credible_interval: { lower: number; upper: number };
    probability_best: number;
  }>;
  secondary_metrics: Array<{
    metric: Pick<Metric, 'key' | 'name' | 'purpose'>;
    variants: Array<{
      key: string;
      exposed: number;
      converted: number;
      conversion_rate: number;
      uplift_vs_control: number | null;
      credible_interval: { lower: number; upper: number };
      probability_best: number;
    }>;
  }>;
}

export type ExperimentReadinessCheckKey =
  | 'experiment_draft'
  | 'flag_draft'
  | 'environment_match'
  | 'variant_count'
  | 'allocation_complete'
  | 'control_variant'
  | 'primary_metric_distinct'
  | 'metrics_active'
  | 'no_running_experiment';

export interface ExperimentReadiness {
  key: string;
  env: string | null;
  ready: boolean;
  checks: Array<{
    key: ExperimentReadinessCheckKey;
    ready: boolean;
    message: string;
  }>;
}

export interface PreparedExperiment {
  flag: FeatureFlag;
  experiment: Experiment;
  readiness: ExperimentReadiness;
}

export type ExperienceSurfaceStatus = 'active' | 'archived';

export interface ExperienceSurface {
  id: string;
  key: string;
  name: string;
  purpose: string;
  status: ExperienceSurfaceStatus;
  created_at: string;
  updated_at: string;
  last_capture_at?: string | null;
}

export interface ExperienceRoute {
  id: string;
  surface_key: string;
  key: string;
  name: string;
  path_pattern: string;
  created_at: string;
  updated_at: string;
}

export interface ExperienceSnapshot {
  id: string;
  surface_key: string;
  route_key: string;
  env: string;
  version: string;
  device: 'desktop' | 'mobile';
  release_hash: string;
  mime_type: 'image/png' | 'image/webp';
  byte_size: number;
  width: number;
  height: number;
  viewport_width: number;
  viewport_height: number;
  document_width: number;
  document_height: number;
  captured_at: string;
  expires_at: string;
  created_at: string;
  evidence_ref: string;
  stale: boolean;
}

export interface VisualExperienceResponse {
  kind: 'visual_experience';
  surface: Pick<ExperienceSurface, 'key' | 'name' | 'purpose' | 'status'>;
  route: string;
  version: string;
  device: 'desktop' | 'mobile';
  grid: number;
  snapshot: ExperienceSnapshot | null;
  summary: {
    events: number;
    page_views: number;
    sessions: number;
    actors: number;
    clicks: number;
    max_document_width: number;
    max_document_height: number;
  };
  click_cells: Array<{ x: number; y: number; count: number; actors: number }>;
  click_labels: Array<{ label: string; count: number; actors: number }>;
  click_labels_truncated: boolean;
  scroll_coverage: Array<{ depth: number; sessions: number; actors: number; percentage: number }>;
  sections: Array<{
    section: string;
    top: number;
    sessions: number;
    actors: number;
    percentage: number;
    dropoff_percentage: number;
  }>;
  sections_truncated: boolean;
  agent_context: {
    scope: {
      surface: string;
      route: string;
      version: string;
      device: 'desktop' | 'mobile';
      purpose: string;
    };
    sample_size: {
      events: number;
      page_views: number;
      sessions: number;
      actors: number;
      clicks: number;
    };
    section_order: string[];
    largest_section_reach_decreases: Array<{
      from_section: string;
      to_section: string;
      from_sessions: number;
      to_sessions: number;
      session_count_decrease: number;
      percentage_point_decrease: number;
    }>;
    click_concentration: Array<{
      label: string;
      count: number;
      actors: number;
      percentage_of_all_clicks: number;
    }>;
    scroll_reach: Array<{ depth: number; sessions: number; actors: number; percentage: number }>;
    output_coverage: {
      click_labels_returned: number;
      click_labels_truncated: boolean;
      sections_returned: number;
      sections_truncated: boolean;
    };
    snapshot_coverage: {
      status: 'fresh' | 'stale' | 'future' | 'missing';
      exact_viewport_match: boolean;
      snapshot_id: string | null;
      evidence_ref: string | null;
      captured_at: string | null;
      expires_at: string | null;
      age_seconds: number | null;
    };
    evidence_refs: Array<{ type: 'experience_snapshot'; id: string; evidence_ref: string }>;
    data_quality: { status: 'ok' | 'limited' | 'empty'; caveats: string[] };
    suggested_next_actions: Array<{
      action: 'list_versions' | 'compare_explicit_cohorts';
      tool: 'list_visual_experience_versions' | 'compare_visual_experience';
      reason: string;
      known_parameters: Record<string, unknown>;
      requires: string[];
    }>;
  };
  causality: string;
  meta: { computed_at: string; date_range: { from: string; to: string }; note?: string };
}

export interface VisualExperienceCompareResponse {
  kind: 'visual_experience_compare';
  baseline: VisualExperienceResponse;
  comparison: VisualExperienceResponse;
  delta: {
    events: number;
    page_views: number;
    sessions: number;
    clicks: number;
    actors: number;
    sections: Array<{
      section: string;
      baseline_present: boolean;
      comparison_present: boolean;
      percentage_points: number | null;
    }>;
  };
  agent_context: {
    scope: { surface: string; route: string; purpose: string };
    sample_sizes: {
      baseline: VisualExperienceResponse['agent_context']['sample_size'];
      comparison: VisualExperienceResponse['agent_context']['sample_size'];
    };
    largest_section_changes: Array<{
      section: string;
      baseline_percentage: number;
      comparison_percentage: number;
      percentage_points: number;
    }>;
    section_taxonomy_mismatches: Array<{
      section: string;
      baseline_present: boolean;
      comparison_present: boolean;
    }>;
    evidence_refs: Array<{ type: 'experience_snapshot'; id: string; evidence_ref: string }>;
    data_quality: { status: 'ok' | 'limited' | 'empty'; caveats: string[] };
    suggested_next_actions: Array<{
      action: 'inspect_baseline_map' | 'inspect_comparison_map';
      tool: 'get_visual_experience_map';
      reason: string;
      query: Record<string, unknown>;
    }>;
  };
  causality: string;
}

export interface InteractionMapResponse {
  kind: 'interaction_map';
  surface: Pick<ExperienceSurface, 'key' | 'name' | 'purpose' | 'status'>;
  grid: number;
  cells: Array<{ x: number; y: number; count: number; actors: number }>;
  labels: Array<{ label: string; count: number; actors: number }>;
}

export interface TrendResponse {
  kind: 'trend';
  series: Array<{ bucket: string; value: number; breakdown_value?: string }>;
  answer?: AnswerBlock;
  evidence?: EvidenceBlock;
  meta: {
    computed_at: string;
    date_range?: { from: string; to: string };
    sampling: null;
    note?: string;
    source?: 'native' | 'posthog';
  };
}

export type ControlTowerState = 'ready' | 'partial' | 'empty' | 'unavailable' | 'not_configured' | 'stale' | 'error';
export type TrustState = 'trusted' | 'partial' | 'blocked' | 'unavailable';
export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AnswerBlock {
  state: ControlTowerState;
  headline: string;
  takeaway: string;
  primary_value?: {
    value: number | string | null;
    unit: 'count' | 'percent' | 'percentage_point' | 'duration_ms' | 'date' | 'text';
    formatted: string;
  };
  delta?: {
    value: number | null;
    unit: 'count' | 'percent' | 'percentage_point';
    direction: 'up' | 'down' | 'flat' | 'unknown';
    comparison_label: string;
  };
  why_it_matters: string;
}

export interface EvidenceBlock {
  state: TrustState;
  as_of: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  source_refs: Array<
    | { kind: 'metric'; key: string; purpose: string }
    | { kind: 'funnel'; key: string; goal: string }
    | { kind: 'release'; id: string }
    | { kind: 'experiment'; key: string }
    | { kind: 'usage_ledger'; meter: 'events_stored' }
    | { kind: 'operator_rule'; rule_id: string; rule_version: number }
  >;
  aggregation?: string;
  denominator?: { label: string; value: number | null };
  sample?: { eligible: number | null; observed: number | null; coverage: number | null };
  warnings: Array<{ code: string; message: string; remediation_action_id?: string }>;
  unavailable_reasons: Array<{ code: string; message: string; prerequisite_action_id?: string }>;
  reproducible_query?: Record<string, unknown>;
}

export type ControlTowerAction =
  | { id: string; kind: 'navigate'; label: string; href: string }
  | { id: string; kind: 'run_typed_query'; label: string; query: Record<string, unknown> }
  | { id: string; kind: 'copy_agent_task'; label: string; task: string }
  | { id: string; kind: 'open_confirmation'; label: string; mutation: string; impact: string }
  | { id: string; kind: 'retry'; label: string };

export interface AttentionItem {
  id: string;
  rule_id: string;
  rule_version: number;
  severity: AttentionSeverity;
  state: 'open' | 'acknowledged' | 'resolved' | 'unavailable';
  title: string;
  reason: string;
  impact: string;
  affected: Array<{ kind: 'answer' | 'metric' | 'funnel' | 'project' | 'customer'; ref: string }>;
  evidence: EvidenceBlock;
  primary_action: ControlTowerAction;
}

export interface ControlTowerResult {
  schema_version: 1;
  request_id: string;
  generated_at: string;
  scope: {
    organization_id?: string;
    project_slug?: string;
    environment?: string;
    window: { from: string; to: string; timezone: 'UTC' };
    comparison?: { from: string; to: string; basis: 'previous_period' | 'previous_cycle' | 'none' };
  };
  answer: AnswerBlock;
  attention: AttentionItem[];
  evidence: EvidenceBlock;
  primary_action: ControlTowerAction;
  secondary_actions: ControlTowerAction[];
}

export type WebAnalyticsDimension =
  | 'route'
  | 'source'
  | 'medium'
  | 'campaign'
  | 'term'
  | 'content'
  | 'device'
  | 'browser'
  | 'os'
  | 'language'
  | 'timezone'
  | 'country';

export interface WebAnalyticsResponse {
  kind: 'web_analytics';
  summary: {
    visitors: number;
    sessions: number;
    page_views: number;
    average_session_duration_ms: number | null;
  };
  engagement: {
    measured_sessions: number;
    incomplete_sessions: number;
    unknown_sessions: number;
    engaged_sessions: number;
    bounce_sessions: number;
    measured_session_coverage: number | null;
    engaged_rate: number | null;
    bounce_rate: number | null;
    single_page_sessions: number;
    timed_page_views: number;
    total_page_views: number;
    timed_page_coverage: number | null;
    foreground_ms: number;
    session_span_ms: number;
  };
  breakdowns: Partial<Record<WebAnalyticsDimension, Array<{
    value: string;
    visitors: number;
    sessions: number;
    page_views: number;
    percentage: number | null;
  }>>>;
  meta: {
    computed_at: string;
    truncated_dimensions: WebAnalyticsDimension[];
    unavailable_dimensions: Partial<Record<WebAnalyticsDimension, {
      code: string;
      reason: string;
      next_action: string;
    }>>;
    definitions: Record<string, string>;
    accepted_event_accounting: string;
    privacy: string;
  };
}

export interface WebPageEngagement {
  page_view_id: string;
  session_id: string;
  actor_id: string;
  route: string;
  viewed_at: string;
  last_snapshot_at: string | null;
  sequence: number | null;
  foreground_ms: number | null;
  elapsed_ms: number | null;
  max_scroll_pct: number | null;
  interaction_count: number | null;
  reason: string | null;
  timed: boolean;
  complete: boolean;
}

export interface WebSessionSummary {
  session_id: string;
  actor_id: string;
  started_at: string;
  ended_at: string;
  page_views: number;
  timed_page_views: number;
  foreground_ms: number;
  session_span_ms: number;
  engaged: boolean | null;
  bounce: boolean | null;
  single_page: boolean;
  complete: boolean;
}

export interface WebSessionsResponse {
  kind: 'web_sessions';
  sessions: WebSessionSummary[];
  meta: {
    computed_at: string;
    total: number;
    truncated: boolean;
    definitions: { foreground_ms: string; session_span_ms: string; bounce: string };
  };
}

export interface WebSessionResponse {
  kind: 'web_session';
  summary: WebSessionSummary | null;
  pages: WebPageEngagement[];
  meta: {
    computed_at: string;
    no_data_reason?: string;
    privacy: string;
    total_pages: number;
    truncated: boolean;
  };
}

export interface ExperienceSessionResponse {
  kind: 'experience_session';
  surface: Pick<ExperienceSurface, 'key' | 'name' | 'purpose' | 'status'>;
  session_id: string;
  events: Array<{
    timestamp: string;
    kind: 'page_viewed' | 'element_clicked' | 'scroll_depth' | 'section_exposed' | 'client_error';
    route: string;
    sequence: number;
    label?: string;
    x?: number;
    y?: number;
    depth?: number;
    error_type?: 'error' | 'unhandled_rejection';
    section?: string;
    top?: number;
  }>;
  summary: { page_views: number; clicks: number; max_scroll_depth: number; client_errors: number };
}

export interface EntityType {
  name: string;
  description: string;
  prop_schema: unknown;
}

export interface ObservedEvent {
  event: string;
  count: number;
  registered_share: number; // 0..1
  last_seen: string;
}

export interface ProjectWithStats {
  slug: string;
  name: string;
  timezone: string;
  active_metrics: number;
  proposed_metrics: number;
  active_outcome_contracts: number;
  funnels: number;
  events_24h: number;
  events_7d: number;
  events_30d: number;
  last_event_at: string | null;
  registered_coverage_30d: number | null;
  key_outcome_available: boolean;
  health: 'healthy' | 'needs_attention' | 'no_data';
  attention: string[];
  health_evaluation: {
    source: 'server';
    evaluated_at: string;
    guardrails: Array<{
      id: 'recent_data' | 'registered_coverage' | 'active_outcome' | 'metric_review_queue';
      state: 'pass' | 'fail' | 'not_applicable';
      observed: number | null;
      expectation: string;
    }>;
  };
}

export interface ProjectPortfolioRow extends ProjectWithStats {
  environment: string;
  current_usage: {
    meter: 'events_stored';
    period: string;
    accepted_events: number;
    last_ingest_at: string | null;
    source: 'usage_ledger';
    basis: 'ingest_time';
  };
}

export interface ProjectPortfolioResult {
  schema_version: 1;
  generated_at: string;
  scope: {
    credential: 'organization' | 'project';
    environment: string;
    usage_cycle: { from: string; to: string; timezone: 'UTC'; basis: 'ingest_time' };
  };
  projects: ProjectPortfolioRow[];
}

export interface AccountMode {
  schema_version: 1;
  deployment: {
    mode: 'hosted' | 'self_host';
    hosted_account: 'available' | 'not_configured';
  };
  session: {
    kind: KeyKind;
    scope: 'organization' | 'project';
    role: 'owner' | 'admin' | 'member' | null;
  };
  capabilities: {
    portfolio: 'available' | 'project_only' | 'unavailable';
    compare_projects: boolean;
    manage_profile: boolean;
    manage_personal_tokens: boolean;
  };
  primary_action: {
    id: 'manage_hosted_account' | 'sign_in_to_manage_account' | 'open_local_setup';
    kind: 'navigate';
    label: string;
    href: string;
  };
}

export interface MetricSemanticDefinition {
  key: string;
  purpose: string;
  type: MetricType;
  aggregation: string;
  source: Record<string, unknown>;
}

export interface MetricDefinitionCurrent {
  revision: number;
  fingerprint: string;
  aggregation: string;
  definition: MetricSemanticDefinition;
}

export interface MetricDefinitionRevision extends MetricDefinitionCurrent {
  id: string;
  action: 'created' | 'updated' | 'legacy_update';
  actor: string;
  created_at: string;
}

export interface MetricDefinitionImpact {
  severity: 'low' | 'medium' | 'high';
  summary: {
    answers: number;
    funnels: number;
    measurement_contracts: number;
    releases: number;
    experiments: number;
  };
  references: Array<{
    kind: 'answer' | 'funnel' | 'measurement_contract' | 'release' | 'experiment';
    ref: string;
    label: string;
    status: string | null;
  }>;
  truncated: boolean;
}

export interface MetricDefinitionDetail {
  schema_version: 1;
  metric: Pick<Metric, 'key' | 'name' | 'type' | 'status'>;
  current: MetricDefinitionCurrent;
  revisions: MetricDefinitionRevision[];
  impact: MetricDefinitionImpact;
  primary_action: { id: string; kind: 'navigate'; label: string; href: string };
}

export interface MetricDefinitionPreview {
  schema_version: 1;
  state: 'ready' | 'empty';
  metric: Pick<Metric, 'key' | 'name' | 'type' | 'status'>;
  expected_revision: number;
  current: MetricDefinitionCurrent;
  proposed: Omit<MetricDefinitionCurrent, 'revision'>;
  changed_fields: Array<'purpose' | 'source'>;
  impact: MetricDefinitionImpact;
  requires_confirmation: boolean;
  primary_action:
    | { id: 'apply_metric_definition'; kind: 'open_confirmation'; label: string; impact: string }
    | { id: 'return_to_registry'; kind: 'navigate'; label: string; href: string };
}

export interface SemanticProjectComparison {
  schema_version: 1;
  state: 'ready' | 'unavailable';
  generated_at: string;
  metric: {
    key: string;
    purpose: string | null;
    type: string | null;
    aggregation: string | null;
    fingerprint: string | null;
  };
  scope: {
    environment: string;
    window: { from: string; to: string; timezone: 'UTC' };
  };
  projects: Array<{
    slug: string;
    name: string;
    fingerprint: string | null;
    value?: number;
    events?: number;
    actors?: number;
    registered_coverage?: number;
  }>;
  incompatibilities: Array<{
    project_slug: string;
    code: string;
    message: string;
  }>;
  primary_action: { id: string; kind: 'navigate'; label: string; href: string };
}

export interface ProjectSchema {
  project: { slug: string; name: string };
  env: string;
  metrics: Metric[];
  metric_categories: MetricCategoryDefinition[];
  funnels: Funnel[];
  entity_types: EntityType[];
  observed_events_30d: ObservedEvent[];
  properties: PropertyDefinition[];
  identity: { active_links: number; linked_sources: number; audit_entries: number };
  sources: SourceConnection[];
}

export interface ActorLink {
  id: string;
  env: string;
  source_distinct_id: string;
  target_distinct_id: string;
  status: 'active' | 'revoked';
  created_by: string;
  created_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
}

export interface ActorLinkAudit {
  id: string;
  actor_link_id: string;
  action: 'created' | 'revoked';
  actor: string;
  snapshot: ActorLink;
  created_at: string;
}

export interface PropertyDefinition {
  id: string;
  key: string;
  scope: 'event' | 'actor' | 'entity';
  value_type: 'string' | 'number' | 'boolean' | 'datetime' | 'enum';
  purpose: string;
  status: 'proposed' | 'trusted' | 'untrusted';
  source: 'native' | 'posthog';
  source_connection_id: string | null;
  enum_values: string[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SourceConnection {
  id: string;
  provider: 'posthog';
  name: string;
  host: string;
  external_project_id: string;
  status: 'configured' | 'verified' | 'error' | 'disabled';
  capabilities: Record<string, boolean>;
  last_error: string | null;
  verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TrustFinding {
  code: string;
  message: string;
  next_action: string;
}

export interface MeasurementTrust {
  status: 'trusted' | 'untrusted';
  primary_metric: {
    key: string;
    purpose: string;
    category: string | null;
    observed_events: number;
    observed_actors: number;
    registered_coverage: number;
  };
  identity: { distinct_id_coverage: number; raw_actors: number; resolved_actors: number };
  properties: Array<{
    key: string;
    status: 'missing' | PropertyDefinition['status'];
    purpose: string | null;
    coverage: number;
  }>;
  blockers: TrustFinding[];
  warnings: TrustFinding[];
}

export type OnboardingGateKey =
  | 'workspace_created' | 'agent_connected' | 'data_source_connected'
  | 'first_event_observed' | 'metrics_activated' | 'data_quality_accepted'
  | 'first_query_produced' | 'first_decision_saved';

export interface OnboardingGate {
  key: OnboardingGateKey;
  complete: boolean;
  required: boolean;
  evidence: Record<string, unknown>;
  blocker: string | null;
  next_action: string | null;
}

export interface DecisionLoopOnboardingStatus {
  complete: boolean;
  gates: OnboardingGate[];
  next_blocker: OnboardingGate | null;
  final_result: {
    metric_key: string;
    metric_purpose: string;
    query_window: { from: string; to: string };
    source: 'native' | 'posthog';
    next_action: string;
  } | null;
}

export type ContractDirection = 'increase' | 'decrease' | 'stay_within_range';
export interface MeasurementContract {
  id: string;
  key: string;
  name: string;
  business_hypothesis: string;
  decision_owner: string;
  primary_metric_key: string;
  guardrail_metric_keys: string[];
  target_filters: SampleFilter[];
  baseline_window_days: number;
  observation_window_days: number;
  minimum_sample_size: number;
  expected_direction: ContractDirection;
  minimum_meaningful_effect?: number;
  flag_key?: string;
  experiment_key?: string;
  references: Record<string, string>;
  status: 'draft' | 'active' | 'archived';
  revision: number;
  declaration_hash: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type ReleaseStatus = 'planned' | 'deployed' | 'observing' | 'decided' | 'cancelled';
export interface Release {
  id: string;
  contract_id: string;
  contract_key: string;
  contract_revision: number;
  contract_snapshot: Omit<MeasurementContract, 'id' | 'revision' | 'declaration_hash' | 'created_by' | 'created_at' | 'updated_at'>;
  env: string;
  repository: string;
  branch: string | null;
  commit_sha: string;
  pr_url: string | null;
  deployed_at: string | null;
  flag_key: string | null;
  experiment_key: string | null;
  variant: string | null;
  originating_decision_id: string | null;
  status: ReleaseStatus;
  idempotency_key: string;
  evaluation_attempts: number;
  next_evaluation_at: string | null;
  retry_state: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type DecisionOutcome = 'keep' | 'fix' | 'rollback' | 'inconclusive';
export interface Decision {
  id: string;
  release_id: string;
  contract_id: string;
  evidence_id: string;
  status: 'proposed' | 'approved' | 'rejected';
  proposed_outcome: DecisionOutcome;
  proposed_rationale: string;
  accepted_outcome: DecisionOutcome | null;
  accepted_rationale: string | null;
  current_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  queue_priority?: {
    evidence_readiness: 'ready' | 'blocked';
    risk: 'high' | 'medium' | 'low';
  };
}

export interface EvidenceMetricWindow {
  metric: { key: string; name: string; purpose: string; category: string | null; type: string };
  source: 'native' | 'posthog';
  baseline: { value: number; events: number; actors: number; registeredCoverage: number; distinctIdCoverage: number; propertyCoverage: Record<string, number> };
  observed: { value: number; events: number; actors: number; registeredCoverage: number; distinctIdCoverage: number; propertyCoverage: Record<string, number> };
  change: { absolute: number; relative: number | null };
}

export interface EvidenceSet {
  id: string;
  release_id: string;
  contract_id: string;
  evaluated_at: string;
  source: 'native' | 'posthog';
  baseline_window: { from: string; to: string };
  observed_window: { from: string; to: string };
  primary_evidence: EvidenceMetricWindow;
  guardrail_evidence: EvidenceMetricWindow[];
  trust: { status: 'trusted' | 'untrusted'; registered_coverage: number; distinct_id_coverage: number; property_coverage: Record<string, number>; warnings: TrustFinding[] };
  query_specs: Record<string, unknown>;
  facts: Record<string, unknown>;
  sample_size: number;
  ready: boolean;
  blockers: TrustFinding[];
  evidence_key: string;
  created_at: string;
}

export interface DecisionRevision {
  id: string;
  revision: number;
  action: 'proposed' | 'approved' | 'edited' | 'rejected';
  actor: string;
  previous_snapshot: Decision | null;
  snapshot: Decision;
  rationale: string;
  created_at: string;
}

export interface DecisionDetail {
  decision: Decision;
  evidence: EvidenceSet;
  revisions: DecisionRevision[];
  release: Release;
  contract: Release['contract_snapshot'] & { revision: number };
}

export interface ExplanationCandidate {
  kind: 'metric' | 'property';
  key: string;
  purpose: string;
  measured_movement: number | null;
  score: number;
  strength: 'strong' | 'medium' | 'weak';
  why_considered: string;
  supporting_query: { baseline: Record<string, unknown>; observed: Record<string, unknown> };
  interpretation: 'hypothesis';
}

export interface DecisionExplanation {
  id: string;
  decision_id: string;
  evidence_id: string;
  algorithm_version: string;
  explanation_key: string;
  label: 'hypothesis';
  candidates: ExplanationCandidate[];
  omitted: Array<{ key: string; reason: string }>;
  created_by: string;
  created_at: string;
}

export type DecisionActionType = 'draft_implementation_prompt' | 'prepare_flag_rollback' | 'schedule_observation' | 'request_more_data' | 'generic_webhook' | 'create_issue' | 'open_draft_pr';
export interface DecisionAction {
  id: string;
  decision_id: string;
  release_id: string;
  evidence_id: string;
  decision_revision: number;
  action_type: DecisionActionType;
  status: 'prepared' | 'approved' | 'executed' | 'rejected' | 'failed';
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  expected_effect: string;
  undo: Record<string, unknown>;
  confirmation_fingerprint: string;
  idempotency_key: string;
  prepared_by: string;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
export interface DecisionActionDetail {
  action: DecisionAction;
  audit: Array<{ id: string; event: string; actor: string; snapshot: DecisionAction; created_at: string }>;
}

export interface DecisionInboxItem {
  decision_id: string;
  release_id: string;
  state: 'needs_attention' | 'waiting_for_data' | 'approved' | 'rejected' | 'resolved';
  impact: { outcome: DecisionOutcome; metric_key: string; metric_purpose: string; relative_change: number | null; trust: 'trusted' | 'untrusted' };
  blocker: TrustFinding | null;
  requested_choice: string | null;
  contract_key: string;
  commit_sha: string;
  env: string;
  updated_at: string;
}

export interface WebhookDestination {
  id: string; name: string; masked_url: string;
  status: 'configured' | 'verified' | 'error' | 'disabled';
  last_error: string | null; verified_at: string | null;
  created_by: string; created_at: string; updated_at: string;
}
export interface WebhookDelivery {
  id: string; destination_id: string; action_id: string | null; event_type: string;
  payload: Record<string, unknown>; idempotency_key: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead';
  attempt_count: number; next_attempt_at: string; delivered_at: string | null;
  last_error: string | null; created_at: string; updated_at: string;
  attempts: Array<{ attempt: number; status: 'delivered' | 'failed'; response_status: number | null; error_code: string | null; error_message: string | null; created_at: string }>;
}

export interface DecisionHistoryItem {
  decision_id: string; release_id: string; contract_key: string; contract_revision: number;
  primary_metric_key: string; guardrail_metric_keys: string[]; decision_owner: string;
  hypothesis: string; proposed_outcome: DecisionOutcome; proposed_rationale: string;
  accepted_outcome: DecisionOutcome | null; accepted_rationale: string | null;
  status: Decision['status']; proposal_disagreed: boolean;
  evidence_quality: { ready: boolean; trust: string; sample_size: number; blockers: number };
  stale: boolean; stale_reasons: string[]; created_at: string;
}

export interface SampleEvent {
  id: string;
  event: string;
  timestamp: string;
  distinct_id: string;
  session_id: string | null;
  properties: Record<string, unknown>;
  registered: boolean;
  env: string;
  revision: number;
  origin: 'live' | 'backfill';
  backfill_batch_id: string | null;
  ingested_at: string;
  editable: boolean;
}

export interface EventRevisionPatch {
  event?: string;
  timestamp?: string;
  distinct_id?: string;
  session_id?: string | null;
  set_properties?: Record<string, unknown>;
  unset_properties?: string[];
}

export interface EventRevisionPreview {
  event_id: string;
  expected_revision: number;
  preview_sha256: string;
  changed_fields: string[];
  before: SampleEvent;
  after: SampleEvent;
}

export interface EventRevision {
  id: string;
  event_id: string;
  revision: number;
  actor: string;
  reason: string;
  previous_snapshot: SampleEvent;
  snapshot: SampleEvent;
  created_at: string;
}

export interface BackfillPreview {
  valid: boolean;
  payload_sha256: string | null;
  event_count: number;
  registered_count: number;
  unregistered_count: number;
  min_timestamp: string | null;
  max_timestamp: string | null;
  errors: Array<{ index: number; message: string }>;
}

export interface BackfillRecord {
  id: string;
  env: string;
  batch_id: string;
  payload_sha256: string;
  reason: string;
  actor: string;
  event_count: number;
  registered_count: number;
  unregistered_count: number;
  min_timestamp: string;
  max_timestamp: string;
  created_at: string;
}

export interface EntityRow {
  entity_id: string;
  properties: Record<string, unknown>;
  updated_at: string;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'is_set' | 'is_not_set';
export interface SampleFilter {
  property: string;
  op: FilterOp;
  value?: string | number | Array<string | number>;
}

export interface IngestWarning {
  signature_id?: string;
  kind: 'rejected' | 'unregistered' | 'clock_skew';
  event: string;
  detail: string;
  sample: unknown;
  count: number;
  first_seen: string;
  last_seen: string;
}

export interface DataHealthWatermark {
  count: number;
  last_seen: string;
}

export interface DataHealthWindow {
  from: string;
  to: string;
  interval: 'hour' | 'day';
  accepted_total: number;
  rejected_total: number;
  points: Array<{ bucket: string; accepted: number; rejected: number }>;
}

export interface DataHealthVerifyInput {
  env: string;
  signature_id: string;
  watermark: DataHealthWatermark;
}

export interface DataHealthVerifyResult {
  schema_version: 1;
  signature_id: string;
  status: 'resolved' | 'still_occurring';
  occurrences_since_watermark: number;
  checked_at: string;
  previous_watermark: DataHealthWatermark;
  current_watermark: DataHealthWatermark;
}

export interface DataHealthResult {
  schema_version: 1;
  generated_at: string;
  project: string;
  env: string;
  coverage: {
    accepted_basis: string;
    rejected_basis: string;
    rejected_history_first_observed_at: string | null;
  };
  summary: { accepted_24h: number; rejected_24h: number; accepted_7d: number; rejected_7d: number };
  windows: { last_24h: DataHealthWindow; last_7d: DataHealthWindow };
  issue_signatures: Array<{
    signature_id: string;
    kind: 'rejected' | 'unregistered' | 'clock_skew';
    category: 'schema_rejection' | 'missing_definition' | 'clock_skew';
    remediation: 'fix_schema' | 'register_definition' | 'fix_clock';
    registered_event_name: string | null;
    count: number;
    first_seen: string;
    last_seen: string;
    affected_answer_ids: string[];
    repair_action: { kind: 'navigate'; label: string; href: string };
    watermark: DataHealthWatermark;
    verify_after_fix: { method: 'POST'; href: string; body: DataHealthVerifyInput };
  }>;
  improvements: Array<{
    signature_id: string;
    severity: 'high' | 'medium';
    title: string;
    affected_answer_ids: string[];
    repair_action: { kind: 'navigate'; label: string; href: string };
    verify_after_fix: { method: 'POST'; href: string; body: DataHealthVerifyInput };
  }>;
  doing_well: Array<{
    code: 'accepted_events_flowing';
    title: string;
    evidence: string;
  }>;
}

export interface DataQualityIssue {
  kind: 'entity_event_status_conflict';
  severity: 'warning';
  entity_type: string;
  entity_id: string;
  current_status: string;
  expected_status: string;
  event: string;
  evidence_events: number;
  last_event_at: string;
  entity_updated_at: string;
  message: string;
}

export interface DataQualityResponse {
  issues: DataQualityIssue[];
  checked: { terminal_event_specs: number; evidence_rows: number };
}

export interface MetricUsage {
  metric: Metric;
  env: string;
  since_days: number;
  source_events: string[];
  observed_events: ObservedEvent[];
  used_by: {
    funnels: Array<{ key: string; name: string; goal: string; step_labels: string[]; window_seconds: number }>;
    insights: Array<{ id: string; title: string; status: string; severity: string | null; created_at: string }>;
  };
  guidance: string[];
}

export type KeyKind = 'ingest' | 'secret' | 'personal' | 'user';

export interface CredentialRotationPolicy {
  id: 'poolstatis_core.credential_rotation';
  version: number;
  source: 'poolstatis_core_default';
  mode: 'advisory';
  thresholds: {
    age_review_days: number;
    idle_review_days: number;
    unused_review_days: number;
  };
}

export interface CredentialRotationRecommendation {
  status: 'healthy' | 'review' | 'revoked';
  code: 'active' | 'new' | 'age_review' | 'idle_review' | 'unused_review' | 'revoked';
  label: string;
  recommendation: string;
  evaluated_at: string;
  evidence: { age_days: number; idle_days: number | null };
}

export interface ApiKeyRow {
  id: string;
  kind: KeyKind;
  env: string;
  label: string | null;
  /** Permanently masked server value, e.g. sk_...cafe. */
  masked_token: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  credential_policy: CredentialRotationPolicy;
  rotation_recommendation: CredentialRotationRecommendation;
}

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string };
}

export interface BillingMeter {
  key: string;
  name: string;
  unit: string;
  aggregation: string;
  hard_limit: number | null;
  warning_thresholds: number[];
}

export interface BillingSummary {
  plan: {
    id: string;
    name: string;
    price_cents: number;
    currency: string;
    billing_interval: string;
    included_events_monthly: number;
    included_mtu_monthly: number;
    included_projects: number;
    included_retention_months: number;
    included_seats: number;
    pricing_stage: string;
    features: Record<string, unknown>;
  };
  status: string;
  billing_limit_cents: number | null;
  current_period_start: string;
  current_period_end: string;
  meters: BillingMeter[];
}

export interface AccountMe {
  user: {
    id: string;
    subject: string;
    email: string | null;
    email_verified: boolean;
    display_name: string | null;
    name: string | null;
    picture_url: string | null;
    connection_strategy: string;
  };
  identity: {
    issuer: string | null;
    subject: string;
  };
  organization: {
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
  };
  membership: {
    organization_id: string;
    role: 'owner' | 'admin' | 'member';
  };
  billing: BillingSummary;
  onboarding: {
    completed: boolean;
  };
}

export interface PersonalToken {
  id: string;
  label: string | null;
  /** Permanently masked server value, e.g. pt_...cafe. */
  token: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  credential_policy: CredentialRotationPolicy;
  rotation_recommendation: CredentialRotationRecommendation;
}

export interface OrganizationUsage {
  meter: 'events_stored';
  period: string;
  quantity: number;
  hard_limit: number | null;
  warning_thresholds: number[];
  warnings: Array<{ threshold: number; quantity: number }>;
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    quantity: number;
    environments: Array<{ env: string; quantity: number }>;
  }>;
}

export interface UsageControlResult extends ControlTowerResult {
  meter: 'events_stored';
  cycle: { from: string; to: string; timezone: 'UTC' };
  cap: {
    state: 'finite' | 'not_configured';
    value: number | null;
    remaining: number | null;
    consequence_at_100_percent: string | null;
  };
  pace: {
    observed_days: number;
    events_per_day_7d: number | null;
    projected_cycle_end: number | null;
    confidence: 'sufficient' | 'insufficient';
  };
  threshold_forecasts: Array<{
    percent: 50 | 75 | 90 | 100;
    state: 'reached' | 'projected' | 'not_projected' | 'not_applicable';
    reached_or_projected_at: string | null;
    notification_state: 'not_configured';
    audit_source: 'usage_ledger';
  }>;
  contributors: Array<{
    project_slug: string;
    project_name: string;
    environment: string;
    accepted_events: number;
    share: number | null;
    change_7d: number | null;
    last_ingest_at: string | null;
  }>;
  reconciliation: {
    metered_quantity: number;
    attributed_quantity: number;
    difference: number;
    unattributed_quantity: number;
    overattributed_quantity: number;
    state: 'reconciled' | 'partial';
  };
}

export interface OrganizationUsageActivity {
  meter: 'events_stored';
  date_from: string;
  date_to: string;
  quantity: string;
  source: 'usage_ledger';
  timezone: 'UTC';
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    quantity: string;
    environments: Array<{ env: string; quantity: string }>;
  }>;
}

export interface OrganizationUsageRangeProject {
  id: string;
  slug: string;
  name: string;
  quantity: string;
  environments: Array<{ env: string; quantity: string }>;
}

export interface OrganizationUsageRangePeriod {
  period: string;
  quantity: string;
  unattributed_quantity: string;
  warnings: Array<{ threshold: number; quantity: number }>;
  projects: OrganizationUsageRangeProject[];
}

export interface OrganizationUsageRange {
  meter: 'events_stored';
  from: string;
  to: string;
  timezone: 'UTC';
  granularity: 'month';
  usage_basis: 'ingest_time';
  quantity: string;
  current_entitlement: {
    period: string;
    hard_limit: number | null;
    warning_thresholds: number[];
    basis: 'current_configuration';
  };
  periods: OrganizationUsageRangePeriod[];
}

export interface HostedOnboardingResult {
  organization: { id: string; name: string };
  project: { slug: string; name: string; timezone: string };
  intent: ProjectIntent | null;
  tokens: {
    personal: string | null;
    ingest_prod: string;
  };
  mcp: {
    command: string;
    args: string[];
    package_status: 'published' | 'publish_pending';
    note: string;
    env: {
      POOLSTATIS_URL: string;
      POOLSTATIS_TOKEN: string | null;
    };
  };
}

export type ProjectMode = 'website' | 'product' | 'both';
export type ProjectGoalId =
  | 'website_traffic'
  | 'website_pages'
  | 'website_conversion'
  | 'campaigns_referrals'
  | 'content_engagement'
  | 'activation'
  | 'feature_adoption'
  | 'retention'
  | 'release'
  | 'reliability_performance'
  | 'custom';
export type SetupTaskAgent = 'codex' | 'claude-code' | 'cursor' | 'other';
export type SetupTaskSource = 'deterministic' | 'llm' | 'fallback';

export interface SetupTaskPlan {
  schema_version: 1;
  agent_id: SetupTaskAgent;
  project_mode: ProjectMode;
  goal_ids: ProjectGoalId[];
  primary_goal_id: ProjectGoalId;
  summary: string;
  events: Array<{ name: string; purpose: string }>;
  smoke_action: string;
  release_manifest: {
    sdk: '@poolstatis/sdk@0.3.0';
    skills: ['poolstatis-instrument', 'poolstatis-analyze', 'poolstatis-maintain'];
    skills_cli: 'skills@1.5.22';
    skills_source: 'https://github.com/lim5max/poolstatis/archive/45af081344dc910933a0d274892e53cf417fa5fb.tar.gz';
  };
  security_rules: string[];
}

export interface ProjectIntentInput {
  project_mode: ProjectMode;
  website_domain: string | null;
  goal_ids: ProjectGoalId[];
  custom_goal: string | null;
  primary_goal_id: ProjectGoalId;
}

export interface ProjectIntent extends ProjectIntentInput {
  schema_version: 1;
  generated_plan: SetupTaskPlan | null;
  generated_plan_source: SetupTaskSource;
  created_at: string;
  updated_at: string;
}

export interface SetupTaskResponse {
  task: string;
  source: SetupTaskSource;
  plan: SetupTaskPlan;
  blocker: OnboardingGateKey | null;
}

export interface SetupTaskFeedbackInput {
  outcome: 'completed' | 'fallback' | 'blocked' | 'abandoned';
  blocker: string | null;
}
