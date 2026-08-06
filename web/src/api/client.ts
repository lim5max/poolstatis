import type {
  AccountMe, ActorLink, ActorLinkAudit, ApiKeyRow, DataQualityResponse, Decision, DecisionActionDetail, DecisionActionType, DecisionDetail, DecisionExplanation, DecisionHistoryItem, DecisionInboxItem, DecisionLoopOnboardingStatus, DecisionOutcome, EntityRow, EvidenceSet, Experiment, ExperimentReadiness, ExperimentResult, FeatureFlag, FeatureFlagStatus, Funnel, HostedOnboardingResult, IngestWarning, MeasurementContract, MeasurementTrust, Metric, MetricCategoryDefinition, MetricStatus, MetricUsage, PreparedExperiment, ProjectIntent, ProjectIntentInput, SetupTaskAgent, SetupTaskResponse,
  BackfillPreview, BackfillRecord, EventRevision, EventRevisionPatch, EventRevisionPreview, ProjectSchema, ProjectWithStats, PropertyDefinition, Release, ReleaseStatus, SampleEvent, SampleFilter, SourceConnection, TrendResponse, WebAnalyticsDimension, WebAnalyticsResponse, WebSessionsResponse, WebSessionResponse, WebhookDelivery, WebhookDestination, ExperienceRoute, ExperienceSnapshot, ExperienceSurface, InteractionMapResponse, ExperienceSessionResponse, OrganizationUsage, PersonalToken, VisualExperienceCompareResponse, VisualExperienceResponse,
} from './types';
import type { AnalysisQueryInput, AnalysisQueryResult } from '../analysis/visualization';
import type { OperationalQueryInput, OperationalQueryResult, PersonResult } from '../analysis/operations';

export class ApiError extends Error {
  constructor(public code: string, message: string, public hint?: string, public status?: number) {
    super(message);
  }
}

/** Thin typed wrapper over the Platform REST API (the admin console talks only to this). */
export class PoolstatisClient {
  constructor(private baseUrl: string, private token: string | (() => Promise<string>)) {}

  private async bearer(): Promise<string> {
    return typeof this.token === 'function' ? this.token() : this.token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.bearer();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError('network', `cannot reach ${this.baseUrl || 'the server'} — is it running?`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (json as { error?: { code: string; message: string; hint?: string } } | null)?.error;
      throw new ApiError(e?.code ?? String(res.status), e?.message ?? 'request failed', e?.hint, res.status);
    }
    return json as T;
  }

