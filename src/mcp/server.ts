/**
 * Poolstatis MCP server: a thin wrapper over the Platform API.
 * No business logic lives here — tools map 1:1 onto REST calls, so the same
 * server works against a local instance or a hosted one.
 *
 * Env: POOLSTATIS_URL (default http://127.0.0.1:3300), POOLSTATIS_TOKEN (pt_/sk_).
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  actorLinkSchema,
  applyMeasurementDeclarationSchema,
  concludeExperimentSchema, createExperimentSchema,
  createMetricCategorySchema,
  deprecateMetricSchema,
  defineFunnelSchema, entitiesQuerySchema, funnelQuerySchema, lifecycleQuerySchema,
  experienceRouteRegistrationSchema, experienceSessionQuerySchema, experienceSurfaceSchema, featureFlagSchema, flagEvaluationSchema, interactionMapQuerySchema, registerEntityTypeSchema, registerMetricSchema,
  editDecisionSchema, measurementDeclarationSchema, measurementTrustSchema, posthogConnectionSchema, propertyDefinitionSchema,
  eventRevisionPatchSchema,
  approveDecisionActionSchema, prepareDecisionActionSchema, webhookDestinationSchema,
  registerReleaseSchema, reviewDecisionSchema,
  retentionQuerySchema, stickinessQuerySchema, trendQuerySchema, webAnalyticsQuerySchema,
  webSessionsQuerySchema, webSessionQuerySchema, pageEngagementQuerySchema,
  updateExperimentSchema, updateFeatureFlagSchema,
  updateMetricCategorySchema, updateMetricSchema, updatePropertyDefinitionSchema, visualExperienceCompareSchema, visualExperienceQuerySchema,
} from '../schemas.js';
import { BROWSER_ANALYTICS_STANDARD, INSTRUMENTATION_STANDARD } from './standard.js';

export interface McpConfig { baseUrl: string; token: string; }

/** Configuration is checked before stdio opens so a broken launcher cannot leak a token to protocol output. */
export function validateMcpConfig(env: { POOLSTATIS_URL?: string; POOLSTATIS_TOKEN?: string }): McpConfig {
  const token = env.POOLSTATIS_TOKEN?.trim();
  if (!token || !/^(pt|sk)_[a-f0-9]{16,}$/i.test(token)) {
    throw new Error('POOLSTATIS_TOKEN must be a non-empty pt_ personal token or sk_ secret key');
  }
  const raw = env.POOLSTATIS_URL?.trim() || 'http://127.0.0.1:3300';
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('POOLSTATIS_URL must be an HTTP(S) origin'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('POOLSTATIS_URL must be a clean HTTPS origin or loopback HTTP origin');
  }
  return { baseUrl: url.origin, token };
}

export function createMcpServer(config: Readonly<McpConfig>): McpServer {
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      'x-poolstatis-client': 'mcp',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; hint?: string } }
    | null;
  if (!res.ok) {
    const err = json?.error;
    const hint = err?.hint ? `\nhint: ${err.hint}` : '';
    throw new Error(`${err?.code ?? res.status}: ${err?.message ?? 'request failed'}${hint}`);
  }
  return json;
}

type ToolResult = CallToolResult;

const jsonOutputSchema = z.object({}).passthrough();

function ok(data: unknown): ToolResult {
  return {
    structuredContent: asStructuredContent(data),
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/** Errors are returned as content, not thrown: the message + hint is the agent's documentation. */
function wrap<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  };
}

const server = new McpServer({ name: 'poolstatis', version: '0.4.0' });
const project = z.string().describe('project slug, see list_projects');

function asStructuredContent(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

function jsonTool(
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: any) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    { description, inputSchema, outputSchema: jsonOutputSchema },
    async (args) => handler(args),
  );
}

// ===== Context =====

jsonTool(
  'list_projects',
  'List projects this token can access.',
  {},
  wrap(() => api('GET', '/api/v1/projects')),
);

jsonTool(
  'get_project_schema',
  'Everything about a project in one read: registered metrics, funnels, entity types, and actual event names seen in the last 30 days with their registered share. Read this before registering anything.',
  { project, env: z.string().default('prod') },
  wrap(({ project: slug, env }) => api('GET', `/api/v1/projects/${slug}/schema?env=${encodeURIComponent(env)}`)),
);

jsonTool(
  'get_onboarding_status',
  'Read evidence-backed setup gates and the first real decision result. This call persists an MCP-marked request and its time; it is last-use evidence, not heartbeat or transport attestation. Copied configuration alone does not complete the agent gate.',
  { project, env: z.string().default('prod') },
  wrap(async ({ project: slug, env }) => {
    await api('POST', `/api/v1/projects/${slug}/onboarding/observe-agent`, {
      client: 'poolstatis-mcp',
      env,
    });
    return api('GET', `/api/v1/projects/${slug}/onboarding/status?env=${encodeURIComponent(env)}`);
  }),
);

// ===== Measurement trust =====

jsonTool(
  'create_actor_link',
  'Link an anonymous or superseded distinct_id to one stable actor. Links are environment-scoped, cycle-checked and audited; use the target as the durable identity.',
  { project, link: actorLinkSchema },
  wrap(({ project: slug, link }) => api('POST', `/api/v1/projects/${slug}/identity-links`, link)),
);

