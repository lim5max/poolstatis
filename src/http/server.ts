import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { ZodError, z } from 'zod';
import type pg from 'pg';
import { ApiError, badRequest, databasePolicyError, notFound } from '../errors.js';
import { authenticate, requireKind, type AuthContext, type JwtAuthOptions } from './auth.js';
import { createContext, type AppContext, type CreateContextOptions } from './context.js';
import {
  completeHostedOnboarding, getAuthenticatedProfile, getBillingSummary, organizationHasProjects,
  requireOrganizationWriteReadiness, updateAuthenticatedProfile, type McpRunnerConfig,
} from '../services/accounts.js';
import { requiresOrganizationWriteReadiness } from './organizationWritePolicy.js';
import {
  createApiKey, createProject, getProjectBySlug, listApiKeys, listPersonalApiKeys,
  listProjectsWithStats, revokeApiKey, revokePersonalApiKey, type Project,
} from '../services/projects.js';
import { INSTRUMENTATION_STANDARD } from '../mcp/standard.js';
import {
  defineFunnel, deleteFunnel, deleteMetric, deprecateMetric, listFunnels, listMetrics,
  registerEntityType, registerMetric, updateMetric,
} from '../services/registry.js';
import {
  createMetricCategory, deleteMetricCategory, listMetricCategories, updateMetricCategory,
} from '../services/metricCategories.js';
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
  archiveExperienceSurface, captureExperienceEvents, createExperienceSnapshot, createExperienceSurface,
  deleteExperienceSnapshot, listExperienceRoutes, listExperienceSnapshots, listExperienceSurfaces,
  purgeExperienceSnapshots, readExperienceSnapshot, registerExperienceRoute,
} from '../services/experience.js';
import { createActorLink, listActorLinks, revokeActorLink } from '../services/identity.js';
import {
  createPropertyDefinition, listPropertyDefinitions, updatePropertyDefinition,
  type PropertyDefinition,
} from '../services/properties.js';
import { preflightAcquisitionProperties, proposeAcquisitionProperties } from '../services/acquisitionAttribution.js';
import {
  preflightBrowserAnalyticsMetrics,
  preflightBrowserAnalyticsProperties,
  proposeBrowserAnalyticsMetrics,
  proposeBrowserAnalyticsProperties,
} from '../services/browserAnalytics.js';
import { UNKNOWN_COUNTRY_RESOLVER, type CountryResolver } from '../services/country.js';
import { assessMeasurementTrust } from '../services/measurementTrust.js';
import {
  applyDeclaration, diffDeclaration, exportDeclaration, getContract, listContracts,
  validateDeclaration,
} from '../services/contracts.js';
import { getRelease, listReleases, registerRelease, transitionRelease } from '../services/releases.js';
import { evaluateRelease } from '../services/evaluation.js';
import { getDecision, listDecisions, reviseDecision } from '../services/decisions.js';
import { explainDecision, listDecisionExplanations } from '../services/explanations.js';
import {
  approveAction, getAction, listActions, prepareAction, rejectAction, retryAction,
} from '../services/actions.js';
import { getDecisionInbox } from '../services/webhooks.js';
import type { OutboundPolicyOptions } from '../security/outbound.js';
import { getOrganizationUsage } from '../services/usage.js';
import { searchDecisionHistory, similarPastChanges } from '../services/decisionMemory.js';
import {
  acknowledgeOnboardingGate, getOnboardingStatus, recordAgentObservation, recordQueryRun,
} from '../services/onboarding.js';
import { parseDateInput } from '../dates.js';
import {
  RateLimitExceeded, TenantRateLimiter, type TenantRateLimitOptions,
} from '../services/rateLimiter.js';
import {
  deprecateMetricSchema, applyMeasurementDeclarationSchema, approveDecisionActionSchema, editDecisionSchema, measurementDeclarationSchema, prepareDecisionActionSchema, rejectDecisionActionSchema, reviewDecisionSchema,
  actorLinkSchema, concludeExperimentSchema, createExperimentSchema, defineFunnelSchema, entityUpsertSchema, experienceCaptureSchema, experienceRouteRegistrationSchema, experienceSnapshotMetaSchema, experienceSurfaceSchema, featureFlagSchema, flagEvaluationSchema, ingestEnvelopeSchema, measurementTrustSchema, posthogConnectionSchema, propertyDefinitionSchema, propertyFilterSchema, purgeDataSchema,
  createMetricCategorySchema, querySchema, registerEntityTypeSchema, registerMetricSchema, registerReleaseSchema, transitionReleaseSchema, updateMetricCategorySchema, updateMetricSchema, webhookDestinationSchema, type PropertyFilter,
  updateExperimentSchema, updateFeatureFlagSchema, updatePropertyDefinitionSchema,
  createPersonalTokenSchema, createProjectSchema, hostedOnboardingSchema, updateProfileSchema, usagePeriodSchema,
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
  manageEventPartitions?: boolean;
  queryCache?: CreateContextOptions['queryCache'];
  rateLimit?: TenantRateLimitOptions | false;
  connectorEncryptionKey?: string;
  corsOrigins?: string[];
  outboundPolicy?: OutboundPolicyOptions;
  artifactStore?: CreateContextOptions['artifactStore'];
  artifactDir?: string;
  countryResolver?: CountryResolver;
}

