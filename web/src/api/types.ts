// Mirrors the Platform API response shapes (src/http/server.ts + services).

export type MetricCategory =
  | 'acquisition' | 'activation' | 'retention' | 'revenue' | 'referral' | 'quality';

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
  status: FeatureFlagStatus;
  salt: string;
  variants: FeatureFlagVariant[];
  created_at: string;
  updated_at: string;
}

export type ExperimentStatus = 'draft' | 'running' | 'concluded';

export interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string;
  flag_key: string;
  primary_metric_key: string;
  secondary_metric_keys: string[];
  status: ExperimentStatus;
  started_at: string | null;
  concluded_at: string | null;
  decision: { outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive'; rationale: string } | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentResult {
  key: string;
  status: ExperimentStatus;
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
  meta: {
    computed_at: string;
    date_range?: { from: string; to: string };
    sampling: null;
    note?: string;
    source?: 'native' | 'posthog';
  };
}

export interface ExperienceSessionResponse {
  kind: 'experience_session';
  surface: Pick<ExperienceSurface, 'key' | 'name' | 'purpose' | 'status'>;
  session_id: string;
  events: Array<{
    timestamp: string;
    kind: 'page_viewed' | 'element_clicked' | 'scroll_depth' | 'client_error';
    route: string;
    sequence: number;
    label?: string;
    x?: number;
    y?: number;
    depth?: number;
    error_type?: 'error' | 'unhandled_rejection';
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
  funnels: number;
  events_30d: number;
}

export interface ProjectSchema {
  project: { slug: string; name: string };
  env: string;
  metrics: Metric[];
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
  event: string;
  timestamp: string;
  distinct_id: string;
  session_id: string | null;
  properties: Record<string, unknown>;
  registered: boolean;
  env: string;
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

export interface ActorSummary {
  first_seen: string | null;
  last_seen: string | null;
  total_events: number;
  distinct_events: number;
  active_days: number;
  sessions: number;
  registered_share: number;
  top_events: Array<{ event: string; count: number }>;
}

export interface PersonSummary {
  distinct_id: string;
  env: string;
  summary: ActorSummary;
  entity: { entity_type: string; properties: Record<string, unknown>; updated_at: string } | null;
}

export interface IngestWarning {
  kind: 'rejected' | 'unregistered' | 'clock_skew';
  event: string;
  detail: string;
  sample: unknown;
  count: number;
  first_seen: string;
  last_seen: string;
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

export interface ApiKeyRow {
  id: string;
  kind: KeyKind;
  env: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
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

export interface HostedOnboardingResult {
  organization: { id: string; name: string };
  project: { slug: string; name: string; timezone: string };
  tokens: {
    personal: string;
    ingest_prod: string;
  };
  mcp: {
    command: string;
    args: string[];
    package_status: 'published' | 'publish_pending';
    note: string;
    env: {
      POOLSTATIS_URL: string;
      POOLSTATIS_TOKEN: string;
    };
  };
}