jsonTool(
  'list_actor_links',
  'List identity links and their append-only audit history for one environment.',
  { project, env: z.string().default('prod') },
  wrap(({ project: slug, env }) => api('GET', `/api/v1/projects/${slug}/identity-links?env=${encodeURIComponent(env)}`)),
);

jsonTool(
  'revoke_actor_link',
  'Revoke an incorrect identity link without deleting its audit history.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('POST', `/api/v1/projects/${slug}/identity-links/${id}/revoke`)),
);

jsonTool(
  'register_property',
  'Register the meaning, type and decision purpose of an event, actor or entity property. New definitions start proposed until reviewed.',
  { project, property: propertyDefinitionSchema },
  wrap(({ project: slug, property }) => api('POST', `/api/v1/projects/${slug}/properties`, property)),
);

jsonTool(
  'list_properties',
  'List semantic property definitions, optionally filtered by scope or trust status.',
  {
    project,
    scope: z.enum(['event', 'actor', 'entity']).optional(),
    status: z.enum(['proposed', 'trusted', 'untrusted']).optional(),
  },
  wrap(({ project: slug, scope, status }) => {
    const qs = new URLSearchParams();
    if (scope) qs.set('scope', scope);
    if (status) qs.set('status', status);
    return api('GET', `/api/v1/projects/${slug}/properties${qs.size ? `?${qs}` : ''}`);
  }),
);

jsonTool(
  'propose_acquisition_properties',
  'Idempotently propose the five reserved browser acquisition UTM event properties. They remain proposed until an owner explicitly reviews and trusts a definition for decision contracts.',
  { project },
  wrap(({ project: slug }) => api('POST', `/api/v1/projects/${slug}/properties/acquisition-attribution`, {})),
);

jsonTool(
  'propose_browser_analytics',
  'Idempotently propose the canonical privacy-bounded browser properties plus page-view and visitor metrics. Everything remains proposed until owner review.',
  { project },
  wrap(({ project: slug }) => api('POST', `/api/v1/projects/${slug}/properties/browser-analytics`, {})),
);

jsonTool(
  'assess_measurement_trust',
  'Read evidence-backed metric, identity and target-property coverage before a decision. Use target_filters for a property-specific coverage and trust read-back.',
  { project, input: measurementTrustSchema },
  wrap(({ project: slug, input }) => api('POST', `/api/v1/projects/${slug}/measurement/trust`, input)),
);

jsonTool(
  'update_property',
  'Refine a property definition or mark it trusted/untrusted after checking real evidence.',
  {
    project,
    scope: z.enum(['event', 'actor', 'entity']),
    key: z.string().min(1),
    patch: updatePropertyDefinitionSchema,
  },
  wrap(({ project: slug, scope, key, patch }) => api(
    'PATCH',
    `/api/v1/projects/${slug}/properties/${scope}/${encodeURIComponent(key)}`,
    patch,
  )),
);

jsonTool(
  'configure_posthog',
  'Configure a bounded read-only PostHog source. The personal API key is write-only, encrypted at rest and never returned.',
  { project, connection: posthogConnectionSchema },
  wrap(({ project: slug, connection }) => api('POST', `/api/v1/projects/${slug}/sources/posthog`, connection)),
);

jsonTool(
  'verify_posthog',
  'Verify PostHog credentials and persist supported read-only capabilities.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('POST', `/api/v1/projects/${slug}/sources/posthog/${id}/verify`, {})),
);

jsonTool(
  'get_posthog_schema',
  'Discover the bounded event and property schema visible through a configured PostHog connection.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('GET', `/api/v1/projects/${slug}/sources/posthog/${id}/schema`)),
);

// ===== Product decision loop =====

jsonTool(
  'validate_measurement_contracts',
  'Validate a repository-owned poolstatis.yml declaration against live metric, property, flag and experiment semantics without mutating the project.',
  { project, declaration: measurementDeclarationSchema },
  wrap(({ project: slug, declaration }) => api('POST', `/api/v1/projects/${slug}/contracts/validate`, declaration)),
);

jsonTool(
  'diff_measurement_contracts',
  'Compute a deterministic contract diff and expected_revision without mutating runtime state. Review this before apply.',
  { project, declaration: measurementDeclarationSchema },
  wrap(({ project: slug, declaration }) => api('POST', `/api/v1/projects/${slug}/contracts/diff`, declaration)),
);

jsonTool(
  'apply_measurement_contracts',
  'Apply a validated poolstatis.yml declaration. Existing active contract changes require confirm_existing_changes=true and the exact expected_revision from diff.',
  {
    project,
    declaration: measurementDeclarationSchema,
    confirm_existing_changes: applyMeasurementDeclarationSchema.shape.confirm_existing_changes,
    expected_revision: applyMeasurementDeclarationSchema.shape.expected_revision,
  },
  wrap(({ project: slug, ...body }) => api('POST', `/api/v1/projects/${slug}/contracts/apply`, body)),
);

jsonTool(
  'list_measurement_contracts',
  'List the current runtime measurement contracts. Postgres is runtime truth; poolstatis.yml is the versioned declaration.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/contracts`)),
);

jsonTool(
  'get_measurement_contract',
  'Read one measurement contract and its immutable revision history.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api('GET', `/api/v1/projects/${slug}/contracts/${encodeURIComponent(key)}`)),
);

jsonTool(
  'export_measurement_contracts',
  'Export the byte-stable repository declaration as poolstatis.yml. Secrets and evaluated results are never included.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/contracts/export`)),
);