const NUMERIC_TOKEN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const PUBLIC_BROWSER_WRITE_CORS_ROUTES = new Set([
  '/i/v1/events',
  '/i/v1/experience/events',
  '/i/v1/flags/evaluate',
]);
const PUBLIC_BROWSER_WRITE_CORS_HEADERS = new Set([
  'authorization',
  'content-type',
  'x-poolstatis-client',
]);

function requestPath(req: FastifyRequest): string {
  return req.url.split('?', 1)[0] ?? req.url;
}

function isCanonicalHttpsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin;
  } catch {
    return false;
  }
}

function hasPublicIngestBearer(req: FastifyRequest): boolean {
  return /^Bearer\s+pk_/i.test(req.headers.authorization ?? '');
}

function hasAllowedPublicPreflightHeaders(req: FastifyRequest): boolean {
  const requested = req.headers['access-control-request-headers'];
  if (typeof requested !== 'string') return false;
  const headers = requested.split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
  return headers.includes('authorization')
    && headers.every((header) => PUBLIC_BROWSER_WRITE_CORS_HEADERS.has(header));
}

function isPublicBrowserWriteCorsRequest(
  req: FastifyRequest,
  origin: string,
  configuredOrigins: ReadonlySet<string>,
): boolean {
  if (configuredOrigins.has(origin)
    || !PUBLIC_BROWSER_WRITE_CORS_ROUTES.has(requestPath(req))
    || !isCanonicalHttpsOrigin(origin)) {
    return false;
  }
  if (req.method === 'OPTIONS') {
    return req.headers['access-control-request-method']?.toUpperCase() === 'POST'
      && hasAllowedPublicPreflightHeaders(req);
  }
  return req.method === 'POST' && !req.headers.cookie && hasPublicIngestBearer(req);
}

function authOwner(auth: AuthContext): string {
  return auth.keyId ? `key:${auth.keyId}` : `user:${auth.userId}`;
}

/** Hosted identities fail closed without a current owner/admin role. */
export function hasOrganizationManagementRole(auth: AuthContext): boolean {
  if (auth.kind === 'user') {
    return auth.userRole === 'owner' || auth.userRole === 'admin';
  }
  if (auth.kind === 'personal') {
    // Ownerless personal tokens predate hosted auth and remain self-host compatible.
    return auth.userId === undefined || auth.userRole === 'owner' || auth.userRole === 'admin';
  }
  return false;
}

function requirePlatformAccess(auth: AuthContext): void {
  requireKind(auth, 'secret', 'personal', 'user');
  if ((auth.kind === 'user' || auth.kind === 'personal')
    && !hasOrganizationManagementRole(auth)) {
    throw new ApiError(
      403,
      'insufficient_role',
      'this hosted account role cannot manage platform resources',
      'ask an owner or admin to upgrade your workspace role',
    );
  }
}

