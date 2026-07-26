import type { TenantRateLimitOptions } from './services/rateLimiter.js';

export interface Config {
  databaseUrl: string;
  migrationDatabaseUrl: string | null;
  databasePoolMax: number;
  port: number;
  host: string;
  publicUrl: string;
  connectorEncryptionKey: string | null;
  outboundPolicy: { allowLocalHttp: boolean };
  experienceArtifactDir: string;
  ingestBuffer: {
    maxEvents: number;
    maxDelayMs: number;
    maxPendingEvents: number;
    maxConcurrentIdempotentAppends: number;
  };
  queryCache: {
    ttlMs: number;
    maxEntries: number;
  };
  rateLimit: TenantRateLimitOptions | false;
  retentionWorker: {
    enabled: boolean;
    intervalMs: number;
    continuationDelayMs: number;
    maxConsecutiveContinuations: number;
    batchSize: number;
    maxBatchesPerRun: number;
    maxRowsPerRun: number;
    maxRunMs: number;
  };
  releaseMonitor: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseRetryMs: number;
    maxRetryMs: number;
    leaseMs: number;
  };
  webhookOutbox: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseRetryMs: number;
    maxRetryMs: number;
    leaseMs: number;
    requestTimeoutMs: number;
  };
  mcpRunner: {
    command: string;
    args: string[];
    packageStatus: 'published' | 'publish_pending';
    note: string;
  };
  auth: {
    issuer: string;
    audience: string;
    jwksUri: string;
    claims: {
      email: string;
      emailVerified: string;
      displayName: string;
      picture: string;
    };
    connectionStrategy: string;
    allowedClientIds: string[];
    requiredScopes: string[];
    legacyIssuer: string | null;
    requireOrganizationPolicy: boolean;
  } | null;
  corsOrigins: string[];
}

export function assertHostedApiCredentialBoundary(config: Config): void {
  if (config.auth?.requireOrganizationPolicy === true
      && config.migrationDatabaseUrl !== null) {
    throw new Error(
      'MIGRATION_DATABASE_URL must not be present in the hosted API process; run prepare-hosted separately',
    );
  }
}

export const MCP_PACKAGE_SPEC = '@poolstatis/mcp@0.1.0';
const LOCAL_MCP_ARGS = ['--silent', '--dir', '<path-to-poolstatis-core>', 'mcp'];