jsonTool(
  'register_release',
  'Register immutable change provenance in one CI/MCP call. Exact retries return the same fact; a redeploy or rollback must use a new idempotency_key.',
  { project, release: registerReleaseSchema },
  wrap(({ project: slug, release }) => api('POST', `/api/v1/projects/${slug}/releases`, release)),
);

jsonTool(
  'list_releases',
  'List project releases and their current observation state.',
  {
    project,
    env: z.string().optional(),
    status: z.enum(['planned', 'deployed', 'observing', 'decided', 'cancelled']).optional(),
    contract_key: z.string().optional(),
    experiment_key: z.string().optional(),
    originating_decision_id: z.string().uuid().optional(),
  },
  wrap(({ project: slug, env, status, contract_key, experiment_key, originating_decision_id }) => {
    const qs = new URLSearchParams();
    if (env) qs.set('env', env);
    if (status) qs.set('status', status);
    if (contract_key) qs.set('contract_key', contract_key);
    if (experiment_key) qs.set('experiment_key', experiment_key);
    if (originating_decision_id) qs.set('originating_decision_id', originating_decision_id);
    return api('GET', `/api/v1/projects/${slug}/releases${qs.size ? `?${qs}` : ''}`);
  }),
);

jsonTool(
  'get_release',
  'Read one release plus its append-only transition history and frozen contract revision.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('GET', `/api/v1/projects/${slug}/releases/${id}`)),
);

jsonTool(
  'evaluate_release',
  'Evaluate baseline versus observed windows, persist immutable facts and trust, and propose keep/fix/rollback/inconclusive. This never approves the action.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('POST', `/api/v1/projects/${slug}/releases/${id}/evaluate`, {})),
);

jsonTool(
  'list_decisions',
  'List evidence-backed decision proposals and human review status.',
  {
    project,
    status: z.enum(['proposed', 'approved', 'rejected']).optional(),
    release_id: z.string().uuid().optional(),
  },
  wrap(({ project: slug, status, release_id }) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (release_id) qs.set('release_id', release_id);
    return api('GET', `/api/v1/projects/${slug}/decisions${qs.size ? `?${qs}` : ''}`);
  }),
);

jsonTool(
  'get_decision',
  'Read facts, interpretation, reproducible queries, frozen release/contract context and every review revision for one decision.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('GET', `/api/v1/projects/${slug}/decisions/${id}`)),
);

jsonTool(
  'approve_decision',
  'Approve the agent proposal with an explicit human rationale. Approval records an immutable revision; it does not execute an external action.',
  { project, id: z.string().uuid(), rationale: reviewDecisionSchema.shape.rationale },
  wrap(({ project: slug, id, rationale }) => api('POST', `/api/v1/projects/${slug}/decisions/${id}/approve`, { rationale })),
);

jsonTool(
  'reject_decision',
  'Reject the agent proposal with an explicit rationale while preserving the original proposal in audit history.',
  { project, id: z.string().uuid(), rationale: reviewDecisionSchema.shape.rationale },
  wrap(({ project: slug, id, rationale }) => api('POST', `/api/v1/projects/${slug}/decisions/${id}/reject`, { rationale })),
);

jsonTool(
  'edit_decision',
  'Approve a human-corrected outcome/rationale while preserving the prior agent proposal and rejection history.',
  {
    project,
    id: z.string().uuid(),
    outcome: editDecisionSchema.shape.outcome,
    rationale: editDecisionSchema.shape.rationale,
  },
  wrap(({ project: slug, id, outcome, rationale }) => api('POST', `/api/v1/projects/${slug}/decisions/${id}/edit`, { outcome, rationale })),
);

jsonTool(
  'explain_outcome',
  'Rank bounded correlation hypotheses for an evidence-backed outcome. Measured facts remain separate, every candidate is labelled hypothesis, and this read creates no action.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('POST', `/api/v1/projects/${slug}/decisions/${id}/explain`, {})),
);

jsonTool(
  'prepare_action',
  'Prepare an exact, reversible follow-up action from a decision. Preparation never executes delivery, code, flag, deploy, or rollback work; it returns a confirmation fingerprint for human approval.',
  { project, decision_id: z.string().uuid(), action: prepareDecisionActionSchema },
  wrap(({ project: slug, decision_id, action }) => api('POST', `/api/v1/projects/${slug}/decisions/${decision_id}/actions`, action)),
);

jsonTool(
  'approve_action',
  'Execute only the exact previously prepared payload after human approval. The approval actor and fingerprint are audited; unsupported integrations stay inert.',
  { project, id: z.string().uuid(), confirmation_fingerprint: approveDecisionActionSchema.shape.confirmation_fingerprint },
  wrap(({ project: slug, id, confirmation_fingerprint }) => api('POST', `/api/v1/projects/${slug}/actions/${id}/approve`, { confirmation_fingerprint })),
);

jsonTool(
  'get_decision_inbox',
  'List product impact first: decisions needing a choice, waiting for trustworthy data, approved/rejected work, and resolved follow-ups.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/decision-inbox`)),
);

jsonTool(
  'configure_webhook',
  'Configure an encrypted generic webhook destination. The URL and optional authorization value are write-only and no delivery occurs until an explicit test.',
  { project, destination: webhookDestinationSchema },
  wrap(({ project: slug, destination }) => api('POST', `/api/v1/projects/${slug}/webhooks`, destination)),
);

