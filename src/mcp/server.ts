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
  concludeExperimentSchema, createExperimentSchema,
  deprecateMetricSchema,
  defineFunnelSchema, entitiesQuerySchema, funnelQuerySchema, lifecycleQuerySchema,
  featureFlagSchema, flagEvaluationSchema, registerEntityTypeSchema, registerMetricSchema,
  retentionQuerySchema, stickinessQuerySchema, trendQuerySchema, updateExperimentSchema, updateFeatureFlagSchema,
  updateMetricSchema,
} from '../schemas.js';
import { INSTRUMENTATION_STANDARD } from './standard.js';

const BASE_URL = process.env.POOLSTATIS_URL ?? 'http://127.0.0.1:3300';
const TOKEN = process.env.POOLSTATIS_TOKEN;

if (!TOKEN) {
  console.error('POOLSTATIS_TOKEN is required (a pt_ personal token or sk_ secret key)');
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
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

const server = new McpServer({ name: 'poolstatis', version: '0.1.0' });
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

// ===== Registry (design-time) =====

jsonTool(
  'register_metric',
  'Register a metric in the project registry. `purpose` must be a real sentence — what decision does this metric inform? New metrics start as status=proposed; the project owner activates them.',
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
  'get_person',
  'Engagement summary for one actor (distinct_id): first/last seen, total/distinct events, active days, sessions, registered share, top events, plus their identity entity. Use to profile or segment a user.',
  { project, distinct_id: z.string(), env: z.string().default('prod') },
  wrap(({ project: slug, distinct_id, env }) => api('GET', `/api/v1/projects/${slug}/persons/${encodeURIComponent(distinct_id)}?env=${encodeURIComponent(env)}`)),
);

jsonTool(
  'sample_events',
  'Latest raw events — use to verify instrumentation works (did the event arrive? is it registered?).',
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
  'project-schema',
  new ResourceTemplate('poolstatis://{project}/schema', { list: undefined }),
  async (uri, { project: slug }) => {
    const schema = await api('GET', `/api/v1/projects/${String(slug)}/schema`);
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