/** Usage is organization-wide: never expose it through a project secret key. */
function requireUsageReadAccess(auth: AuthContext): void {
  if ((auth.kind === 'user' || auth.kind === 'personal')
    && auth.projectId === null
    && hasOrganizationManagementRole(auth)) return;
  if (auth.kind === 'user' || auth.kind === 'personal') {
    throw new ApiError(
      403,
      'insufficient_role',
      'this hosted account role cannot read organization usage',
      'ask an owner or admin to upgrade your workspace role',
    );
  }
  throw new ApiError(
    403,
    'insufficient_scope',
    'organization usage requires a hosted user or organization-wide personal token',
    'use a hosted user session or a personal token with no project scope',
  );
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

/** A hosted user may always inspect or revoke only their own personal tokens. */
function requireOwnedTokenAccess(auth: AuthContext): void {
  requireKind(auth, 'user');
}

/** Organization-scoped mutations must never be authorized by an exact-project secret key. */
function requireOrganizationManagementAccess(auth: AuthContext): void {
  if (auth.kind === 'secret') {
    throw new ApiError(
      403,
      'insufficient_scope',
      'a secret key is scoped to one project and cannot create organization projects',
      'use a personal token or hosted owner/admin account',
    );
  }
  requireKind(auth, 'personal', 'user');
  if ((auth.kind === 'user' || auth.kind === 'personal')
    && !hasOrganizationManagementRole(auth)) {
    throw new ApiError(
      403,
      'insufficient_role',
      'this hosted account role cannot manage organization projects',
      'ask an owner or admin to upgrade your workspace role',
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

function parseOptionalDate(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw badRequest('invalid_query_param', `${name} must be an ISO date-time`);
  }
  return value.toISOString();
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
  if (options.manageEventPartitions !== undefined) {
    contextOptions.manageEventPartitions = options.manageEventPartitions;
  }
  if (options.queryCache !== undefined) contextOptions.queryCache = options.queryCache;
  if (options.connectorEncryptionKey !== undefined) {
    contextOptions.connectorEncryptionKey = options.connectorEncryptionKey;
  }
  if (options.outboundPolicy !== undefined) contextOptions.outboundPolicy = options.outboundPolicy;
  if (options.artifactStore !== undefined) contextOptions.artifactStore = options.artifactStore;
  if (options.artifactDir !== undefined) contextOptions.artifactDir = options.artifactDir;
  if (options.countryResolver?.attribution !== undefined) {
    contextOptions.countryAttribution = options.countryResolver.attribution;
  }
  const ctx = createContext(pool, contextOptions);
  const app = Fastify({ logger: false });
  (app as FastifyInstance & { countryResolver?: CountryResolver }).countryResolver =
    options.countryResolver ?? UNKNOWN_COUNTRY_RESOLVER;
  app.addContentTypeParser(['image/png', 'image/webp'], { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  const rateLimiter = options.rateLimit === false || options.rateLimit === undefined
    ? null
    : new TenantRateLimiter(options.rateLimit);
  const credentialAttemptLimiter = options.rateLimit === false || options.rateLimit === undefined
    ? null
    : new TenantRateLimiter(credentialAttemptLimits(options.rateLimit));
  const publicUrl = (options.publicUrl ?? 'https://api.poolstatis.com').replace(/\/$/, '');
  const mcpRunner = options.mcpRunner ?? {
    command: 'pnpm',
    args: ['--silent', '--dir', '<path-to-poolstatis-core>', 'mcp'],
    packageStatus: 'publish_pending' as const,
    note: 'Registry install is disabled. Replace <path-to-poolstatis-core> with an exact local Core checkout path.',
  };
  const corsOrigins = new Set(options.corsOrigins ?? []);

  void app.register(cors, {
    delegator(req, callback) {
      const origin = req.headers.origin;
      const configured = !origin || corsOrigins.has(origin);
      const publicBrowserWrite = origin
        ? isPublicBrowserWriteCorsRequest(req, origin, corsOrigins)
        : false;
      callback(null, {
        origin: configured || publicBrowserWrite,
        methods: publicBrowserWrite ? ['POST'] : ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['authorization', 'content-type', 'x-poolstatis-client'],
        credentials: false,
      });
    },
  });

  // Authentication runs in an onRequest hook and can reject before a route
  // handler is reached. Set the actual-response CORS headers in the root scope
  // before authentication so browser clients can read neutral 4xx/5xx bodies.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    void reply.header('vary', 'Origin');
    if (corsOrigins.has(origin) || isPublicBrowserWriteCorsRequest(req, origin, corsOrigins)) {
      void reply.header('access-control-allow-origin', origin);
    }
  });

  app.addHook('onRequest', async (req) => {
    const origin = req.headers.origin;
    if (!origin || corsOrigins.has(origin) || req.method === 'OPTIONS') return;
    if (PUBLIC_BROWSER_WRITE_CORS_ROUTES.has(requestPath(req))
      && isCanonicalHttpsOrigin(origin)
      && req.headers.cookie) {
      throw new ApiError(
        403,
        'browser_credentials_forbidden',
        'public browser ingest does not accept cookies',
        'send only a write-only pk_ ingest key in the Authorization header',
      );
    }
  });

  // Unauthenticated liveness probe the dashboard uses to check the base URL
  // before a token is entered.
  app.get('/health', async () => ({ status: 'ok', service: 'poolstatis' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready', service: 'poolstatis' };
    } catch {
      return reply.status(503).send({
        error: { code: 'dependencies_not_ready', message: 'dependencies are not ready' },
      });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send(err.toBody());
    }
    const policyError = databasePolicyError(err);
    if (policyError) {
      return reply.status(policyError.statusCode).send(policyError.toBody());
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
    // CORS preflight and public probes carry no token.
    if (req.method === 'OPTIONS' || req.url === '/health' || req.url === '/ready') return;
    req.auth = await authenticate(pool, req.headers.authorization, options.auth);
  });

  if (credentialAttemptLimiter) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method === 'OPTIONS' || req.url === '/health' || req.url === '/ready') return;
      const lane = req.url.startsWith('/i/v1/') ? 'ingest' as const : 'api' as const;
      try {
        credentialAttemptLimiter.consume({
          lane,
          tenantId: req.auth.orgId,
          keyId: authOwner(req.auth),
          projectId: lane === 'ingest'
            ? req.auth.projectId ?? `org:${req.auth.orgId}`
            : 'credential-attempts',
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
    });
  }

  // Keep this hook unconditional: hosted writes must still fail closed when
  // rate limiting is disabled. A configured bounded credential-attempt lane
  // runs first, while project lookup and body validation remain after policy.
  app.addHook('preHandler', async (req) => {
    if (options.auth?.requireOrganizationPolicy === true
      && requiresOrganizationWriteReadiness(req.method, req.routeOptions.url)) {
      await requireOrganizationWriteReadiness(pool, req.auth.orgId);
    }
  });

  if (rateLimiter) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method === 'OPTIONS' || req.url === '/health' || req.url === '/ready') return;
      const lane = req.url.startsWith('/i/v1/') ? 'ingest' as const : 'api' as const;
      const slug = (req.params as { slug?: string } | undefined)?.slug;
      if (lane === 'ingest') {
        requireKind(req.auth, 'ingest');
      } else {
        const route = req.routeOptions.url;
        if (route === '/api/v1/me' || route === '/api/v1/onboarding') {
          requireKind(req.auth, 'user');
        } else if (route === '/api/v1/me/usage') {
          requireUsageReadAccess(req.auth);
        } else if (route === '/api/v1/me/tokens' && req.method === 'POST') {
          requireTokenIssuanceAccess(req.auth);
        } else if (route === '/api/v1/me/tokens' || route === '/api/v1/me/tokens/:id') {
          requireOwnedTokenAccess(req.auth);
        } else if (route === '/api/v1/projects' && req.method === 'POST') {
          requireOrganizationManagementAccess(req.auth);
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
  const attemptLane = (lane: TenantRateLimitOptions['api']) => ({
    key: {
      ratePerSecond: lane.key.ratePerSecond,
      burst: Math.max(10, lane.key.burst * 2),
    },
    project: {
      ratePerSecond: Math.max(lane.key.ratePerSecond, lane.project.ratePerSecond),
      burst: Math.max(21, lane.project.burst * 2),
    },
  });
  return {
    ingest: attemptLane(options.ingest),
    api: attemptLane(options.api),
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
    const country = (app as FastifyInstance & { countryResolver?: CountryResolver }).countryResolver
      ?.resolve({
        headers: req.headers as Record<string, string | string[] | undefined>,
        ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
      }) ?? 'unknown';
    const result = await ctx.ingest.processBatch(project, req.auth.env, body, new Date(), { country });
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
    return hostedAccountResponse(ctx, req.auth);
  });

  app.patch('/api/v1/me', async (req) => {
    requireKind(req.auth, 'user');
    const input = updateProfileSchema.parse(req.body);
    await updateAuthenticatedProfile(ctx.pool, req.auth.userId!, input.display_name);
    return hostedAccountResponse(ctx, req.auth);
  });

  app.post('/api/v1/onboarding', async (req, reply) => {
    requireKind(req.auth, 'user');
    requireOrganizationManagementAccess(req.auth);
    const body = hostedOnboardingSchema.parse(req.body);
    const result = await completeHostedOnboarding(ctx.pool, req.auth.orgId, req.auth.userId!, body, publicUrl, mcpRunner);
    return reply.status(201).send(result);
  });

  app.post('/api/v1/me/tokens', async (req, reply) => {
    requireTokenIssuanceAccess(req.auth);
    const body = createPersonalTokenSchema.parse(req.body ?? {});
    const created = await createApiKey(ctx.pool, {
      orgId: req.auth.orgId,
      projectId: null,
      kind: 'personal',
      label: body.label ?? 'hosted MCP token',
      issuedByUserId: req.auth.userId!,
    });
    return reply.status(201).send(created);
  });

  app.get('/api/v1/me/tokens', async (req) => {
    requireOwnedTokenAccess(req.auth);
    return { tokens: await listPersonalApiKeys(ctx.pool, req.auth.orgId, req.auth.userId!) };
  });

  app.delete('/api/v1/me/tokens/:id', async (req) => {
    requireOwnedTokenAccess(req.auth);
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    await revokePersonalApiKey(ctx.pool, req.auth.orgId, req.auth.userId!, id);
    return { revoked: true };
  });
}

async function hostedAccountResponse(ctx: AppContext, auth: AuthContext) {
  const account = await getAuthenticatedProfile(ctx.pool, auth.userId!, auth.orgId);
  if (!account) throw notFound('auth_user');
  return {
    user: {
      id: account.user.id,
      subject: account.user.subject,
      email: account.user.email,
      email_verified: account.user.email_verified,
      display_name: account.user.display_name,
      name: account.user.name,
      picture_url: account.user.picture_url,
      connection_strategy: account.user.connection_strategy,
    },
    identity: {
      issuer: account.user.identity_issuer,
      subject: account.user.subject,
    },
    organization: {
      id: account.organization.id,
      name: account.organization.name,
      role: account.organization.role,
    },
    membership: {
      organization_id: account.organization.id,
      role: account.organization.role,
    },
    billing: await getBillingSummary(ctx.pool, auth.orgId),
    onboarding: {
      completed: await organizationHasProjects(ctx.pool, auth.orgId),
    },
  };
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

  app.get('/api/v1/me/usage', async (req) => {
    requireUsageReadAccess(req.auth);
    const { period } = req.query as { period?: string };
    if (!period || !usagePeriodSchema.safeParse(period).success) {
      throw badRequest('invalid_query_param', 'period must be a UTC month in YYYY-MM format');
    }
    // The organization comes only from the authenticated credential. Caller
    // query parameters never widen an organization-scoped usage read.
    return getOrganizationUsage(ctx.pool, req.auth.orgId, period);
  });

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
    requireOrganizationManagementAccess(req.auth);
    const body = createProjectSchema.parse(req.body);
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
    const { env = req.auth.env } = req.query as { env?: string };
    return { surfaces: await listExperienceSurfaces(ctx.pool, ctx.eventStore, project.id, env) };
  });

  app.post('/api/v1/projects/:slug/experience/surfaces/:key/archive', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const surface = await archiveExperienceSurface(ctx.pool, project.id, key);
    ctx.query.invalidateProject(project.id);
    return surface;
  });

  app.post('/api/v1/projects/:slug/experience/surfaces/:key/routes', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    const route = await registerExperienceRoute(
      ctx.pool,
      project.id,
      key,
      experienceRouteRegistrationSchema.parse(req.body),
    );
    return reply.status(201).send(route);
  });

  app.get('/api/v1/projects/:slug/experience/routes', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { surface } = req.query as { surface?: string };
    return { routes: await listExperienceRoutes(ctx.pool, project.id, surface) };
  });

  app.post('/api/v1/projects/:slug/experience/snapshots', {
    bodyLimit: 6 * 1024 * 1024,
  }, async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const query = req.query as Record<string, string | undefined>;
    const meta = experienceSnapshotMetaSchema.parse({
      surface: query.surface,
      route: query.route,
      version: query.version,
      device: query.device,
      env: query.env ?? req.auth.env,
      release_hash: query.release_hash,
      viewport_width: query.viewport_width ? Number(query.viewport_width) : undefined,
      viewport_height: query.viewport_height ? Number(query.viewport_height) : undefined,
      document_width: query.document_width ? Number(query.document_width) : undefined,
      document_height: query.document_height ? Number(query.document_height) : undefined,
      captured_at: query.captured_at,
      retention_days: query.retention_days ? Number(query.retention_days) : undefined,
    });
    const mimeType = String(req.headers['content-type'] ?? '').split(';')[0]!;
    if (!Buffer.isBuffer(req.body)) throw badRequest('snapshot_body_invalid', 'snapshot body must be raw PNG or WebP bytes');
    return reply.status(201).send(await createExperienceSnapshot(
      ctx.pool,
      ctx.artifacts,
      project.id,
      meta,
      mimeType,
      req.body,
    ));
  });

  app.get('/api/v1/projects/:slug/experience/snapshots', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { surface, route, env } = req.query as { surface?: string; route?: string; env?: string };
    return {
      snapshots: await listExperienceSnapshots(ctx.pool, project.id, {
        ...(surface ? { surface } : {}),
        ...(route ? { route } : {}),
        ...(env ? { env } : {}),
      }),
    };
  });

  app.get('/api/v1/projects/:slug/experience/snapshots/:id/image', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const { snapshot, bytes } = await readExperienceSnapshot(ctx.pool, ctx.artifacts, project.id, id);
    return reply
      .header('content-type', snapshot.mime_type)
      .header('content-length', String(snapshot.byte_size))
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });

  app.delete('/api/v1/projects/:slug/experience/snapshots/:id', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    await deleteExperienceSnapshot(ctx.pool, ctx.artifacts, project.id, id);
    return reply.status(204).send();
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

  app.get('/api/v1/projects/:slug/metric-categories', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { categories: await listMetricCategories(ctx.pool, project.id) };
  });

  app.post('/api/v1/projects/:slug/metric-categories', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const category = await createMetricCategory(
      ctx.pool,
      project.id,
      createMetricCategorySchema.parse(req.body),
    );
    return reply.status(201).send(category);
  });

  app.patch('/api/v1/projects/:slug/metric-categories/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return updateMetricCategory(
      ctx.pool,
      project.id,
      key,
      updateMetricCategorySchema.parse(req.body),
    );
  });

  app.delete('/api/v1/projects/:slug/metric-categories/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return { deleted: true, ...await deleteMetricCategory(ctx.pool, project.id, key) };
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
    let snapshots_deleted = 0;
    if (body.scope === 'events' || body.scope === 'all') {
      events_deleted = await ctx.eventStore.purge(project.id, body.env, body.distinct_id);
    }
    if (body.scope === 'entities' || body.scope === 'all') {
      entities_deleted = await deleteEntities(ctx.pool, project.id, body.env);
    }
    if (body.scope === 'all') {
      snapshots_deleted = await purgeExperienceSnapshots(
        ctx.pool,
        ctx.artifacts,
        project.id,
        body.env,
      );
    }
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return { events_deleted, entities_deleted, snapshots_deleted, env: body.env };
  });

  app.post('/api/v1/projects/:slug/query', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const q = querySchema.parse(req.body);
    const result = await ctx.query.run(project.id, q);
    await recordQueryRun(ctx.pool, project.id, q.env, q, result, authOwner(req.auth));
    return result;
  });

  app.post('/api/v1/projects/:slug/identity-links', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const link = await createActorLink(
      ctx.pool,
      project.id,
      actorLinkSchema.parse(req.body),
      authOwner(req.auth),
    );
    ctx.query.invalidateProject(project.id);
    return reply.status(201).send(link);
  });

  app.get('/api/v1/projects/:slug/identity-links', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env = req.auth.env } = req.query as { env?: string };
    return listActorLinks(ctx.pool, project.id, env);
  });

  app.post('/api/v1/projects/:slug/identity-links/:id/revoke', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const link = await revokeActorLink(ctx.pool, project.id, id, authOwner(req.auth));
    ctx.query.invalidateProject(project.id);
    return link;
  });

  app.post('/api/v1/projects/:slug/onboarding/observe-agent', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    if (req.headers['x-poolstatis-client'] !== 'mcp') {
      throw badRequest(
        'mcp_observation_required',
        'agent use is recorded only from a request marked by the MCP transport',
        'call get_onboarding_status through the configured MCP client',
      );
    }
    const body = req.body as { client?: string; env?: string };
    const client = body?.client?.trim();
    const env = body?.env?.trim() || req.auth.env;
    if (!client || client.length > 100) {
      throw badRequest('validation_error', 'client must be a non-empty identifier up to 100 characters');
    }
    await recordAgentObservation(ctx.pool, project.id, env, client, authOwner(req.auth));
    return { observed: true, client, env };
  });

  app.get('/api/v1/projects/:slug/onboarding/status', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env = req.auth.env } = req.query as { env?: string };
    return getOnboardingStatus(ctx.pool, ctx.eventStore, project.id, env);
  });

  app.post('/api/v1/projects/:slug/onboarding/acknowledgements', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const body = req.body as { gate_key?: string; reason?: string; env?: string };
    const gateKey = body?.gate_key?.trim();
    const reason = body?.reason?.trim();
    const env = body?.env?.trim() || req.auth.env;
    if (!gateKey || !reason || reason.length < 10) {
      throw badRequest(
        'validation_error',
        'gate_key and a reason of at least 10 characters are required',
      );
    }
    await acknowledgeOnboardingGate(
      ctx.pool,
      project.id,
      env,
      gateKey,
      reason,
      authOwner(req.auth),
    );
    return { acknowledged: true, gate_key: gateKey, env };
  });

  app.post('/api/v1/projects/:slug/sources/posthog', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const connection = await ctx.posthog.configure(
      project.id,
      posthogConnectionSchema.parse(req.body),
      authOwner(req.auth),
    );
    return reply.status(201).send(connection);
  });

  app.get('/api/v1/projects/:slug/sources', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { sources: await ctx.posthog.list(project.id) };
  });

  app.post('/api/v1/projects/:slug/sources/posthog/:id/verify', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return ctx.posthog.verify(project.id, id);
  });

  app.get('/api/v1/projects/:slug/sources/posthog/:id/schema', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return ctx.posthog.discoverSchema(project.id, id);
  });

  app.get('/api/v1/projects/:slug/sources/posthog/:id/sample', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const { event, limit } = req.query as { event?: string; limit?: string };
    if (!event?.trim()) {
      throw badRequest('validation_error', 'event is required for a bounded PostHog sample');
    }
    const parsedLimit = parseBoundedInt(limit, 20, 1, 100, 'limit');
    return { events: await ctx.posthog.sample(project.id, id, event, parsedLimit) };
  });

  app.post('/api/v1/projects/:slug/properties', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const property = await createPropertyDefinition(
      ctx.pool,
      project.id,
      propertyDefinitionSchema.parse(req.body),
      authOwner(req.auth),
    );
    return reply.status(201).send(property);
  });

  app.post('/api/v1/projects/:slug/properties/acquisition-attribution', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return {
      properties: await proposeAcquisitionProperties(ctx.pool, project.id, authOwner(req.auth)),
    };
  });

  app.post('/api/v1/projects/:slug/properties/browser-analytics', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const actor = authOwner(req.auth);
    const client = await ctx.pool.connect();
    let result: {
      properties: Awaited<ReturnType<typeof proposeBrowserAnalyticsProperties>>;
      metrics: Awaited<ReturnType<typeof proposeBrowserAnalyticsMetrics>>;
    };
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`browser-analytics-setup:${project.id}`],
      );
      await preflightBrowserAnalyticsProperties(client, project.id);
      await preflightAcquisitionProperties(client, project.id);
      await preflightBrowserAnalyticsMetrics(client, project.id);
      result = {
        properties: [
          ...await proposeBrowserAnalyticsProperties(client, project.id, actor),
          ...await proposeAcquisitionProperties(client, project.id, actor),
        ],
        metrics: await proposeBrowserAnalyticsMetrics(client, project.id, actor),
      };
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    ctx.ingest.invalidateRegistry(project.id);
    ctx.query.invalidateProject(project.id);
    return result;
  });

  app.get('/api/v1/projects/:slug/properties', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { scope, status } = req.query as { scope?: string; status?: string };
    return {
      properties: await listPropertyDefinitions(ctx.pool, project.id, {
        ...(scope ? { scope } : {}),
        ...(status ? { status } : {}),
      }),
    };
  });

  app.patch('/api/v1/projects/:slug/properties/:scope/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { scope, key } = req.params as { scope: string; key: string };
    if (scope !== 'event' && scope !== 'actor' && scope !== 'entity') {
      throw badRequest('invalid_property_scope', 'scope must be event, actor or entity');
    }
    return updatePropertyDefinition(
      ctx.pool,
      project.id,
      scope as PropertyDefinition['scope'],
      key,
      updatePropertyDefinitionSchema.parse(req.body),
    );
  });

  app.post('/api/v1/projects/:slug/measurement/trust', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return assessMeasurementTrust(
      ctx.pool,
      ctx.eventStore,
      project.id,
      measurementTrustSchema.parse(req.body),
      ctx.posthog,
    );
  });

  app.post('/api/v1/projects/:slug/contracts/validate', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return validateDeclaration(
      ctx.pool,
      project.id,
      measurementDeclarationSchema.parse(req.body),
    );
  });

  app.post('/api/v1/projects/:slug/contracts/diff', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return diffDeclaration(
      ctx.pool,
      project.id,
      measurementDeclarationSchema.parse(req.body),
    );
  });

  app.post('/api/v1/projects/:slug/contracts/apply', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const body = applyMeasurementDeclarationSchema.parse(req.body);
    return applyDeclaration(ctx.pool, project.id, body.declaration, {
      confirmExistingChanges: body.confirm_existing_changes,
      ...(body.expected_revision ? { expectedRevision: body.expected_revision } : {}),
      actor: authOwner(req.auth),
    });
  });

  app.get('/api/v1/projects/:slug/contracts', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { contracts: await listContracts(ctx.pool, project.id) };
  });

  app.get('/api/v1/projects/:slug/contracts/export', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return {
      filename: 'poolstatis.yml',
      yaml: await exportDeclaration(ctx.pool, project.id),
    };
  });

  app.post('/api/v1/projects/:slug/contracts/similar', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { changes: await similarPastChanges(ctx.pool, project.id, measurementDeclarationSchema.parse(req.body)) };
  });

  app.get('/api/v1/projects/:slug/contracts/:key', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { key } = req.params as { key: string };
    return getContract(ctx.pool, project.id, key);
  });

  app.post('/api/v1/projects/:slug/releases', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const release = await registerRelease(
      ctx.pool,
      project.id,
      registerReleaseSchema.parse(req.body),
      authOwner(req.auth),
    );
    return reply.status(release.idempotent ? 200 : 201).send(release);
  });

  app.get('/api/v1/projects/:slug/releases', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { env, status, contract_key, experiment_key, originating_decision_id } = req.query as {
      env?: string; status?: string; contract_key?: string; experiment_key?: string; originating_decision_id?: string;
    };
    return {
      releases: await listReleases(ctx.pool, project.id, {
        ...(env ? { env } : {}),
        ...(status ? { status } : {}),
        ...(contract_key ? { contractKey: contract_key } : {}),
        ...(experiment_key ? { experimentKey: experiment_key } : {}),
        ...(originating_decision_id ? { originatingDecisionId: originating_decision_id } : {}),
      }),
    };
  });

  app.get('/api/v1/projects/:slug/releases/:id', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return getRelease(ctx.pool, project.id, id);
  });

  app.post('/api/v1/projects/:slug/releases/:id/transition', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return transitionRelease(
      ctx.pool,
      project.id,
      id,
      transitionReleaseSchema.parse(req.body),
      authOwner(req.auth),
    );
  });

  app.post('/api/v1/projects/:slug/releases/:id/evaluate', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const result = await evaluateRelease(
      ctx.pool,
      ctx.query,
      project.id,
      id,
      authOwner(req.auth),
    );
    return reply.status(result.idempotent ? 200 : 201).send(result);
  });

  app.get('/api/v1/projects/:slug/decisions', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { status, release_id } = req.query as { status?: string; release_id?: string };
    return {
      decisions: await listDecisions(ctx.pool, project.id, {
        ...(status ? { status } : {}),
        ...(release_id ? { releaseId: release_id } : {}),
      }),
    };
  });

  app.get('/api/v1/projects/:slug/decisions/search', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const query = req.query as Record<string, string | undefined>;
    return searchDecisionHistory(ctx.pool, project.id, {
      ...(query.metric ? { metric: query.metric } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.owner ? { owner: query.owner } : {}),
      ...(query.contract ? { contract: query.contract } : {}),
      ...(query.experiment ? { experiment: query.experiment } : {}),
      ...(query.status && ['proposed', 'approved', 'rejected'].includes(query.status)
        ? { status: query.status as 'proposed' | 'approved' | 'rejected' }
        : {}),
      ...(query.from ? { from: parseOptionalDate(query.from, 'from')! } : {}),
      ...(query.to ? { to: parseOptionalDate(query.to, 'to')! } : {}),
      ...(query.limit ? { limit: parseBoundedInt(query.limit, 50, 1, 100, 'limit') } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });

  app.get('/api/v1/projects/:slug/decisions/:id', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return getDecision(ctx.pool, project.id, id);
  });

  app.post('/api/v1/projects/:slug/decisions/:id/approve', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const { rationale } = reviewDecisionSchema.parse(req.body);
    return reviseDecision(ctx.pool, project.id, id, { action: 'approve', rationale }, authOwner(req.auth));
  });

  app.post('/api/v1/projects/:slug/decisions/:id/reject', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const { rationale } = reviewDecisionSchema.parse(req.body);
    return reviseDecision(ctx.pool, project.id, id, { action: 'reject', rationale }, authOwner(req.auth));
  });

  app.post('/api/v1/projects/:slug/decisions/:id/edit', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const { outcome, rationale } = editDecisionSchema.parse(req.body);
    return reviseDecision(
      ctx.pool,
      project.id,
      id,
      { action: 'edit', outcome, rationale },
      authOwner(req.auth),
    );
  });

  app.post('/api/v1/projects/:slug/decisions/:id/explain', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const result = await explainDecision(ctx.pool, ctx.query, project.id, id, authOwner(req.auth));
    return reply.status(result.idempotent ? 200 : 201).send(result.explanation);
  });

  app.get('/api/v1/projects/:slug/decisions/:id/explanations', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return { explanations: await listDecisionExplanations(ctx.pool, project.id, id) };
  });

  app.post('/api/v1/projects/:slug/decisions/:id/actions', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const result = await prepareAction(
      ctx.pool, project.id, id, prepareDecisionActionSchema.parse(req.body), authOwner(req.auth),
    );
    return reply.status(result.idempotent ? 200 : 201).send(result.detail);
  });

  app.get('/api/v1/projects/:slug/decisions/:id/actions', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return { actions: await listActions(ctx.pool, project.id, { decisionId: id }) };
  });

  app.get('/api/v1/projects/:slug/actions/:id', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return getAction(ctx.pool, project.id, id);
  });

  app.post('/api/v1/projects/:slug/actions/:id/approve', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const body = approveDecisionActionSchema.parse(req.body);
    return approveAction(ctx.pool, project.id, id, body.confirmation_fingerprint, authOwner(req.auth), {
      enqueueWebhook: (input) => ctx.webhooks.enqueueAction(input),
    });
  });

  app.post('/api/v1/projects/:slug/actions/:id/reject', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    const body = rejectDecisionActionSchema.parse(req.body);
    return rejectAction(ctx.pool, project.id, id, body.rationale, authOwner(req.auth));
  });

  app.post('/api/v1/projects/:slug/actions/:id/retry', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return retryAction(ctx.pool, project.id, id, authOwner(req.auth), {
      enqueueWebhook: (input) => ctx.webhooks.enqueueAction(input),
    });
  });

  app.post('/api/v1/projects/:slug/webhooks', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const destination = await ctx.webhooks.configure(
      project.id, webhookDestinationSchema.parse(req.body), authOwner(req.auth),
    );
    return reply.status(201).send(destination);
  });

  app.get('/api/v1/projects/:slug/webhooks', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { destinations: await ctx.webhooks.list(project.id) };
  });

  app.post('/api/v1/projects/:slug/webhooks/:id/test', async (req, reply) => {
    platform(req);
    const project = await resolveProject(req);
    const { id } = req.params as { id: string };
    return reply.status(202).send(await ctx.webhooks.enqueueTest(project.id, id, authOwner(req.auth)));
  });

  app.get('/api/v1/projects/:slug/webhook-deliveries', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    const { limit } = req.query as { limit?: string };
    return { deliveries: await ctx.webhooks.listDeliveries(project.id, parseBoundedInt(limit, 100, 1, 100, 'limit')) };
  });

  app.get('/api/v1/projects/:slug/decision-inbox', async (req) => {
    platform(req);
    const project = await resolveProject(req);
    return { decisions: await getDecisionInbox(ctx.pool, project.id) };
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