jsonTool(
  'verify_webhook',
  'Queue an explicit idempotent test delivery. The destination becomes verified only after the durable outbox receives a successful response.',
  { project, id: z.string().uuid() },
  wrap(({ project: slug, id }) => api('POST', `/api/v1/projects/${slug}/webhooks/${id}/test`, {})),
);

jsonTool(
  'search_decision_history',
  'Search only this project decision memory by metric, feature tag, owner, review status, and time. Results preserve proposal-versus-human disagreement and label stale semantics.',
  {
    project,
    metric: z.string().optional(), tag: z.string().optional(), owner: z.string().optional(),
    contract: z.string().optional(), experiment: z.string().optional(),
    status: z.enum(['proposed', 'approved', 'rejected']).optional(),
    from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional(),
  },
  wrap(({ project: slug, ...filters }) => {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value !== undefined) qs.set(key, String(value)); });
    return api('GET', `/api/v1/projects/${slug}/decisions/search?${qs}`);
  }),
);

jsonTool(
  'find_similar_changes',
  'Rank metadata-similar past changes inside this project only. Similarity is deterministic and is not cross-customer inference or causal evidence.',
  { project, declaration: measurementDeclarationSchema },
  wrap(({ project: slug, declaration }) => api('POST', `/api/v1/projects/${slug}/contracts/similar`, declaration)),
);

// ===== Registry (design-time) =====

jsonTool(
  'list_metric_categories',
  'List this project’s metric purpose categories and definitions before registering metrics. Category answers why; namespaced tags answer where/what; funnels represent journeys.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/metric-categories`)),
);

jsonTool(
  'create_metric_category',
  'Create a project custom purpose category only when the system library cannot express why the metric exists. Do not create categories for features, surfaces, buttons, or journeys; use namespaced tags and funnels.',
  { project, category: createMetricCategorySchema },
  wrap(({ project: slug, category }) => api(
    'POST',
    `/api/v1/projects/${slug}/metric-categories`,
    category,
  )),
);

jsonTool(
  'update_metric_category',
  'Update the name, description, or color of a project custom category. System category semantics and all category keys are immutable.',
  { project, key: z.string(), patch: updateMetricCategorySchema },
  wrap(({ project: slug, key, patch }) => api(
    'PATCH',
    `/api/v1/projects/${slug}/metric-categories/${key}`,
    patch,
  )),
);

jsonTool(
  'delete_metric_category',
  'Delete an unused project custom category. System categories are locked and referenced categories return metric_category_in_use.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api(
    'DELETE',
    `/api/v1/projects/${slug}/metric-categories/${key}`,
  )),
);

jsonTool(
  'register_metric',
  'Register a metric in the project registry. Read list_metric_categories first: category is why, namespaced tags are where/what, and funnels are journeys. `purpose` must be a real sentence. New metrics start as status=proposed.',
  { project, metric: registerMetricSchema },
  wrap(({ project: slug, metric }) => api('POST', `/api/v1/projects/${slug}/metrics`, metric)),
);

jsonTool(
  'update_metric',
  'Update a registry metric: rename, refine purpose, change source, tags, or status proposed/active. Use deprecate_metric when retiring a metric.',
  { project, key: z.string(), patch: updateMetricSchema },
  wrap(({ project: slug, key, patch }) => api('PATCH', `/api/v1/projects/${slug}/metrics/${key}`, patch)),
);

jsonTool(
  'deprecate_metric',
  'Retire a metric with a required reason. Keeps history and the definition, removes it from active registration, and gives future agents context.',
  { project, key: z.string(), reason: deprecateMetricSchema.shape.reason },
  wrap(({ project: slug, key, reason }) => api('POST', `/api/v1/projects/${slug}/metrics/${key}/deprecate`, { reason })),
);

jsonTool(
  'explain_metric_usage',
  'Explain a metric: source events, recent observed event stats, funnels/insights that reference it, and guidance for delete/deprecate decisions.',
  {
    project,
    key: z.string(),
    env: z.string().default('prod'),
    since_days: z.number().int().min(1).max(365).default(30),
  },
  wrap(({ project: slug, key, env, since_days }) => api('GET', `/api/v1/projects/${slug}/metrics/${key}/usage?env=${encodeURIComponent(env)}&since_days=${since_days}`)),
);

jsonTool(
  'list_metrics',
  'List registry metrics, optionally filtered by status or category.',
  {
    project,
    status: z.enum(['proposed', 'active', 'deprecated']).optional(),
    category: z.string().optional(),
  },
  wrap(({ project: slug, status, category }) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (category) qs.set('category', category);
    const suffix = qs.size ? `?${qs}` : '';
    return api('GET', `/api/v1/projects/${slug}/metrics${suffix}`);
  }),
);

jsonTool(
  'delete_metric',
  'Hard-delete a metric from the registry (e.g. one you registered by mistake). Refuses if a funnel references it. Prefer deprecate_metric for routine retirement.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api('DELETE', `/api/v1/projects/${slug}/metrics/${key}`)),
);

jsonTool(
  'delete_funnel',
  'Delete a funnel definition.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api('DELETE', `/api/v1/projects/${slug}/funnels/${key}`)),
);

jsonTool(
  'register_entity_type',
  'Declare an entity type (user, account, …) before upserting entities of that type.',
  { project, entity_type: registerEntityTypeSchema },
  wrap(({ project: slug, entity_type }) => api('POST', `/api/v1/projects/${slug}/entity-types`, entity_type)),
);