  private async raw(method: string, path: string, body?: Blob): Promise<Response> {
    const token = await this.bearer();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': body.type } : {}),
        },
        ...(body ? { body } : {}),
      });
    } catch {
      throw new ApiError('network', `cannot reach ${this.baseUrl || 'the server'} — is it running?`);
    }
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      const e = (json as { error?: { code: string; message: string; hint?: string } } | null)?.error;
      throw new ApiError(e?.code ?? String(res.status), e?.message ?? 'request failed', e?.hint, res.status);
    }
    return res;
  }

  me() {
    return this.req<AccountMe>('GET', '/api/v1/me');
  }

  updateProfile(body: { display_name: string }) {
    return this.req<AccountMe>('PATCH', '/api/v1/me', body);
  }

  usage(period: string) {
    return this.req<OrganizationUsage>('GET', `/api/v1/me/usage?period=${encodeURIComponent(period)}`);
  }

  completeOnboarding(body: {
    workspace_name: string; project_slug: string; project_name: string;
  } & Partial<ProjectIntentInput>) {
    return this.req<HostedOnboardingResult>('POST', '/api/v1/onboarding', body);
  }

  // ---- projects ----
  listProjects() {
    return this.req<{ projects: ProjectWithStats[]; scope: 'org' | 'project' }>('GET', '/api/v1/projects');
  }

  createProject(body: { slug: string; name: string }) {
    return this.req<ProjectWithStats>('POST', '/api/v1/projects', body);
  }

  deleteProject(slug: string, confirmSlug: string) {
    return this.req<{ deleted: true; slug: string; events_deleted: number; artifacts_deleted: number }>(
      'DELETE', `/api/v1/projects/${encodeURIComponent(slug)}`, { confirm_slug: confirmSlug },
    );
  }

  schema(slug: string, env = 'prod') {
    return this.req<ProjectSchema>('GET', `/api/v1/projects/${slug}/schema?env=${encodeURIComponent(env)}`);
  }

  onboardingStatus(slug: string, env = 'prod') {
    return this.req<DecisionLoopOnboardingStatus>('GET', `/api/v1/projects/${slug}/onboarding/status?env=${encodeURIComponent(env)}`);
  }

  projectIntent(slug: string) {
    return this.req<{ intent: ProjectIntent | null }>(
      'GET', `/api/v1/projects/${encodeURIComponent(slug)}/intent`,
    );
  }

  updateProjectIntent(slug: string, body: ProjectIntentInput) {
    return this.req<{ intent: ProjectIntent }>(
      'PUT', `/api/v1/projects/${encodeURIComponent(slug)}/intent`, body,
    );
  }

  setupTask(slug: string, body: { agent_id: SetupTaskAgent; prefer_llm?: boolean }) {
    return this.req<SetupTaskResponse>(
      'POST', `/api/v1/projects/${encodeURIComponent(slug)}/setup-task`, body,
    );
  }

  actorLinks(slug: string, env = 'prod') {
    return this.req<{ links: ActorLink[]; audit: ActorLinkAudit[] }>(
      'GET', `/api/v1/projects/${slug}/identity-links?env=${encodeURIComponent(env)}`,
    );
  }

  properties(slug: string, filter: { scope?: PropertyDefinition['scope']; status?: PropertyDefinition['status'] } = {}) {
    const qs = new URLSearchParams();
    if (filter.scope) qs.set('scope', filter.scope);
    if (filter.status) qs.set('status', filter.status);
    return this.req<{ properties: PropertyDefinition[] }>(
      'GET', `/api/v1/projects/${slug}/properties${qs.size ? `?${qs}` : ''}`,
    ).then((response) => response.properties);
  }

  updateProperty(slug: string, scope: PropertyDefinition['scope'], key: string, patch: Partial<{
    value_type: PropertyDefinition['value_type']; purpose: string;
    status: PropertyDefinition['status']; enum_values: string[] | null;
  }>) {
    return this.req<PropertyDefinition>(
      'PATCH', `/api/v1/projects/${slug}/properties/${scope}/${encodeURIComponent(key)}`, patch,
    );
  }

  proposeAcquisitionProperties(slug: string) {
    return this.req<{ properties: PropertyDefinition[] }>(
      'POST', `/api/v1/projects/${slug}/properties/acquisition-attribution`, {},
    ).then((response) => response.properties);
  }

  proposeBrowserAnalytics(slug: string, routeKeys: string[]) {
    return this.req<{ properties: PropertyDefinition[]; metrics: Metric[] }>(
      'POST', `/api/v1/projects/${slug}/properties/browser-analytics`,
      { route_keys: routeKeys },
    );
  }

  sources(slug: string) {
    return this.req<{ sources: SourceConnection[] }>('GET', `/api/v1/projects/${slug}/sources`)
      .then((response) => response.sources);
  }

  measurementTrust(slug: string, body: {
    metric_key: string; env: string; since_days?: number;
    target_filters?: SampleFilter[];
  }) {
    return this.req<MeasurementTrust>('POST', `/api/v1/projects/${slug}/measurement/trust`, body);
  }

  contracts(slug: string) {
    return this.req<{ contracts: MeasurementContract[] }>('GET', `/api/v1/projects/${slug}/contracts`)
      .then((response) => response.contracts);
  }

  contract(slug: string, key: string) {
    return this.req<{ contract: MeasurementContract; revisions: Array<Record<string, unknown>> }>(
      'GET', `/api/v1/projects/${slug}/contracts/${encodeURIComponent(key)}`,
    );
  }

  exportContracts(slug: string) {
    return this.req<{ filename: string; yaml: string }>('GET', `/api/v1/projects/${slug}/contracts/export`);
  }

  releases(slug: string, filter: { env?: string; status?: ReleaseStatus } = {}) {
    const qs = new URLSearchParams();
    if (filter.env) qs.set('env', filter.env);
    if (filter.status) qs.set('status', filter.status);
    return this.req<{ releases: Release[] }>('GET', `/api/v1/projects/${slug}/releases${qs.size ? `?${qs}` : ''}`)
      .then((response) => response.releases);
  }

  release(slug: string, id: string) {
    return this.req<{ release: Release; revisions: Array<Record<string, unknown>> }>(
      'GET', `/api/v1/projects/${slug}/releases/${id}`,
    );
  }

  evaluateRelease(slug: string, id: string) {
    return this.req<{ evidence: EvidenceSet; decision: Decision; idempotent: boolean }>(
      'POST', `/api/v1/projects/${slug}/releases/${id}/evaluate`, {},
    );
  }

  decisions(slug: string, filter: { status?: Decision['status']; release_id?: string } = {}) {
    const qs = new URLSearchParams();
    if (filter.status) qs.set('status', filter.status);
    if (filter.release_id) qs.set('release_id', filter.release_id);
    return this.req<{ decisions: Decision[] }>('GET', `/api/v1/projects/${slug}/decisions${qs.size ? `?${qs}` : ''}`)
      .then((response) => response.decisions);
  }

  decision(slug: string, id: string) {
    return this.req<DecisionDetail>('GET', `/api/v1/projects/${slug}/decisions/${id}`);
  }

  approveDecision(slug: string, id: string, rationale: string) {
    return this.req<DecisionDetail>('POST', `/api/v1/projects/${slug}/decisions/${id}/approve`, { rationale });
  }

  rejectDecision(slug: string, id: string, rationale: string) {
    return this.req<DecisionDetail>('POST', `/api/v1/projects/${slug}/decisions/${id}/reject`, { rationale });
  }

  editDecision(slug: string, id: string, outcome: DecisionOutcome, rationale: string) {
    return this.req<DecisionDetail>('POST', `/api/v1/projects/${slug}/decisions/${id}/edit`, { outcome, rationale });
  }

  explainDecision(slug: string, id: string) {
    return this.req<DecisionExplanation>('POST', `/api/v1/projects/${slug}/decisions/${id}/explain`, {});
  }

  decisionExplanations(slug: string, id: string) {
    return this.req<{ explanations: DecisionExplanation[] }>('GET', `/api/v1/projects/${slug}/decisions/${id}/explanations`)
      .then((response) => response.explanations);
  }

  prepareDecisionAction(slug: string, decisionId: string, body: {
    action_type: DecisionActionType; idempotency_key: string;
    target: Record<string, unknown>; payload: Record<string, unknown>; expected_effect: string;
  }) {
    return this.req<DecisionActionDetail>('POST', `/api/v1/projects/${slug}/decisions/${decisionId}/actions`, body);
  }

  decisionActions(slug: string, decisionId: string) {
    return this.req<{ actions: DecisionActionDetail['action'][] }>('GET', `/api/v1/projects/${slug}/decisions/${decisionId}/actions`)
      .then((response) => response.actions);
  }

  approveDecisionAction(slug: string, id: string, confirmationFingerprint: string) {
    return this.req<DecisionActionDetail>('POST', `/api/v1/projects/${slug}/actions/${id}/approve`, { confirmation_fingerprint: confirmationFingerprint });
  }

  rejectDecisionAction(slug: string, id: string, rationale: string) {
    return this.req<DecisionActionDetail>('POST', `/api/v1/projects/${slug}/actions/${id}/reject`, { rationale });
  }

  retryDecisionAction(slug: string, id: string) {
    return this.req<DecisionActionDetail>('POST', `/api/v1/projects/${slug}/actions/${id}/retry`, {});
  }

  decisionInbox(slug: string) {
    return this.req<{ decisions: DecisionInboxItem[] }>('GET', `/api/v1/projects/${slug}/decision-inbox`)
      .then((response) => response.decisions);
  }

  decisionHistory(slug: string, filter: { metric?: string; tag?: string; owner?: string; status?: Decision['status']; limit?: number } = {}) {
    const qs = new URLSearchParams();
    Object.entries(filter).forEach(([key, value]) => { if (value !== undefined) qs.set(key, String(value)); });
    return this.req<{ items: DecisionHistoryItem[]; next_cursor: string | null }>('GET', `/api/v1/projects/${slug}/decisions/search${qs.size ? `?${qs}` : ''}`);
  }

  webhookDestinations(slug: string) {
    return this.req<{ destinations: WebhookDestination[] }>('GET', `/api/v1/projects/${slug}/webhooks`)
      .then((response) => response.destinations);
  }

  configureWebhook(slug: string, body: { name: string; url: string; authorization?: string }) {
    return this.req<WebhookDestination>('POST', `/api/v1/projects/${slug}/webhooks`, body);
  }

  testWebhook(slug: string, id: string) {
    return this.req<WebhookDelivery>('POST', `/api/v1/projects/${slug}/webhooks/${id}/test`, {});
  }

  webhookDeliveries(slug: string) {
    return this.req<{ deliveries: WebhookDelivery[] }>('GET', `/api/v1/projects/${slug}/webhook-deliveries`)
      .then((response) => response.deliveries);
  }

  // ---- registry ----
  metricCategories(slug: string) {
    return this.req<{ categories: MetricCategoryDefinition[] }>(
      'GET',
      `/api/v1/projects/${slug}/metric-categories`,
    ).then((response) => response.categories);
  }

  createMetricCategory(slug: string, body: {
    key: string; name: string; description: string; domain: 'custom'; color: string;
  }) {
    return this.req<MetricCategoryDefinition>(
      'POST',
      `/api/v1/projects/${slug}/metric-categories`,
      body,
    );
  }

  updateMetricCategory(slug: string, key: string, patch: {
    name?: string; description?: string; color?: string;
  }) {
    return this.req<MetricCategoryDefinition>(
      'PATCH',
      `/api/v1/projects/${slug}/metric-categories/${key}`,
      patch,
    );
  }

  deleteMetricCategory(slug: string, key: string) {
    return this.req<{ deleted: true; key: string }>(
      'DELETE',
      `/api/v1/projects/${slug}/metric-categories/${key}`,
    );
  }

  metrics(slug: string, filter: { status?: MetricStatus; category?: string } = {}) {
    const qs = new URLSearchParams();
    if (filter.status) qs.set('status', filter.status);
    if (filter.category) qs.set('category', filter.category);
    const suffix = qs.toString() ? `?${qs}` : '';
    return this.req<{ metrics: Metric[] }>('GET', `/api/v1/projects/${slug}/metrics${suffix}`).then((r) => r.metrics);
  }

  setMetricStatus(slug: string, key: string, status: Exclude<MetricStatus, 'deprecated'>) {
    return this.req<Metric>('PATCH', `/api/v1/projects/${slug}/metrics/${key}`, { status });
  }

  deprecateMetric(slug: string, key: string, reason: string) {
    return this.req<Metric>('POST', `/api/v1/projects/${slug}/metrics/${key}/deprecate`, { reason });
  }

  metricUsage(slug: string, key: string, q: { env: string; sinceDays?: number }) {
    const qs = new URLSearchParams({ env: q.env });
    if (q.sinceDays !== undefined) qs.set('since_days', String(q.sinceDays));
    return this.req<MetricUsage>('GET', `/api/v1/projects/${slug}/metrics/${key}/usage?${qs}`);
  }

  setMetricTags(slug: string, key: string, tags: string[]) {
    return this.req<Metric>('PATCH', `/api/v1/projects/${slug}/metrics/${key}`, { tags });
  }

  updateMetricTaxonomy(slug: string, key: string, patch: {
    category: string | null;
    tags: string[];
  }) {
    return this.req<Metric>('PATCH', `/api/v1/projects/${slug}/metrics/${key}`, patch);
  }

  deleteMetric(slug: string, key: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/api/v1/projects/${slug}/metrics/${key}`);
  }

  purgeData(slug: string, body: { env: string; scope: 'events' | 'entities' | 'all'; confirm_slug: string; distinct_id?: string }) {
    return this.req<{ events_deleted: number; entities_deleted: number; snapshots_deleted: number; env: string }>('POST', `/api/v1/projects/${slug}/data/purge`, body);
  }

  funnels(slug: string) {
    return this.req<{ funnels: Funnel[] }>('GET', `/api/v1/projects/${slug}/funnels`).then((r) => r.funnels);
  }

  query(slug: string, query: AnalysisQueryInput) {
    return this.req<AnalysisQueryResult>('POST', `/api/v1/projects/${slug}/query`, query);
  }

  operationalQuery<T extends OperationalQueryResult>(slug: string, query: OperationalQueryInput) {
    return this.req<T>('POST', `/api/v1/projects/${slug}/query`, query);
  }

  // ---- feature delivery ----
  flags(slug: string) {
    return this.req<{ flags: FeatureFlag[] }>('GET', `/api/v1/projects/${slug}/flags`).then((r) => r.flags);
  }

  createFlag(slug: string, body: {
    key: string; name: string; purpose: string; status: Exclude<FeatureFlagStatus, 'archived'>;
    env?: string;
    variants: Array<{ key: string; rollout_percentage: number; payload?: Record<string, unknown> }>;
  }) {
    return this.req<FeatureFlag>('POST', `/api/v1/projects/${slug}/flags`, body);
  }

  updateFlag(slug: string, key: string, body: Partial<{
    name: string; purpose: string; status: Exclude<FeatureFlagStatus, 'archived'>;
    variants: Array<{ key: string; rollout_percentage: number; payload?: Record<string, unknown> }>;
  }>) {
    return this.req<FeatureFlag>('PATCH', `/api/v1/projects/${slug}/flags/${encodeURIComponent(key)}`, body);
  }

  archiveFlag(slug: string, key: string) {
    return this.req<FeatureFlag>('POST', `/api/v1/projects/${slug}/flags/${encodeURIComponent(key)}/archive`);
  }

  experiments(slug: string) {
    return this.req<{ experiments: Experiment[] }>('GET', `/api/v1/projects/${slug}/experiments`).then((r) => r.experiments);
  }

  createExperiment(slug: string, body: {
    key: string; name: string; hypothesis: string; flag_key: string; primary_metric_key: string; secondary_metric_keys?: string[]; env?: string; control_variant_key?: string;
  }) {
    return this.req<Experiment>('POST', `/api/v1/projects/${slug}/experiments`, body);
  }

  startExperiment(slug: string, key: string) {
    return this.req<Experiment>('POST', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/start`);
  }

  concludeExperiment(slug: string, key: string, decision?: { outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive'; rationale: string }) {
    return this.req<Experiment>('POST', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/conclude`, decision ? { decision } : {});
  }

  experimentResults(slug: string, key: string, env = 'prod') {
    return this.req<ExperimentResult>('GET', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/results?env=${encodeURIComponent(env)}`);
  }

  prepareExperiment(slug: string, body: {
    env: string;
    control_variant_key: string;
    flag: {
      key: string;
      name: string;
      purpose: string;
      variants: Array<{ key: string; rollout_percentage: number; payload?: Record<string, unknown> }>;
    };
    experiment: {
      key: string;
      name: string;
      hypothesis: string;
      primary_metric_key: string;
      secondary_metric_keys?: string[];
    };
  }) {
    return this.req<PreparedExperiment>('POST', `/api/v1/projects/${slug}/experiments/prepare`, body);
  }

  experimentReadiness(slug: string, key: string, env?: string) {
    const query = env ? `?env=${encodeURIComponent(env)}` : '';
    return this.req<ExperimentReadiness>('GET', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/readiness${query}`);
  }

  launchExperiment(slug: string, key: string) {
    return this.req<PreparedExperiment>('POST', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/launch`, {});
  }

  applyExperimentDecision(
    slug: string,
    key: string,
    body: {
      decision: { outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive'; rationale: string };
      ship_variant_key?: string;
    },
  ) {
    return this.req<{ experiment: Experiment; flag: FeatureFlag }>(
      'POST',
      `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/apply-decision`,
      body,
    );
  }

  // ---- browser experience ----
  experienceSurfaces(slug: string, env = 'prod') {
    return this.req<{ surfaces: ExperienceSurface[] }>('GET', `/api/v1/projects/${slug}/experience/surfaces?env=${encodeURIComponent(env)}`).then((r) => r.surfaces);
  }

  experienceRoutes(slug: string, surface?: string) {
    const query = surface ? `?surface=${encodeURIComponent(surface)}` : '';
    return this.req<{ routes: ExperienceRoute[] }>('GET', `/api/v1/projects/${slug}/experience/routes${query}`)
      .then((response) => response.routes);
  }

  registerExperienceRoute(slug: string, surface: string, body: { key: string; name: string; path_pattern: string }) {
    return this.req<ExperienceRoute>(
      'POST',
      `/api/v1/projects/${slug}/experience/surfaces/${encodeURIComponent(surface)}/routes`,
      body,
    );
  }

  experienceSnapshots(slug: string, filter: { surface?: string; route?: string; env?: string } = {}) {
    const query = new URLSearchParams();
    if (filter.surface) query.set('surface', filter.surface);
    if (filter.route) query.set('route', filter.route);
    if (filter.env) query.set('env', filter.env);
    return this.req<{ snapshots: ExperienceSnapshot[] }>(
      'GET',
      `/api/v1/projects/${slug}/experience/snapshots${query.size ? `?${query}` : ''}`,
    ).then((response) => response.snapshots);
  }

  async uploadExperienceSnapshot(
    slug: string,
    meta: {
      surface: string; route: string; version: string; device: 'desktop' | 'mobile'; env: string;
      release_hash: string; viewport_width: number; viewport_height: number;
      document_width: number; document_height: number; captured_at: string; retention_days: number;
    },
    file: File,
  ): Promise<ExperienceSnapshot> {
    const query = new URLSearchParams(Object.entries(meta).map(([key, value]) => [key, String(value)]));
    const response = await this.raw('POST', `/api/v1/projects/${slug}/experience/snapshots?${query}`, file);
    return response.json() as Promise<ExperienceSnapshot>;
  }

  async experienceSnapshotImage(slug: string, id: string): Promise<string> {
    const response = await this.raw('GET', `/api/v1/projects/${slug}/experience/snapshots/${encodeURIComponent(id)}/image`);
    return URL.createObjectURL(await response.blob());
  }

  visualExperience(slug: string, body: {
    surface: string; route: string; version: string; device: 'desktop' | 'mobile';
    date_from: string; date_to?: string; grid?: number; env: string;
  }) {
    return this.req<VisualExperienceResponse>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'visual_experience',
      ...body,
    });
  }

  compareVisualExperience(slug: string, body: {
    surface: string; route: string; env: string; grid?: number;
    baseline: { version: string; device: 'desktop' | 'mobile'; date_from: string; date_to?: string };
    comparison: { version: string; device: 'desktop' | 'mobile'; date_from: string; date_to?: string };
  }) {
    return this.req<VisualExperienceCompareResponse>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'visual_experience_compare',
      ...body,
    });
  }

  createExperienceSurface(slug: string, body: { key: string; name: string; purpose: string; route_pattern?: string }) {
    return this.req<ExperienceSurface>('POST', `/api/v1/projects/${slug}/experience/surfaces`, body);
  }

  archiveExperienceSurface(slug: string, key: string) {
    return this.req<ExperienceSurface>('POST', `/api/v1/projects/${slug}/experience/surfaces/${encodeURIComponent(key)}/archive`);
  }

  interactionMap(slug: string, body: { surface: string; date_from: string; date_to?: string; env: string; grid: number }) {
    return this.req<InteractionMapResponse>('POST', `/api/v1/projects/${slug}/query`, { kind: 'interaction_map', ...body });
  }

  experienceSession(slug: string, body: { surface: string; session_id: string; date_from?: string; date_to?: string; env: string; limit?: number }) {
    return this.req<ExperienceSessionResponse>('POST', `/api/v1/projects/${slug}/query`, { kind: 'experience_session', ...body });
  }

  trend(slug: string, body: {
    metric: string; date_from: string; date_to?: string | null;
    interval?: 'hour' | 'day' | 'week' | 'month';
    filters?: SampleFilter[]; breakdown?: { property: string }; env: string;
  }) {
    return this.req<TrendResponse>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'trend', interval: 'day', filters: [], ...body,
    });
  }

  webAnalytics(slug: string, body: {
    metric: string;
    date_from: string;
    date_to?: string | null;
    dimensions: WebAnalyticsDimension[];
    filters?: SampleFilter[];
    env: string;
  }) {
    return this.req<WebAnalyticsResponse>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'web_analytics', filters: [], ...body,
    });
  }

  webSessions(slug: string, body: {
    metric: string;
    key_metric?: string;
    date_from: string;
    date_to?: string | null;
    filters?: SampleFilter[];
    limit?: number;
    env: string;
  }) {
    return this.req<WebSessionsResponse>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'web_sessions', filters: [], limit: 20, ...body,
    });
  }

  webSession(slug: string, body: {
    metric: string;
    key_metric?: string;
    session_id: string;
    actor_id?: string;
    page_limit?: number;
    date_from: string;
    date_to?: string | null;
    filters?: SampleFilter[];
    env: string;
  }) {
    return this.req<WebSessionResponse>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'web_session', filters: [], ...body,
    });
  }

  // ---- data inspection ----
  sample(slug: string, q: {
    event?: string; registered?: boolean; limit?: number; env: string; distinct_id?: string;
    from?: string; to?: string; filters?: SampleFilter[];
  }) {
    const qs = new URLSearchParams({ env: q.env, limit: String(q.limit ?? 25) });
    if (q.event) qs.set('event', q.event);
    if (q.registered !== undefined) qs.set('registered', String(q.registered));
    if (q.distinct_id) qs.set('distinct_id', q.distinct_id);
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    for (const f of q.filters ?? []) {
      const v = f.op === 'is_set' || f.op === 'is_not_set' ? '' : Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
      qs.append('prop', `${f.property}:${f.op}:${v}`);
    }
    return this.req<{ events: SampleEvent[] }>('GET', `/api/v1/projects/${slug}/events/sample?${qs}`).then((r) => r.events);
  }

  personSummary(slug: string, distinctId: string, input: {
    env: string; from?: string; to?: string | null; limit?: number; cursor?: string;
  }) {
    const query = new URLSearchParams({ env: input.env });
    if (input.from) query.set('from', input.from);
    if (input.to) query.set('to', input.to);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    return this.req<PersonResult>(
      'GET',
      `/api/v1/projects/${slug}/persons/${encodeURIComponent(distinctId)}?${query}`,
    );
  }

  previewBackfill(slug: string, body: { env: string; events: unknown[] }) {
    return this.req<BackfillPreview>('POST', `/api/v1/projects/${slug}/events/backfill/preview`, body);
  }

  commitBackfill(slug: string, body: {
    env: string;
    batch_id: string;
    reason: string;
    expected_payload_sha256: string;
    events: unknown[];
  }) {
    return this.req<{ batch: BackfillRecord; inserted: number; duplicate?: boolean }>(
      'POST',
      `/api/v1/projects/${slug}/events/backfill`,
      body,
    );
  }

  backfills(slug: string, env: string, limit = 50) {
    return this.req<{ backfills: BackfillRecord[] }>(
      'GET',
      `/api/v1/projects/${slug}/events/backfills?env=${encodeURIComponent(env)}&limit=${limit}`,
    ).then((response) => response.backfills);
  }

  eventHistory(slug: string, eventId: string, env: string) {
    return this.req<{ event: SampleEvent; revisions: EventRevision[] }>(
      'GET',
      `/api/v1/projects/${slug}/events/${encodeURIComponent(eventId)}?env=${encodeURIComponent(env)}`,
    );
  }

  previewEventRevision(slug: string, eventId: string, body: { env: string; patch: EventRevisionPatch }) {
    return this.req<EventRevisionPreview>(
      'POST',
      `/api/v1/projects/${slug}/events/${encodeURIComponent(eventId)}/revisions/preview`,
      body,
    );
  }

  commitEventRevision(slug: string, eventId: string, body: {
    env: string;
    patch: EventRevisionPatch;
    expected_revision: number;
    expected_preview_sha256: string;
    reason: string;
  }) {
    return this.req<{ revision: EventRevision }>(
      'POST',
      `/api/v1/projects/${slug}/events/${encodeURIComponent(eventId)}/revisions`,
      body,
    );
  }

  entities(slug: string, q: { entity_type: string; limit?: number; env: string }) {
    return this.req<{ entities: EntityRow[] }>('POST', `/api/v1/projects/${slug}/query`, {
      kind: 'entities', entity_type: q.entity_type, limit: q.limit ?? 50, env: q.env,
    }).then((r) => r.entities);
  }

  dataQuality(slug: string, q: { env: string; limit?: number; sinceDays?: number }) {
    const qs = new URLSearchParams({ env: q.env });
    if (q.limit !== undefined) qs.set('limit', String(q.limit));
    if (q.sinceDays !== undefined) qs.set('since_days', String(q.sinceDays));
    return this.req<DataQualityResponse>('GET', `/api/v1/projects/${slug}/data-quality?${qs}`);
  }

  // ---- keys (admin) ----
  keys(slug: string) {
    return this.req<{ keys: ApiKeyRow[] }>('GET', `/api/v1/projects/${slug}/keys`).then((r) => r.keys);
  }

  issueKey(slug: string, body: { kind: 'ingest' | 'secret'; env?: string; label?: string }) {
    return this.req<{ id: string; token: string }>('POST', `/api/v1/projects/${slug}/keys`, body);
  }

  issuePersonalToken(body: { label?: string } = {}) {
    return this.req<{ id: string; token: string }>('POST', '/api/v1/me/tokens', body);
  }

  personalTokens() {
    return this.req<{ tokens: PersonalToken[] }>('GET', '/api/v1/me/tokens').then((response) => response.tokens);
  }

  revokePersonalToken(id: string) {
    return this.req<{ revoked: boolean }>('DELETE', `/api/v1/me/tokens/${id}`);
  }

  revokeKey(slug: string, id: string) {
    return this.req<{ revoked: boolean }>('POST', `/api/v1/projects/${slug}/keys/${id}/revoke`);
  }

  // ---- ingest warnings (error log) ----
  ingestWarnings(slug: string, q: { env?: string; kind?: string } = {}) {
    const qs = new URLSearchParams();
    if (q.env) qs.set('env', q.env);
    if (q.kind) qs.set('kind', q.kind);
    const suffix = qs.toString() ? `?${qs}` : '';
    return this.req<{ warnings: IngestWarning[] }>('GET', `/api/v1/projects/${slug}/ingest-warnings${suffix}`).then((r) => r.warnings);
  }

  clearIngestWarnings(slug: string, env?: string) {
    const suffix = env ? `?env=${encodeURIComponent(env)}` : '';
    return this.req<{ cleared: number }>('DELETE', `/api/v1/projects/${slug}/ingest-warnings${suffix}`);
  }

  // ---- docs ----
  standard() {
    return this.req<{ markdown: string }>('GET', '/api/v1/standard').then((r) => r.markdown);
  }
}