function parseArgs(raw: string | undefined, packageStatus: 'published' | 'publish_pending'): string[] {
  if (!raw?.trim()) {
    return packageStatus === 'published'
      ? ['--silent', 'dlx', MCP_PACKAGE_SPEC]
      : LOCAL_MCP_ARGS;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('POOLSTATIS_MCP_ARGS must be a JSON string array or a whitespace-separated string');
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

// PostgreSQL's extended protocol accepts at most 65,535 bind parameters.
// PostgresEventStore currently uses 10 parameters per event; keep headroom.
const POSTGRES_APPEND_MAX_EVENTS = 6500;

function positiveInt(raw: string | undefined, fallback: number, name: string, max?: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be less than or equal to ${max}`);
  }
  return value;
}

function booleanValue(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function requiredText(raw: string | undefined, fallback: string, name: string): string {
  const value = raw === undefined ? fallback : raw.trim();
  if (!value) throw new Error(`${name} must not be empty`);
  return value;
}

function exactList(raw: string | undefined, name: string): string[] {
  if (raw === undefined) return [];
  const values = raw.split(',').map((value) => value.trim());
  if (values.some((value) => !value)
      || values.some((value) => value.length > 128 || !/^[A-Za-z0-9:._~/-]+$/.test(value))) {
    throw new Error(`${name} must contain comma-separated values`);
  }
  const unique = [...new Set(values)];
  if (unique.length > 32) throw new Error(`${name} must contain at most 32 values`);
  return unique;
}

function databaseCredential(raw: string, name: string): {
  username: string;
  target: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
      || !url.username || !url.hostname || url.pathname.length <= 1) {
    throw new Error(`${name} must be a PostgreSQL URL with username, host, and database`);
  }
  return {
    username: decodeURIComponent(url.username),
    target: `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`,
  };
}

function parseCorsOrigins(raw: string | undefined, production: boolean): string[] {
  const values = raw === undefined
    ? (production ? [] : ['http://localhost:5273', 'http://127.0.0.1:5273', 'http://[::1]:5273'])
    : raw.split(',').map((value) => value.trim()).filter(Boolean);
  return [...new Set(values.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('POOLSTATIS_CORS_ORIGINS must contain comma-separated HTTP(S) origins');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('POOLSTATIS_CORS_ORIGINS must contain origins without paths, credentials, queries, or fragments');
    }
    return url.origin;
  }))];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuer = env.AUTH_JWT_ISSUER;
  const audience = env.AUTH_JWT_AUDIENCE;
  const legacyIssuer = env.AUTH_JWT_LEGACY_ISSUER === undefined
    ? null
    : requiredText(env.AUTH_JWT_LEGACY_ISSUER, '', 'AUTH_JWT_LEGACY_ISSUER');
  if (legacyIssuer !== null && legacyIssuer !== issuer) {
    throw new Error('AUTH_JWT_LEGACY_ISSUER must equal AUTH_JWT_ISSUER');
  }
  const jwksUri = env.AUTH_JWKS_URI ?? (issuer ? new URL('.well-known/jwks.json', issuer).toString() : undefined);
  const packageStatus = env.POOLSTATIS_MCP_PACKAGE_PUBLISHED === 'true' ? 'published' : 'publish_pending';
  const mcpCommand = env.POOLSTATIS_MCP_COMMAND ?? 'pnpm';
  const mcpArgs = parseArgs(env.POOLSTATIS_MCP_ARGS, packageStatus);
  if (packageStatus === 'published'
      && (mcpCommand !== 'pnpm'
        || mcpArgs.length !== 3
        || mcpArgs[0] !== '--silent'
        || mcpArgs[1] !== 'dlx'
        || mcpArgs[2] !== MCP_PACKAGE_SPEC)) {
    throw new Error(
      `POOLSTATIS_MCP_PACKAGE_PUBLISHED=true requires pnpm dlx pinned to ${MCP_PACKAGE_SPEC}`,
    );
  }
  if (packageStatus === 'publish_pending'
      && mcpArgs.some((arg) => arg.includes('@poolstatis/mcp'))) {
    throw new Error(
      'POOLSTATIS_MCP_PACKAGE_PUBLISHED must be true before POOLSTATIS_MCP_ARGS can use @poolstatis/mcp',
    );
  }
  const databasePoolMax = positiveInt(env.DATABASE_POOL_MAX, 10, 'DATABASE_POOL_MAX');
  const production = env.NODE_ENV === 'production';
  const corsOrigins = parseCorsOrigins(env.POOLSTATIS_CORS_ORIGINS, production);
  const ingestBuffer = {
    maxEvents: positiveInt(
      env.INGEST_BUFFER_MAX_EVENTS,
      1000,
      'INGEST_BUFFER_MAX_EVENTS',
      POSTGRES_APPEND_MAX_EVENTS,
    ),
    maxDelayMs: positiveInt(env.INGEST_BUFFER_MAX_DELAY_MS, 10, 'INGEST_BUFFER_MAX_DELAY_MS'),
    maxPendingEvents: positiveInt(env.INGEST_BUFFER_MAX_PENDING_EVENTS, 50_000, 'INGEST_BUFFER_MAX_PENDING_EVENTS'),
    maxConcurrentIdempotentAppends: positiveInt(
      env.INGEST_IDEMPOTENT_MAX_CONCURRENCY,
      Math.max(1, databasePoolMax - 2),
      'INGEST_IDEMPOTENT_MAX_CONCURRENCY',
      databasePoolMax,
    ),
  };
  if (ingestBuffer.maxEvents > ingestBuffer.maxPendingEvents) {
    throw new Error('INGEST_BUFFER_MAX_EVENTS must be less than or equal to INGEST_BUFFER_MAX_PENDING_EVENTS');
  }
  const rateLimit: TenantRateLimitOptions | false = booleanValue(
    env.RATE_LIMIT_ENABLED,
    true,
    'RATE_LIMIT_ENABLED',
  ) ? {
      ingest: {
        key: {
          ratePerSecond: positiveInt(env.RATE_LIMIT_INGEST_KEY_PER_SECOND, 50_000, 'RATE_LIMIT_INGEST_KEY_PER_SECOND'),
          burst: positiveInt(env.RATE_LIMIT_INGEST_KEY_BURST, 100_000, 'RATE_LIMIT_INGEST_KEY_BURST'),
        },
        project: {
          ratePerSecond: positiveInt(env.RATE_LIMIT_INGEST_PROJECT_PER_SECOND, 200_000, 'RATE_LIMIT_INGEST_PROJECT_PER_SECOND'),
          burst: positiveInt(env.RATE_LIMIT_INGEST_PROJECT_BURST, 400_000, 'RATE_LIMIT_INGEST_PROJECT_BURST'),
        },
      },
      api: {
        key: {
          ratePerSecond: positiveInt(env.RATE_LIMIT_API_KEY_PER_SECOND, 3_000, 'RATE_LIMIT_API_KEY_PER_SECOND'),
          burst: positiveInt(env.RATE_LIMIT_API_KEY_BURST, 6_000, 'RATE_LIMIT_API_KEY_BURST'),
        },
        project: {
          ratePerSecond: positiveInt(env.RATE_LIMIT_API_PROJECT_PER_SECOND, 10_000, 'RATE_LIMIT_API_PROJECT_PER_SECOND'),
          burst: positiveInt(env.RATE_LIMIT_API_PROJECT_BURST, 20_000, 'RATE_LIMIT_API_PROJECT_BURST'),
        },
      },
      maxEntries: positiveInt(env.RATE_LIMIT_MAX_ENTRIES, 100_000, 'RATE_LIMIT_MAX_ENTRIES'),
      maxEntriesPerTenant: positiveInt(
        env.RATE_LIMIT_MAX_ENTRIES_PER_TENANT,
        10_000,
        'RATE_LIMIT_MAX_ENTRIES_PER_TENANT',
      ),
      idleTtlMs: positiveInt(env.RATE_LIMIT_IDLE_TTL_MS, 600_000, 'RATE_LIMIT_IDLE_TTL_MS'),
    } : false;
  const retentionMaxBatches = positiveInt(
    env.RETENTION_MAX_BATCHES,
    100,
    'RETENTION_MAX_BATCHES',
    1_000,
  );
  if (retentionMaxBatches < 4) {
    throw new Error('RETENTION_MAX_BATCHES must be at least 4');
  }
  const databaseUrl =
    env.DATABASE_URL ??
    'postgres://poolsatis:poolsatis@localhost:5444/poolsatis';
  const requireOrganizationPolicy = booleanValue(
    env.HOSTED_POLICY_REQUIRED,
    false,
    'HOSTED_POLICY_REQUIRED',
  );
  if (requireOrganizationPolicy && (!issuer || !audience || !jwksUri)) {
    throw new Error('HOSTED_POLICY_REQUIRED requires configured JWT authentication');
  }
  const allowedClientIds = exactList(env.AUTH_JWT_ALLOWED_CLIENT_IDS, 'AUTH_JWT_ALLOWED_CLIENT_IDS');
  const requiredScopes = exactList(env.AUTH_JWT_REQUIRED_SCOPES, 'AUTH_JWT_REQUIRED_SCOPES');
  if (requireOrganizationPolicy && allowedClientIds.length === 0) {
    throw new Error('HOSTED_POLICY_REQUIRED requires AUTH_JWT_ALLOWED_CLIENT_IDS');
  }
  if (requireOrganizationPolicy && requiredScopes.length === 0) {
    throw new Error('HOSTED_POLICY_REQUIRED requires AUTH_JWT_REQUIRED_SCOPES');
  }
  const migrationDatabaseUrl = env.MIGRATION_DATABASE_URL === undefined
    ? (requireOrganizationPolicy ? null : databaseUrl)
    : requiredText(env.MIGRATION_DATABASE_URL, '', 'MIGRATION_DATABASE_URL');
  if (requireOrganizationPolicy && migrationDatabaseUrl !== null) {
    const runtimeCredential = databaseCredential(databaseUrl, 'DATABASE_URL');
    const migrationCredential = databaseCredential(
      migrationDatabaseUrl,
      'MIGRATION_DATABASE_URL',
    );
    if (migrationCredential.target !== runtimeCredential.target) {
      throw new Error('MIGRATION_DATABASE_URL must target the same database as DATABASE_URL');
    }
    if (migrationCredential.username === runtimeCredential.username) {
      throw new Error(
        'MIGRATION_DATABASE_URL must use a different database credential from DATABASE_URL in hosted mode',
      );
    }
  }
  return {
    databaseUrl,
    migrationDatabaseUrl,
    databasePoolMax,
    port: env.PORT ? Number(env.PORT) : 3300,
    host: env.HOST ?? '127.0.0.1',
    publicUrl: (env.POOLSTATIS_PUBLIC_URL ?? 'https://api.poolstatis.com').replace(/\/$/, ''),
    connectorEncryptionKey: env.POOLSTATIS_CONNECTOR_ENCRYPTION_KEY?.trim() || null,
    outboundPolicy: { allowLocalHttp: booleanValue(env.OUTBOUND_ALLOW_LOCAL_HTTP, false, 'OUTBOUND_ALLOW_LOCAL_HTTP') },
    experienceArtifactDir: env.POOLSTATIS_EXPERIENCE_ARTIFACT_DIR?.trim() || './data/experience-artifacts',
    ingestBuffer,
    queryCache: {
      ttlMs: positiveInt(env.QUERY_CACHE_TTL_MS, 1_000, 'QUERY_CACHE_TTL_MS'),
      maxEntries: positiveInt(env.QUERY_CACHE_MAX_ENTRIES, 1_000, 'QUERY_CACHE_MAX_ENTRIES'),
    },
    rateLimit,
    retentionWorker: {
      enabled: booleanValue(env.RETENTION_WORKER_ENABLED, true, 'RETENTION_WORKER_ENABLED'),
      intervalMs: positiveInt(env.RETENTION_INTERVAL_MS, 900_000, 'RETENTION_INTERVAL_MS'),
      continuationDelayMs: positiveInt(
        env.RETENTION_CONTINUATION_DELAY_MS,
        1_000,
        'RETENTION_CONTINUATION_DELAY_MS',
      ),
      maxConsecutiveContinuations: positiveInt(
        env.RETENTION_MAX_CONSECUTIVE_CONTINUATIONS,
        5,
        'RETENTION_MAX_CONSECUTIVE_CONTINUATIONS',
        100,
      ),
      batchSize: positiveInt(env.RETENTION_BATCH_SIZE, 5_000, 'RETENTION_BATCH_SIZE', 50_000),
      maxBatchesPerRun: retentionMaxBatches,
      maxRowsPerRun: positiveInt(
        env.RETENTION_MAX_ROWS_PER_RUN,
        100_000,
        'RETENTION_MAX_ROWS_PER_RUN',
        1_000_000,
      ),
      maxRunMs: positiveInt(env.RETENTION_MAX_RUN_MS, 5_000, 'RETENTION_MAX_RUN_MS', 60_000),
    },
    releaseMonitor: {
      enabled: booleanValue(env.RELEASE_MONITOR_ENABLED, true, 'RELEASE_MONITOR_ENABLED'),
      intervalMs: positiveInt(env.RELEASE_MONITOR_INTERVAL_MS, 60_000, 'RELEASE_MONITOR_INTERVAL_MS'),
      batchSize: positiveInt(env.RELEASE_MONITOR_BATCH_SIZE, 25, 'RELEASE_MONITOR_BATCH_SIZE', 500),
      maxAttempts: positiveInt(env.RELEASE_MONITOR_MAX_ATTEMPTS, 8, 'RELEASE_MONITOR_MAX_ATTEMPTS', 100),
      baseRetryMs: positiveInt(env.RELEASE_MONITOR_BASE_RETRY_MS, 60_000, 'RELEASE_MONITOR_BASE_RETRY_MS'),
      maxRetryMs: positiveInt(env.RELEASE_MONITOR_MAX_RETRY_MS, 3_600_000, 'RELEASE_MONITOR_MAX_RETRY_MS'),
      leaseMs: positiveInt(env.RELEASE_MONITOR_LEASE_MS, 300_000, 'RELEASE_MONITOR_LEASE_MS'),
    },
    webhookOutbox: {
      enabled: booleanValue(env.WEBHOOK_OUTBOX_ENABLED, true, 'WEBHOOK_OUTBOX_ENABLED'),
      intervalMs: positiveInt(env.WEBHOOK_OUTBOX_INTERVAL_MS, 5_000, 'WEBHOOK_OUTBOX_INTERVAL_MS'),
      batchSize: positiveInt(env.WEBHOOK_OUTBOX_BATCH_SIZE, 25, 'WEBHOOK_OUTBOX_BATCH_SIZE', 500),
      maxAttempts: positiveInt(env.WEBHOOK_OUTBOX_MAX_ATTEMPTS, 8, 'WEBHOOK_OUTBOX_MAX_ATTEMPTS', 100),
      baseRetryMs: positiveInt(env.WEBHOOK_OUTBOX_BASE_RETRY_MS, 5_000, 'WEBHOOK_OUTBOX_BASE_RETRY_MS'),
      maxRetryMs: positiveInt(env.WEBHOOK_OUTBOX_MAX_RETRY_MS, 3_600_000, 'WEBHOOK_OUTBOX_MAX_RETRY_MS'),
      leaseMs: positiveInt(env.WEBHOOK_OUTBOX_LEASE_MS, 300_000, 'WEBHOOK_OUTBOX_LEASE_MS'),
      requestTimeoutMs: positiveInt(env.WEBHOOK_REQUEST_TIMEOUT_MS, 10_000, 'WEBHOOK_REQUEST_TIMEOUT_MS', 60_000),
    },
    mcpRunner: {
      command: mcpCommand,
      args: mcpArgs,
      packageStatus,
      note: packageStatus === 'published'
        ? `The configured MCP runner is pinned to ${MCP_PACKAGE_SPEC}.`
        : 'Registry install is disabled. Replace <path-to-poolstatis-core> with an exact local Core checkout path.',
    },
    auth: issuer && audience && jwksUri ? {
      issuer,
      audience,
      jwksUri,
      claims: {
        email: requiredText(env.AUTH_JWT_EMAIL_CLAIM, 'https://poolstatis.xyz/email', 'AUTH_JWT_EMAIL_CLAIM'),
        emailVerified: requiredText(env.AUTH_JWT_EMAIL_VERIFIED_CLAIM, 'https://poolstatis.xyz/email_verified', 'AUTH_JWT_EMAIL_VERIFIED_CLAIM'),
        displayName: requiredText(env.AUTH_JWT_DISPLAY_NAME_CLAIM, 'https://poolstatis.xyz/name', 'AUTH_JWT_DISPLAY_NAME_CLAIM'),
        picture: requiredText(env.AUTH_JWT_PICTURE_CLAIM, 'https://poolstatis.xyz/picture', 'AUTH_JWT_PICTURE_CLAIM'),
      },
      connectionStrategy: requiredText(env.AUTH_CONNECTION_STRATEGY, 'oidc', 'AUTH_CONNECTION_STRATEGY'),
      allowedClientIds,
      requiredScopes,
      legacyIssuer,
      requireOrganizationPolicy,
    } : null,
    corsOrigins,
  };
}
