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
}

export interface InteractionMapResponse {
  kind: 'interaction_map';
  surface: Pick<ExperienceSurface, 'key' | 'name' | 'purpose' | 'status'>;
  grid: number;
  cells: Array<{ x: number; y: number; count: number; actors: number }>;
  labels: Array<{ label: string; count: number; actors: number }>;
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
  aggregation: 'sum' | 'max' | 'latest';
  free_quantity: number;
  overage_unit_quantity: number;
  overage_price_cents: string;
  pricing_stage: 'free_now' | 'future_reference' | 'active';
  source_note: string;
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
    name: string | null;
    picture_url: string | null;
  };
  organization: {
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
  };
  billing: BillingSummary;
  onboarding: {
    completed: boolean;
  };
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
