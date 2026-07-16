import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type pg from 'pg';
import { ApiError, badRequest, notFound } from '../errors.js';
import { authenticate, requireKind, type AuthContext, type JwtAuthOptions } from './auth.js';
import { createContext, type AppContext, type CreateContextOptions } from './context.js';
import {
  completeHostedOnboarding, getBillingSummary, organizationHasProjects, type McpRunnerConfig,
} from '../services/accounts.js';
import {
  createApiKey, createProject, getProjectBySlug, listApiKeys,
  listProjectsWithStats, revokeApiKey, type Project,
} from '../services/projects.js';
import { INSTRUMENTATION_STANDARD } from '../mcp/standard.js';
import {
  defineFunnel, deleteFunnel, deleteMetric, deprecateMetric, listFunnels, listMetrics,
  registerEntityType, registerMetric, updateMetric,
} from '../services/registry.js';
import { deleteEntities, getIdentityEntity, upsertEntities } from '../services/entities.js';
import { createInsight, listInsights, setInsightStatus } from '../services/insights.js';
import { clearIngestWarnings, listIngestWarnings, type WarningKind } from '../services/warnings.js';
import { listDataQualityIssues } from '../services/dataQuality.js';
import { explainMetricUsage } from '../services/metricUsage.js';
import { getProjectSchema } from '../services/schema.js';
import {
  archiveFeatureFlag, createFeatureFlag, evaluateFeatureFlag, listFeatureFlags, updateFeatureFlag,
} from '../services/flags.js';
import {
  concludeExperiment, createExperiment, getExperimentResults, listExperiments, startExperiment, updateExperiment,
} from '../services/experiments.js';
import {
  archiveExperienceSurface, captureExperienceEvents, createExperienceSurface, listExperienceSurfaces,
} from '../services/experience.js';
import { parseDateInput } from '../dates.js';
import {
  RateLimitExceeded, TenantRateLimiter, type TenantRateLimitOptions,
} from '../services/rateLimiter.js';
import {
  deprecateMetricSchema,
  concludeExperimentSchema, createExperimentSchema, defineFunnelSchema, entityUpsertSchema, experienceCaptureSchema, experienceSurfaceSchema, featureFlagSchema, flagEvaluationSchema, ingestEnvelopeSchema, propertyFilterSchema, purgeDataSchema,
  querySchema, registerEntityTypeSchema, registerMetricSchema, updateMetricSchema, type PropertyFilter,
  updateExperimentSchema, updateFeatureFlagSchema,
} from '../schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    resolvedProject?: Project;
  }
}

export interface ServerOptions {
  auth?: JwtAuthOptions | null;
  publicUrl?: string;
  mcpRunner?: McpRunnerConfig;
  ingestBuffer?: CreateContextOptions['ingestBuffer'];
  queryCache?: CreateContextOptions['queryCache'];
  rateLimit?: TenantRateLimitOptions | false;
}

const NUMERIC_TOKEN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function authOwner(auth: AuthContext): string {
  return auth.keyId ? `key:${auth.keyId}` : `user:${auth.userId}`;
}

function requirePlatformAccess(auth: AuthContext): void {
  requireKind(auth, 'secret', 'personal', 'user');
  if (auth.kind === 'user' && auth.userRole !== 'owner' && auth.userRole !== 'admin') {
    throw new ApiError(
      403,
      'insufficient_role',
      'this hosted account role cannot manage platform resources',
      'ask an owner or admin to upgrade your workspace role',
    );
  }
}

