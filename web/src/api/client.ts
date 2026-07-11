import type {
  AccountMe, ApiKeyRow, DataQualityResponse, EntityRow, Experiment, ExperimentResult, FeatureFlag, FeatureFlagStatus, Funnel, HostedOnboardingResult, IngestWarning, Metric, MetricStatus, MetricUsage,
  PersonSummary, ProjectSchema, ProjectWithStats, SampleEvent, SampleFilter, ExperienceSurface, InteractionMapResponse, ExperienceSessionResponse,
} from './types';

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

  me() {
    return this.req<AccountMe>('GET', '/api/v1/me');
  }

  completeOnboarding(body: { workspace_name: string; project_slug: string; project_name: string }) {
    return this.req<HostedOnboardingResult>('POST', '/api/v1/onboarding', body);
  }

  // ---- projects ----
  listProjects() {
    return this.req<{ projects: ProjectWithStats[]; scope: 'org' | 'project' }>('GET', '/api/v1/projects');
  }

  createProject(body: { slug: string; name: string }) {
    return this.req<ProjectWithStats>('POST', '/api/v1/projects', body);
  }

  schema(slug: string, env = 'prod') {
    return this.req<ProjectSchema>('GET', `/api/v1/projects/${slug}/schema?env=${encodeURIComponent(env)}`);
  }

  // ---- registry ----
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

  deleteMetric(slug: string, key: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/api/v1/projects/${slug}/metrics/${key}`);
  }

  purgeData(slug: string, body: { env: string; scope: 'events' | 'entities' | 'all'; confirm_slug: string; distinct_id?: string }) {
    return this.req<{ events_deleted: number; entities_deleted: number; env: string }>('POST', `/api/v1/projects/${slug}/data/purge`, body);
  }

  funnels(slug: string) {
    return this.req<{ funnels: Funnel[] }>('GET', `/api/v1/projects/${slug}/funnels`).then((r) => r.funnels);
  }

  // ---- feature delivery ----
  flags(slug: string) {
    return this.req<{ flags: FeatureFlag[] }>('GET', `/api/v1/projects/${slug}/flags`).then((r) => r.flags);
  }

  createFlag(slug: string, body: {
    key: string; name: string; purpose: string; status: Exclude<FeatureFlagStatus, 'archived'>;
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
    key: string; name: string; hypothesis: string; flag_key: string; primary_metric_key: string; secondary_metric_keys?: string[];
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

  // ---- browser experience ----
  experienceSurfaces(slug: string) {
    return this.req<{ surfaces: ExperienceSurface[] }>('GET', `/api/v1/projects/${slug}/experience/surfaces`).then((r) => r.surfaces);
  }

  createExperienceSurface(slug: string, body: { key: string; name: string; purpose: string }) {
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

  personSummary(slug: string, distinctId: string, env = 'prod') {
    return this.req<PersonSummary>('GET', `/api/v1/projects/${slug}/persons/${encodeURIComponent(distinctId)}?env=${encodeURIComponent(env)}`);
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