jsonTool(
  'define_funnel',
  'Define a funnel from registry metrics (not raw events). `goal` must say what the funnel is for — it feeds the insights layer.',
  { project, funnel: defineFunnelSchema },
  wrap(({ project: slug, funnel }) => api('POST', `/api/v1/projects/${slug}/funnels`, funnel)),
);

jsonTool(
  'list_funnels',
  'List defined funnels with their goals and steps.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/funnels`)),
);

// ===== Browser Experience =====

jsonTool(
  'create_experience_surface',
  'Declare a browser surface before enabling the optional BrowserExperience SDK. The purpose states which UX decision the captured interactions should inform.',
  { project, surface: experienceSurfaceSchema },
  wrap(({ project: slug, surface }) => api('POST', `/api/v1/projects/${slug}/experience/surfaces`, surface)),
);

jsonTool(
  'list_experience_surfaces',
  'List purpose-tagged Browser Experience surfaces and their capture status.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/experience/surfaces`)),
);

jsonTool(
  'archive_experience_surface',
  'Stop new Browser Experience capture for a surface while preserving its existing interaction history.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api('POST', `/api/v1/projects/${slug}/experience/surfaces/${encodeURIComponent(key)}/archive`)),
);

jsonTool(
  'register_experience_route',
  'Register a safe canonical route key/path pattern under a Browser Experience surface. Query strings and hashes are refused.',
  { project, surface: z.string(), route: experienceRouteRegistrationSchema },
  wrap(({ project: slug, surface, route }) => api(
    'POST',
    `/api/v1/projects/${slug}/experience/surfaces/${encodeURIComponent(surface)}/routes`,
    route,
  )),
);

jsonTool(
  'list_visual_experience_versions',
  'Enumerate project-scoped surfaces, canonical routes, immutable page/app versions and desktop/mobile snapshot metadata. Returns evidence references only, never image bytes.',
  { project, surface: z.string().optional(), route: z.string().optional(), env: z.string().default('prod') },
  wrap(async ({ project: slug, surface, route, env }) => {
    const routeParams = new URLSearchParams();
    if (surface) routeParams.set('surface', surface);
    const snapshotParams = new URLSearchParams({ env });
    if (surface) snapshotParams.set('surface', surface);
    if (route) snapshotParams.set('route', route);
    const [routes, snapshots] = await Promise.all([
      api('GET', `/api/v1/projects/${slug}/experience/routes?${routeParams}`),
      api('GET', `/api/v1/projects/${slug}/experience/snapshots?${snapshotParams}`),
    ]);
    return { routes: (routes as { routes: unknown }).routes, snapshots: (snapshots as { snapshots: unknown }).snapshots };
  }),
);

// ===== Feature delivery =====

jsonTool(
  'create_feature_flag',
  'Create a project feature flag. Every flag needs a real purpose and deterministic percentage variants. Start in draft until rollout is intentionally activated.',
  { project, flag: featureFlagSchema },
  wrap(({ project: slug, flag }) => api('POST', `/api/v1/projects/${slug}/flags`, flag)),
);

jsonTool(
  'list_feature_flags',
  'List feature delivery flags with their purpose, status and allocation.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/flags`)),
);

jsonTool(
  'update_feature_flag',
  'Update a draft or active feature flag. Archived flags are immutable so historical delivery and experiment results stay interpretable.',
  { project, key: z.string(), patch: updateFeatureFlagSchema },
  wrap(({ project: slug, key, patch }) => api('PATCH', `/api/v1/projects/${slug}/flags/${encodeURIComponent(key)}`, patch)),
);

jsonTool(
  'archive_feature_flag',
  'Archive a feature flag. Refuses while a running experiment depends on it.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api('POST', `/api/v1/projects/${slug}/flags/${encodeURIComponent(key)}/archive`)),
);

jsonTool(
  'evaluate_feature_flag',
  'Inspect deterministic assignment for a stable distinct_id without recording an exposure event. Use this to debug rollout; product SDK evaluation records exposure automatically.',
  {
    project,
    key: z.string(),
    distinct_id: flagEvaluationSchema.shape.distinct_id,
    session_id: flagEvaluationSchema.shape.session_id,
  },
  wrap(({ project: slug, key, distinct_id, session_id }) => api(
    'POST',
    `/api/v1/projects/${slug}/flags/${encodeURIComponent(key)}/evaluate`,
    { distinct_id, ...(session_id ? { session_id } : {}) },
  )),
);

jsonTool(
  'create_experiment',
  'Create an experiment draft tying a hypothesis to one flag and declared outcome metrics. Starting it requires a fully allocated active flag and active event metrics.',
  { project, experiment: createExperimentSchema },
  wrap(({ project: slug, experiment }) => api('POST', `/api/v1/projects/${slug}/experiments`, experiment)),
);

jsonTool(
  'list_experiments',
  'List feature experiments and their lifecycle status.',
  { project },
  wrap(({ project: slug }) => api('GET', `/api/v1/projects/${slug}/experiments`)),
);

jsonTool(
  'update_experiment',
  'Update a draft experiment before it starts.',
  { project, key: z.string(), patch: updateExperimentSchema },
  wrap(({ project: slug, key, patch }) => api('PATCH', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}`, patch)),
);

jsonTool(
  'start_experiment',
  'Start a draft experiment. The linked flag must be active and allocate exactly 100% of traffic.',
  { project, key: z.string() },
  wrap(({ project: slug, key }) => api('POST', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/start`)),
);