function requireTokenIssuanceAccess(auth: AuthContext): void {
  requireKind(auth, 'user');
  if (auth.userRole !== 'owner' && auth.userRole !== 'admin') {
    throw new ApiError(
      403,
      'insufficient_role',
      'this hosted account role cannot issue MCP tokens',
      'ask an owner or admin to issue a personal token',
    );
  }
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest('invalid_query_param', `${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Parse a `key:op:value` query token into a validated PropertyFilter. */
function parsePropFilter(token: string): PropertyFilter {
  const m = /^([^:]+):([^:]+):?([\s\S]*)$/.exec(token);
  if (!m) throw badRequest('invalid_filter', `bad filter "${token}" — expected key:op:value`);
  const [, property, op, rawValue] = m;
  const base = { property: property!, op: op! };
  if (op === 'is_set' || op === 'is_not_set') return propertyFilterSchema.parse(base) as PropertyFilter;
  // Query-string values arrive as strings. For range ops a numeric-looking value
  // must be coerced to a number, or compileFilters compares lexically as text
  // ('9' > '100'). eq/ne/in stay strings so zero-padded ids and ISO dates (which
  // already sort correctly as text) keep their exact value.
  const numericRange =
    (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && NUMERIC_TOKEN.test(rawValue ?? '');
  const value = op === 'in' ? (rawValue ?? '').split(',') : numericRange ? Number(rawValue) : rawValue;
  return propertyFilterSchema.parse({ ...base, value }) as PropertyFilter;
}

export function buildServer(pool: pg.Pool, options: ServerOptions = {}): FastifyInstance {
  const contextOptions: CreateContextOptions = {};
  if (options.ingestBuffer !== undefined) contextOptions.ingestBuffer = options.ingestBuffer;
  if (options.queryCache !== undefined) contextOptions.queryCache = options.queryCache;
  const ctx = createContext(pool, contextOptions);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const rateLimiter = options.rateLimit === false || options.rateLimit === undefined
    ? null
    : new TenantRateLimiter(options.rateLimit);
  const credentialAttemptLimiter = options.rateLimit === false || options.rateLimit === undefined
    ? null
    : new TenantRateLimiter(credentialAttemptLimits(options.rateLimit));
  const publicUrl = (options.publicUrl ?? 'https://api.poolstatis.com').replace(/\/$/, '');
  const mcpRunner = options.mcpRunner ?? {
    command: 'pnpm',
    args: ['--silent', 'dlx', '@poolstatis/mcp'],
    packageStatus: 'publish_pending' as const,
    note: 'Publish or configure the MCP runner before treating this template as copy-paste ready.',
  };

  // The dashboard SPA is served from a different origin (vite dev or static
  // host). Bearer tokens, not cookies, carry auth — so reflecting the origin
  // is safe here. Preflight OPTIONS is exempted from the auth hook below.
  void app.register(import('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  // Unauthenticated liveness probe the dashboard uses to check the base URL
  // before a token is entered.
  app.get('/health', async () => ({ status: 'ok', service: 'poolstatis' }));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send(err.toBody());
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request body',
          hint: 'see the API reference in docs/04-http-api.md',
        },
      });
    }
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({
        error: { code: fastifyErr.code ?? 'bad_request', message: fastifyErr.message ?? 'bad request' },
      });
    }
    app.log?.error?.(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.addHook('onRequest', async (req) => {
    // CORS preflight and the public health probe carry no token.
    if (req.method === 'OPTIONS' || req.url === '/health') return;
    req.auth = await authenticate(pool, req.headers.authorization, options.auth);
  });

  if (rateLimiter) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method === 'OPTIONS' || req.url === '/health') return;
      const lane = req.url.startsWith('/i/v1/') ? 'ingest' as const : 'api' as const;
      const slug = (req.params as { slug?: string } | undefined)?.slug;
      if (lane === 'api' && credentialAttemptLimiter) {
        try {
          credentialAttemptLimiter.consume({
            lane: 'api',
            tenantId: req.auth.orgId,
            keyId: authOwner(req.auth),
            projectId: 'credential-attempts',
            cost: 1,
          });
        } catch (error) {
          if (!(error instanceof RateLimitExceeded)) throw error;
          void reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
          throw new ApiError(
            429,
            'rate_limited',
            'credential request-attempt limit exceeded',
            `retry after approximately ${Math.max(1, Math.ceil(error.retryAfterMs / 1_000))} seconds`,
          );
        }
      }
      if (lane === 'ingest') {
        requireKind(req.auth, 'ingest');
      } else {
        const route = req.routeOptions.url;
        if (route === '/api/v1/me' || route === '/api/v1/onboarding') {
          requireKind(req.auth, 'user');
        } else if (route === '/api/v1/me/tokens') {
          requireTokenIssuanceAccess(req.auth);
        } else {
          requirePlatformAccess(req.auth);
        }
      }

      let projectScope = req.auth.projectId ?? `org:${req.auth.orgId}`;
      if (lane === 'api' && slug) {
        const project = await getProjectBySlug(pool, req.auth.orgId, slug);
        if (req.auth.kind === 'secret' && req.auth.projectId !== project.id) {
          throw new ApiError(403, 'project_scope', 'this secret key belongs to a different project');
        }
        req.resolvedProject = project;
        projectScope = project.id;
      }
      try {
        const decision = rateLimiter.consume({
          lane,
          tenantId: req.auth.orgId,
          keyId: authOwner(req.auth),
          projectId: projectScope,
          cost: lane === 'ingest' ? ingestRequestCost(req.routeOptions.url, req.body) : 1,
        });
        void reply.header('x-ratelimit-limit', String(decision.limit));
        void reply.header('x-ratelimit-remaining', String(decision.remaining));
      } catch (error) {
        if (!(error instanceof RateLimitExceeded)) throw error;
        if (error.retryAfterMs === 0) {
          throw new ApiError(
            413,
            'rate_limit_batch_too_large',
            error.message,
            'split this request into a smaller batch or raise the configured burst deliberately',
          );
        }
        void reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
        throw new ApiError(
          429,
          'rate_limited',
          error.message,
          `retry after approximately ${Math.max(1, Math.ceil(error.retryAfterMs / 1_000))} seconds`,
        );
      }
    });
  }

  registerIngestRoutes(app, ctx);
  registerAccountRoutes(app, ctx, publicUrl, mcpRunner);
  registerPlatformRoutes(app, ctx);
  return app;
}

function credentialAttemptLimits(options: TenantRateLimitOptions): TenantRateLimitOptions {
  const key = {
    ratePerSecond: options.api.key.ratePerSecond,
    burst: Math.max(10, options.api.key.burst * 2),
  };
  const project = {
    ratePerSecond: Math.max(key.ratePerSecond, options.api.project.ratePerSecond),
    burst: Math.max(21, options.api.project.burst * 2),
  };
  return {
    ingest: { key, project },
    api: { key, project },
    maxEntries: options.maxEntries,
    maxEntriesPerTenant: options.maxEntriesPerTenant,
    idleTtlMs: options.idleTtlMs,
  };
}

function ingestRequestCost(route: string | undefined, body: unknown): number {
  if (!body || typeof body !== 'object') return 1;
  const candidate = body as { events?: unknown; entities?: unknown };
  if ((route === '/i/v1/events' || route === '/i/v1/experience/events') && Array.isArray(candidate.events)) {
    return Math.max(1, candidate.events.length);
  }
  if (route === '/i/v1/entities' && Array.isArray(candidate.entities)) {
    return Math.max(1, candidate.entities.length);
  }
  return 1;
}

// ===== Ingest (/i/v1, pk_ keys) =====

function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/i/v1/events', async (req, reply) => {
    requireKind(req.auth, 'ingest');
    const project = await ingestProject(ctx, req.auth);
    const body = ingestEnvelopeSchema.parse(req.body);
    const result = await ctx.ingest.processBatch(project, req.auth.env, body);
    if (result.accepted > 0) ctx.query.invalidateProject(project.id);
    return reply.status(result.errors ? 207 : 200).send(result);
  });

  app.post('/i/v1/entities', async (req) => {
    requireKind(req.auth, 'ingest');
    const project = await ingestProject(ctx, req.auth);
    const body = entityUpsertSchema.parse(req.body);
    const result = await upsertEntities(ctx.pool, project.id, req.auth.env, body);
    ctx.query.invalidateProject(project.id);
    return result;
  });

  app.post('/i/v1/flags/evaluate', async (req) => {
    requireKind(req.auth, 'ingest');
    const project = await ingestProject(ctx, req.auth);
    const body = flagEvaluationSchema.parse(req.body);
    const result = await evaluateFeatureFlag(ctx.pool, ctx.eventStore, project.id, req.auth.env, body);
    ctx.query.invalidateProject(project.id);
    return result;
  });

  app.post('/i/v1/experience/events', async (req) => {
    requireKind(req.auth, 'ingest');
    const project = await ingestProject(ctx, req.auth);
    const result = await captureExperienceEvents(ctx.pool, ctx.eventStore, project.id, req.auth.env, experienceCaptureSchema.parse(req.body));
    ctx.query.invalidateProject(project.id);
    return result;
  });
}

async function ingestProject(
  ctx: AppContext,
  auth: AuthContext,
): Promise<{ id: string; retention_months: number }> {
  const { rows } = await ctx.pool.query(
    'SELECT id, retention_months FROM projects WHERE id = $1',
    [auth.projectId],
  );
  if (!rows[0]) throw notFound('project');
  return rows[0];
}

// ===== Hosted account (/api/v1/me + onboarding, OIDC user tokens) =====

function registerAccountRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  publicUrl: string,
  mcpRunner: McpRunnerConfig,
): void {
  app.get('/api/v1/me', async (req) => {
    requireKind(req.auth, 'user');
    const { rows } = await ctx.pool.query(
      `SELECT au.id, au.subject, au.email, au.name, au.picture_url,
         o.id AS org_id, o.name AS org_name, om.role
       FROM auth_users au
       JOIN organization_members om ON om.user_id = au.id
       JOIN organizations o ON o.id = om.org_id
       WHERE au.id = $1 AND o.id = $2
       LIMIT 1`,
      [req.auth.userId, req.auth.orgId],
    );
    const row = rows[0];
    if (!row) throw notFound('auth_user');
    return {
      user: {
        id: row.id,
        subject: row.subject,
        email: row.email,
        name: row.name,
        picture_url: row.picture_url,
      },
      organization: {
        id: row.org_id,
        name: row.org_name,
        role: row.role,
      },
      billing: await getBillingSummary(ctx.pool, req.auth.orgId),
      onboarding: {
        completed: await organizationHasProjects(ctx.pool, req.auth.orgId),
      },
    };
  });

  app.post('/api/v1/onboarding', async (req, reply) => {
    requireKind(req.auth, 'user');
    const body = req.body as { workspace_name?: string; project_slug?: string; project_name?: string };
    if (!body?.workspace_name || !body?.project_slug || !body?.project_name) {
      throw badRequest('validation_error', 'workspace_name, project_slug and project_name are required');
    }
    const result = await completeHostedOnboarding(ctx.pool, req.auth.orgId, {
      workspace_name: body.workspace_name,
      project_slug: body.project_slug,
      project_name: body.project_name,
    }, publicUrl, mcpRunner);
    return reply.status(201).send(result);
  });

  app.post('/api/v1/me/tokens', async (req, reply) => {
    requireTokenIssuanceAccess(req.auth);
    const body = req.body as { label?: string } | null;
    const created = await createApiKey(ctx.pool, {
      orgId: req.auth.orgId,
      projectId: null,
      kind: 'personal',
      label: body?.label?.trim() || 'hosted MCP token',
    });
    return reply.status(201).send(created);
  });
}

// ===== Platform (/api/v1, sk_/pt_ keys) =====

function registerPlatformRoutes(app: FastifyInstance, ctx: AppContext): void {
  const platform = (req: FastifyRequest) => {
    requirePlatformAccess(req.auth);
  };

  /** Resolve :slug within the caller's scope; secret keys are pinned to their project. */
  const resolveProject = async (req: FastifyRequest): Promise<Project> => {
    if (req.resolvedProject) return req.resolvedProject;
    const { slug } = req.params as { slug: string };
    const project = await getProjectBySlug(ctx.pool, req.auth.orgId, slug);
    if (req.auth.kind === 'secret' && req.auth.projectId !== project.id) {
      throw new ApiError(403, 'project_scope', 'this secret key belongs to a different project');
    }
    req.resolvedProject = project;
    return project;
  };

  app.get('/api/v1/projects', async (req) => {
    platform(req);
    const all = await listProjectsWithStats(ctx.pool, req.auth.orgId);
    // Secret keys are pinned to one project; personal tokens see the whole org.
    if (req.auth.kind === 'secret') {
      const { rows } = await ctx.pool.query('SELECT slug FROM projects WHERE id = $1', [req.auth.projectId]);
      const onlySlug = rows[0]?.slug as string | undefined;
      return { projects: all.filter((p) => p.slug === onlySlug), scope: 'project' };
    }
    return { projects: all, scope: 'org' };
  });

  app.post('/api/v1/projects', async (req, reply) => {
    platform(req);
    const body = req.body as { slug?: string; name?: string; timezone?: string };
    if (!body?.slug || !body?.name) {
      throw badRequest('validation_error', 'slug and name are required');
    }
    if (!/^[a-z][a-z0-9-]*$/.test(body.slug)) {
      throw badRequest('invalid_slug', 'slug must be lowercase letters, digits and hyphens, starting with a letter');
    }
    try {
      const project = await createProject(ctx.pool, req.auth.orgId, body.slug, body.name);
      // A new project has no data yet — return the same shape as the list (stats zeroed).
      return reply.status(201).send({
        slug: project.slug, name: project.name, timezone: project.timezone,
        active_metrics: 0, funnels: 0, events_30d: 0,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError(409, 'slug_taken', `a project with slug "${body.slug}" already exists in this org`);
      }
      throw err;
    }
  });

  // ----- API key management (admin) -----
  app.get('/api/v1/projects/:slug/keys', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { keys: await listApiKeys(ctx.pool, project.id) };
  });

  app.post('/api/v1/projects/:slug/keys', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const body = req.body as { kind?: string; env?: string; label?: string };
    if (body?.kind !== 'ingest' && body?.kind !== 'secret') {
      throw badRequest('invalid_kind', 'kind must be "ingest" or "secret"', 'personal tokens are issued via the CLI');
    }
    const created = await createApiKey(ctx.pool, {
      orgId: req.auth.orgId,
      projectId: project.id,
      kind: body.kind,
      ...(body.env ? { env: body.env } : {}),
      ...(body.label ? { label: body.label } : {}),
    });
    // The token is returned exactly once; only its hash is stored.
    return reply.status(201).send(created);
  });

  app.post('/api/v1/projects/:slug/keys/:id/revoke', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    await revokeApiKey(ctx.pool, req.auth.orgId, id, project.id);
    return { revoked: true };
  });

  // ----- instrumentation standard (so the admin can render setup docs) -----
  app.get('/api/v1/standard', async (req) => {
    platform(req);
    return { markdown: INSTRUMENTATION_STANDARD };
  });

  app.get('/api/v1/projects/:slug/schema', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env } = req.query as { env?: string };
    return getProjectSchema(ctx.pool, ctx.eventStore, project, env ?? 'prod');
  });

  // ----- browser experience -----
  app.post('/api/v1/projects/:slug/experience/surfaces', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const surface = await createExperienceSurface(ctx.pool, project.id, experienceSurfaceSchema.parse(req.body));
    ctx.query.invalidateProject(project.id);
    return reply.status(201).send(surface);
  });

  app.get('/api/v1/projects/:slug/experience/surfaces', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { surfaces: await listExperienceSurfaces(ctx.pool, project.id) };
  });

  app.post('/api/v1/projects/:slug/experience/surfaces/:key/archive', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const surface = await archiveExperienceSurface(ctx.pool, project.id, key);
    ctx.query.invalidateProject(project.id);
    return surface;
  });

  // ----- feature delivery -----
  app.post('/api/v1/projects/:slug/flags', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const input = featureFlagSchema.parse(req.body);
    return reply.status(201).send(await createFeatureFlag(ctx.pool, project.id, input));
  });

  app.get('/api/v1/projects/:slug/flags', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { flags: await listFeatureFlags(ctx.pool, project.id) };
  });

  app.patch('/api/v1/projects/:slug/flags/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const patch = updateFeatureFlagSchema.parse(req.body);
    return updateFeatureFlag(ctx.pool, project.id, key, patch);
  });

  app.post('/api/v1/projects/:slug/flags/:key/archive', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return archiveFeatureFlag(ctx.pool, project.id, key);
  });

  // Platform/MCP inspection path: intentionally evaluates without appending an
  // exposure event, so an agent can debug targeting without changing analysis.
  app.post('/api/v1/projects/:slug/flags/:key/evaluate', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const body = flagEvaluationSchema.omit({ key: true }).parse(req.body);
    return evaluateFeatureFlag(ctx.pool, ctx.eventStore, project.id, req.auth.env, { key, ...body }, { emitExposure: false });
  });

  app.post('/api/v1/projects/:slug/experiments', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const input = createExperimentSchema.parse(req.body);
    return reply.status(201).send(await createExperiment(ctx.pool, project.id, input));
  });

  app.get('/api/v1/projects/:slug/experiments', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { experiments: await listExperiments(ctx.pool, project.id) };
  });

  app.patch('/api/v1/projects/:slug/experiments/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return updateExperiment(ctx.pool, project.id, key, updateExperimentSchema.parse(req.body));
  });

  app.post('/api/v1/projects/:slug/experiments/:key/start', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return startExperiment(ctx.pool, project.id, key);
  });

  app.post('/api/v1/projects/:slug/experiments/:key/conclude', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return concludeExperiment(ctx.pool, project.id, key, concludeExperimentSchema.parse(req.body).decision ?? null);
  });

  app.get('/api/v1/projects/:slug/experiments/:key/results', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const { env } = req.query as { env?: string };
    return getExperimentResults(ctx.pool, ctx.eventStore, project.id, key, env ?? 'prod');
  });

  app.post('/api/v1/projects/:slug/metrics', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const input = registerMetricSchema.parse(req.body);
    const metric = await registerMetric(ctx.pool, project.id, input, authOwner(req.auth));
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return reply.status(201).send(metric);
  });

  app.patch('/api/v1/projects/:slug/metrics/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    if ((req.body as { status?: unknown } | null)?.status === 'deprecated') {
      throw badRequest(
        'use_deprecate_metric',
        'deprecated metrics must include a retirement reason',
        'call deprecate_metric or POST /metrics/{key}/deprecate with a reason so future agents understand why it was retired',
      );
    }
    const patch = updateMetricSchema.parse(req.body);
    const metric = await updateMetric(ctx.pool, project.id, key, patch);
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return metric;
  });

  app.post('/api/v1/projects/:slug/metrics/:key/deprecate', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const input = deprecateMetricSchema.parse(req.body);
    const metric = await deprecateMetric(ctx.pool, project.id, key, input);
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return metric;
  });

  app.get('/api/v1/projects/:slug/metrics/:key/usage', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const { env, since_days } = req.query as { env?: string; since_days?: string };
    return explainMetricUsage(
      ctx.pool,
      ctx.eventStore,
      project.id,
      key,
      env ?? 'prod',
      parseBoundedInt(since_days, 30, 1, 365, 'since_days'),
    );
  });

  app.get('/api/v1/projects/:slug/metrics', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { status, category } = req.query as { status?: string; category?: string };
    return { metrics: await listMetrics(ctx.pool, project.id, { ...(status && { status }), ...(category && { category }) }) };
  });

  app.delete('/api/v1/projects/:slug/metrics/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const result = await deleteMetric(ctx.pool, project.id, key);
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return { deleted: true, ...result };
  });

  app.post('/api/v1/projects/:slug/entity-types', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const input = registerEntityTypeSchema.parse(req.body);
    return reply.status(201).send(await registerEntityType(ctx.pool, project.id, input));
  });

  app.post('/api/v1/projects/:slug/funnels', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const input = defineFunnelSchema.parse(req.body);
    const funnel = await defineFunnel(ctx.pool, project.id, input);
    ctx.query.invalidateProject(project.id);
    return reply.status(201).send(funnel);
  });

  app.get('/api/v1/projects/:slug/funnels', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { funnels: await listFunnels(ctx.pool, project.id) };
  });

  app.delete('/api/v1/projects/:slug/funnels/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const result = await deleteFunnel(ctx.pool, project.id, key);
    ctx.query.invalidateProject(project.id);
    return { deleted: true, ...result };
  });

  // Danger zone: hard-purge a project's data, scoped to one env (and optionally
  // one actor). Irreversible. Secret-key only — keeps purge project-pinned, not
  // available to an org-wide personal token. The caller must echo the project
  // slug, mirroring the type-to-confirm gate in the UI.
  app.post('/api/v1/projects/:slug/data/purge', async (req) => {
    requireKind(req.auth, 'secret');
    const project = await resolveProject(req);
    const body = purgeDataSchema.parse(req.body);
    if (body.confirm_slug !== project.slug) {
      throw badRequest('confirmation_mismatch', 'confirm_slug must equal the project slug');
    }
    // distinct_id only scopes events; combining it with entities/all would
    // silently wipe every entity in the env while only scoping events — refuse.
    if (body.distinct_id && body.scope !== 'events') {
      throw badRequest('invalid_scope', 'distinct_id can only be used with scope=events');
    }
    let events_deleted = 0;
    let entities_deleted = 0;
    if (body.scope === 'events' || body.scope === 'all') {
      events_deleted = await ctx.eventStore.purge(project.id, body.env, body.distinct_id);
    }
    if (body.scope === 'entities' || body.scope === 'all') {
      entities_deleted = await deleteEntities(ctx.pool, project.id, body.env);
    }
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return { events_deleted, entities_deleted, env: body.env };
  });

  app.post('/api/v1/projects/:slug/query', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const q = querySchema.parse(req.body);
    return ctx.query.run(project.id, q);
  });

  app.get('/api/v1/projects/:slug/events/sample', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { event, registered, limit, env, distinct_id, from, to } = req.query as {
      event?: string; registered?: string; limit?: string; env?: string; distinct_id?: string; from?: string; to?: string;
    };
    const parsedLimit = limit ? Number(limit) : 20;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw badRequest('invalid_limit', 'limit must be an integer between 1 and 100');
    }
    // Repeatable `prop=key:op:value` → property filters, reusing the registry grammar.
    const raw = (req.query as { prop?: string | string[] }).prop;
    const filters = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(parsePropFilter);
    const events = await ctx.eventStore.sample({
      projectId: project.id,
      limit: parsedLimit,
      ...(env !== undefined && { env }),
      ...(event !== undefined && { event }),
      ...(registered !== undefined && { registered: registered === 'true' }),
      ...(distinct_id !== undefined && { distinct_id }),
      ...(from !== undefined && { from: parseDateInput(from) }),
      ...(to !== undefined && { to: parseDateInput(to) }),
      ...(filters.length > 0 && { filters }),
    });
    return { events };
  });

  app.get('/api/v1/projects/:slug/persons/:distinctId', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { distinctId } = req.params as { distinctId: string };
    const env = (req.query as { env?: string }).env ?? 'prod';
    const [summary, entity] = await Promise.all([
      ctx.eventStore.actorSummary(project.id, env, distinctId),
      getIdentityEntity(ctx.pool, project.id, env, distinctId),
    ]);
    return { distinct_id: distinctId, env, summary, entity };
  });

  app.get('/api/v1/projects/:slug/ingest-warnings', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env, kind } = req.query as { env?: string; kind?: string };
    return { warnings: await listIngestWarnings(ctx.pool, project.id, { ...(env && { env }), ...(kind && { kind: kind as WarningKind }) }) };
  });

  app.get('/api/v1/projects/:slug/data-quality', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env, limit, since_days } = req.query as { env?: string; limit?: string; since_days?: string };
    return listDataQualityIssues(
      ctx.pool,
      ctx.eventStore,
      project.id,
      env ?? 'prod',
      {
        limit: parseBoundedInt(limit, 50, 1, 200, 'limit'),
        sinceDays: parseBoundedInt(since_days, 30, 1, 365, 'since_days'),
      },
    );
  });

  app.delete('/api/v1/projects/:slug/ingest-warnings', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env } = req.query as { env?: string };
    return { cleared: await clearIngestWarnings(ctx.pool, project.id, env) };
  });

  app.get('/api/v1/projects/:slug/insights', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { status, kind } = req.query as { status?: string; kind?: string };
    return { insights: await listInsights(ctx.pool, project.id, { ...(status && { status }), ...(kind && { kind }) }) };
  });

  app.post('/api/v1/projects/:slug/insights', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const body = req.body as { title?: string; body?: string; query?: unknown; severity?: string };
    if (!body?.title || !body?.body) {
      throw badRequest('validation_error', 'title and body are required');
    }
    return reply.status(201).send(
      await createInsight(ctx.pool, project.id, {
        title: body.title,
        body: body.body,
        ...(body.query !== undefined && { query: body.query }),
        ...(body.severity !== undefined && { severity: body.severity }),
      }),
    );
  });

  app.patch('/api/v1/projects/:slug/insights/:id', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const { status } = req.body as { status?: string };
    if (status !== 'ack' && status !== 'resolved') {
      throw badRequest('validation_error', 'status must be "ack" or "resolved"');
    }
    return setInsightStatus(ctx.pool, project.id, id, status);
  });
}