jsonTool(
  'conclude_experiment',
  'Conclude a running experiment and optionally record the agent decision with rationale.',
  { project, key: z.string(), conclusion: concludeExperimentSchema },
  wrap(({ project: slug, key, conclusion }) => api('POST', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/conclude`, conclusion)),
);

jsonTool(
  'get_experiment_results',
  'Measure an experiment after first exposure: exposed actors, conversion, uplift, credible intervals and chance to win for each variant.',
  { project, key: z.string(), env: z.string().default('prod') },
  wrap(({ project: slug, key, env }) => api('GET', `/api/v1/projects/${slug}/experiments/${encodeURIComponent(key)}/results?env=${encodeURIComponent(env)}`)),
);

// ===== Queries (analysis-time) =====

jsonTool(
  'query_trend',
  'Time series for a registry metric. Dates: relative ("-30d", "-12h") or ISO. Optional breakdown by an event property (top 10 + $other).',
  { project, query: trendQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'trend', ...query })),
);

jsonTool(
  'query_web_analytics',
  'Return distinct visitors, sessions and page views plus count-and-percentage breakdowns by country, device, browser, OS, language, timezone or acquisition source. Definitions and privacy caveats are included.',
  { project, query: webAnalyticsQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'web_analytics', ...query })),
);

jsonTool(
  'get_web_overview',
  'Return a bounded web overview with visitors, sessions, page views, measured engagement, bounce only for complete sessions, single-page sessions, foreground time, wall-clock span, breakdown truncation and privacy/accounting definitions.',
  { project, query: webAnalyticsQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'web_analytics', ...query })),
);

jsonTool(
  'list_web_sessions',
  'List recent browser-tab sessions in one project/environment and period. Results are bounded and report truncation; incomplete timing remains explicit.',
  { project, query: webSessionsQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'web_sessions', ...query })),
);

jsonTool(
  'get_web_session',
  'Read one privacy-bounded browser-tab session with ordered page paths, foreground timing, wall-clock span and completeness. This is not DOM/video replay.',
  { project, query: webSessionQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'web_session', ...query })),
);

jsonTool(
  'get_session_engagement',
  'Explain measured engagement for one known browser-tab session. Returns the same bounded server evidence as get_web_session and never invents bounce for incomplete sessions.',
  { project, query: webSessionQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'web_session', ...query })),
);

jsonTool(
  'get_page_engagement',
  'Read the latest cumulative snapshot for one page_view_id. Duplicate or out-of-order snapshots are reduced by highest sequence; missing evidence stays explicit.',
  { project, query: pageEngagementQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'page_engagement', ...query })),
);

jsonTool(
  'get_click_map',
  'Return a bounded, exact surface/route/version/device click map. The default decision grain is unique sessions; event counts remain secondary. Reports sample size, truncation and missing-snapshot caveats.',
  { project, query: visualExperienceQuerySchema.omit({ kind: true }) },
  wrap(async ({ project: slug, query }) => {
    const result = await api(
      'POST',
      `/api/v1/projects/${slug}/query`,
      { kind: 'visual_experience', ...query },
    ) as {
      surface: unknown;
      route: string;
      version: string;
      device: string;
      grid: number;
      snapshot: unknown;
      summary: { sessions: number; clicks: number };
      click_cells: Array<{ x: number; y: number; count: number; sessions: number; actors: number }>;
      click_labels: Array<{ label: string; count: number; sessions: number; actors: number }>;
      click_labels_truncated: boolean;
      meta: unknown;
    };
    return {
      kind: 'click_map',
      aggregation: 'unique_sessions',
      surface: result.surface,
      route: result.route,
      version: result.version,
      device: result.device,
      grid: result.grid,
      snapshot: result.snapshot,
      sample_size: { sessions: result.summary.sessions, click_events: result.summary.clicks },
      cells: result.click_cells.map((cell) => ({
        x: cell.x, y: cell.y, sessions: cell.sessions, click_events: cell.count, actors: cell.actors,
      })),
      labels: result.click_labels.map((label) => ({
        label: label.label, sessions: label.sessions, click_events: label.count, actors: label.actors,
      })),
      truncated: result.click_labels_truncated,
      no_data_reason: result.summary.sessions === 0
        ? 'No matching accepted experience sessions exist for this exact surface, route, version, device and period.'
        : null,
      meta: result.meta,
    };
  }),
);

jsonTool(
  'get_scroll_map',
  'Return bounded scroll reach and section drop-off for an exact surface/route/version/device tuple. Reach is unique-session based and descriptive, not causal.',
  { project, query: visualExperienceQuerySchema.omit({ kind: true }) },
  wrap(async ({ project: slug, query }) => {
    const result = await api(
      'POST',
      `/api/v1/projects/${slug}/query`,
      { kind: 'visual_experience', ...query },
    ) as {
      surface: unknown;
      route: string;
      version: string;
      device: string;
      snapshot: unknown;
      summary: { sessions: number };
      scroll_coverage: unknown[];
      sections: unknown[];
      sections_truncated: boolean;
      meta: unknown;
    };
    return {
      kind: 'scroll_map',
      aggregation: 'unique_sessions',
      surface: result.surface,
      route: result.route,
      version: result.version,
      device: result.device,
      snapshot: result.snapshot,
      sample_size: { sessions: result.summary.sessions },
      scroll_reach: result.scroll_coverage,
      section_dropoff: result.sections,
      truncated: result.sections_truncated,
      no_data_reason: result.summary.sessions === 0
        ? 'No matching accepted experience sessions exist for this exact surface, route, version, device and period.'
        : null,
      meta: result.meta,
    };
  }),
);

jsonTool(
  'query_funnel',
  'Step-by-step conversion for a saved funnel (by key) or inline steps (registry metric keys).',
  { project, query: funnelQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'funnel', ...query })),
);

jsonTool(
  'query_entities',
  'Filter and sort entities by their current properties.',
  { project, query: entitiesQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'entities', ...query })),
);

jsonTool(
  'query_retention',
  'Retention grid: of the actors who did `start_metric` in each cohort bucket, how many returned (did `return_metric`, defaults to start) in each later period. Returns cohorts with size + retained counts/percentages.',
  { project, query: retentionQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'retention', ...query })),
);

jsonTool(
  'query_lifecycle',
  'Lifecycle breakdown per interval: new / returning / resurrecting / dormant actors for an event-based metric. Answers "is growth healthy underneath the headline number?".',
  { project, query: lifecycleQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'lifecycle', ...query })),
);

jsonTool(
  'query_stickiness',
  'Stickiness histogram: how many distinct intervals each actor was active in over the range. High bars at the right = a habit-forming product.',
  { project, query: stickinessQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'stickiness', ...query })),
);

jsonTool(
  'query_interaction_map',
  'Return a purpose-tagged click heatmap for one Browser Experience surface. Cells represent normalized click coordinates, not gaze or pointer movement.',
  { project, query: interactionMapQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'interaction_map', ...query })),
);

jsonTool(
  'get_experience_session',
  'Read the privacy-safe ordered interaction timeline for one known Browser Experience session. It contains only paths, stable labels, coordinates, scroll depth and coarse error type — never DOM/text.',
  { project, query: experienceSessionQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'experience_session', ...query })),
);

jsonTool(
  'get_visual_experience_map',
  'Explain one bounded surface/route/version/device/period using purpose, sample sizes, ordered safe section labels, counts and percentages, largest adjacent-section aggregate reach decreases, safe-label click concentration, scroll reach, snapshot freshness/coverage, evidence references, truncation/data-quality caveats and deterministic next actions with resolved periods. Returns aggregates only: never DOM, page text, input values, image bytes or PII. Reach counts do not track the same sessions between sections; evidence is descriptive and non-causal.',
  { project, query: visualExperienceQuerySchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'visual_experience', ...query })),
);

jsonTool(
  'compare_visual_experience',
  'Compare two explicit bounded version/device/period cohorts for one purpose-tagged route. Returns both sample sizes, count deltas, matched-label section percentage-point changes, taxonomy mismatches, snapshot evidence/freshness, truncation/data-quality caveats and deterministic map follow-ups with resolved ISO periods. It never invents causes or returns DOM, page text, input values, image bytes or PII; all differences are descriptive and non-causal.',
  { project, query: visualExperienceCompareSchema.omit({ kind: true }) },
  wrap(({ project: slug, query }) => api('POST', `/api/v1/projects/${slug}/query`, { kind: 'visual_experience_compare', ...query })),
);

jsonTool(
  'get_person',
  'Engagement summary for one actor (distinct_id): first/last seen, total/distinct events, active days, sessions, registered share, top events, plus their identity entity. Use to profile or segment a user.',
  { project, distinct_id: z.string(), env: z.string().default('prod') },
  wrap(({ project: slug, distinct_id, env }) => api('GET', `/api/v1/projects/${slug}/persons/${encodeURIComponent(distinct_id)}?env=${encodeURIComponent(env)}`)),
);

jsonTool(
  'preview_event_backfill',
  'Validate an all-or-nothing historical import without writing anything. Preserves each supplied timestamp, enforces retention/privacy rules, and returns the payload_sha256 required by import_historical_events.',
  {
    project,
    env: z.string().default('prod'),
    events: z.array(z.unknown()).min(1).max(500),
  },
  wrap(({ project: slug, env, events }) =>
    api('POST', `/api/v1/projects/${slug}/events/backfill/preview`, { env, events })),
);

jsonTool(
  'import_historical_events',
  'Commit an exact previously-previewed historical batch. batch_id is permanently idempotent: an exact retry is safe, while reuse with different events is rejected.',
  {
    project,
    env: z.string().default('prod'),
    batch_id: z.string().min(1).max(200),
    reason: z.string().trim().min(10),
    expected_payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    events: z.array(z.unknown()).min(1).max(500),
  },
  wrap(({ project: slug, ...body }) =>
    api('POST', `/api/v1/projects/${slug}/events/backfill`, body)),
);

jsonTool(
  'list_event_backfills',
  'List durable historical import batches with actor, reason, exact time range, registered counts, and payload hash.',
  {
    project,
    env: z.string().default('prod'),
    limit: z.number().int().min(1).max(100).default(50),
  },
  wrap(({ project: slug, env, limit }) =>
    api('GET', `/api/v1/projects/${slug}/events/backfills?env=${encodeURIComponent(env)}&limit=${limit}`)),
);

jsonTool(
  'preview_event_revision',
  'Preview an auditable correction to one native event. Use set_properties/unset_properties to add or remove parameters. No write occurs; review before/after and retain both expected_revision and preview_sha256.',
  {
    project,
    event_id: z.string().uuid(),
    env: z.string().default('prod'),
    patch: eventRevisionPatchSchema,
  },
  wrap(({ project: slug, event_id, env, patch }) =>
    api('POST', `/api/v1/projects/${slug}/events/${event_id}/revisions/preview`, { env, patch })),
);

jsonTool(
  'revise_event',
  'Apply the exact previously-reviewed native event correction with optimistic locking, a preview fingerprint, and an append-only before/after audit record. System and Browser Experience events are intentionally not editable.',
  {
    project,
    event_id: z.string().uuid(),
    env: z.string().default('prod'),
    patch: eventRevisionPatchSchema,
    expected_revision: z.number().int().positive(),
    expected_preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(10),
  },
  wrap(({ project: slug, event_id, ...body }) =>
    api('POST', `/api/v1/projects/${slug}/events/${event_id}/revisions`, body)),
);

jsonTool(
  'get_event_history',
  'Read the current event plus every immutable correction with actor, reason, and before/after snapshots.',
  {
    project,
    event_id: z.string().uuid(),
    env: z.string().default('prod'),
  },
  wrap(({ project: slug, event_id, env }) =>
    api('GET', `/api/v1/projects/${slug}/events/${event_id}?env=${encodeURIComponent(env)}`)),
);

jsonTool(
  'sample_events',
  'Latest raw events with stable event id, origin, and revision — use to verify instrumentation or choose one native event for an audited correction.',
  {
    project,
    event: z.string().optional(),
    registered: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    env: z.string().default('prod'),
  },
  wrap(({ project: slug, event, registered, limit, env }) => {
    const qs = new URLSearchParams({ limit: String(limit), env });
    if (event) qs.set('event', event);
    if (registered !== undefined) qs.set('registered', String(registered));
    return api('GET', `/api/v1/projects/${slug}/events/sample?${qs}`);
  }),
);

jsonTool(
  'list_ingest_warnings',
  'Inspect events the platform accepted but could not fully process: rejected (malformed), unregistered (no active metric), clock_skew. Deduped with a count. Use to self-diagnose why data looks wrong or what happened to a deleted metric\'s events.',
  { project, env: z.string().optional(), kind: z.enum(['rejected', 'unregistered', 'clock_skew']).optional() },
  wrap(({ project: slug, env, kind }) => {
    const qs = new URLSearchParams();
    if (env) qs.set('env', env);
    if (kind) qs.set('kind', kind);
    const suffix = qs.size ? `?${qs}` : '';
    return api('GET', `/api/v1/projects/${slug}/ingest-warnings${suffix}`);
  }),
);

jsonTool(
  'list_data_quality_issues',
  'Find semantic contradictions in ingested data. Currently flags entities whose current status contradicts terminal registered events such as brief.completed.',
  {
    project,
    env: z.string().default('prod'),
    limit: z.number().int().min(1).max(200).default(50),
    since_days: z.number().int().min(1).max(365).default(30),
  },
  wrap(({ project: slug, env, limit, since_days }) => {
    const qs = new URLSearchParams({ env, limit: String(limit), since_days: String(since_days) });
    return api('GET', `/api/v1/projects/${slug}/data-quality?${qs}`);
  }),
);

// ===== Insights =====

jsonTool(
  'list_insights',
  'List insights (manual notes and auto findings).',
  {
    project,
    status: z.enum(['open', 'ack', 'resolved']).optional(),
    kind: z.enum(['manual', 'auto']).optional(),
  },
  wrap(({ project: slug, status, kind }) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (kind) qs.set('kind', kind);
    const suffix = qs.size ? `?${qs}` : '';
    return api('GET', `/api/v1/projects/${slug}/insights${suffix}`);
  }),
);

jsonTool(
  'create_insight',
  'Save a finding: title, markdown body, and optionally the query that reproduces it.',
  {
    project,
    title: z.string().min(1),
    body: z.string().min(1),
    query: z.record(z.unknown()).optional(),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
  },
  wrap(({ project: slug, ...rest }) => api('POST', `/api/v1/projects/${slug}/insights`, rest)),
);

jsonTool(
  'resolve_insight',
  'Acknowledge or resolve an insight.',
  { project, id: z.string().uuid(), status: z.enum(['ack', 'resolved']) },
  wrap(({ project: slug, id, status }) => api('PATCH', `/api/v1/projects/${slug}/insights/${id}`, { status })),
);

// ===== Resources =====

server.resource(
  'instrumentation-standard',
  'poolstatis://standard/instrumentation',
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: INSTRUMENTATION_STANDARD }],
  }),
);

server.resource(
  'browser-analytics-standard',
  'poolstatis://standard/browser-analytics',
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: BROWSER_ANALYTICS_STANDARD }],
  }),
);

server.resource(
  'project-schema',
  new ResourceTemplate('poolstatis://{project}/schema', { list: undefined }),
  async (uri, { project: slug }) => {
    const schema = await api('GET', `/api/v1/projects/${String(slug)}/schema`);
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema, null, 2) }],
    };
  },
);

return server;
}

/** The root CLI and package CLI call this exact runner; the tool registry stays single-sourced above. */
export async function runMcpServer(config: McpConfig): Promise<void> {
  await createMcpServer(config).connect(new StdioServerTransport());
}
