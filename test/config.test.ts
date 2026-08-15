import { describe, expect, it } from 'vitest';
import { assertHostedApiCredentialBoundary, loadConfig } from '../src/config.js';

const hostedTokenPolicy = {
  AUTH_JWT_ALLOWED_CLIENT_IDS: 'customer-web,mcp-client',
  AUTH_JWT_REQUIRED_SCOPES: 'poolstatis:customer',
};

describe('production protection config', () => {
  it('keeps the optional setup composer secret server-side with bounded provider settings', () => {
    const defaults = loadConfig({});
    expect(defaults.setupTaskComposer).toEqual({
      apiKey: null,
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/auto',
      timeoutMs: 8_000,
      maxOutputTokens: 800,
    });
    const configured = loadConfig({
      OPENROUTER_API_KEY: 'server-only-provider-secret',
      OPENROUTER_API_URL: 'https://provider.example/v1/chat/completions',
      OPENROUTER_MODEL: 'provider/model',
      OPENROUTER_TIMEOUT_MS: '1234',
      OPENROUTER_MAX_TOKENS: '999',
    });
    expect(configured.setupTaskComposer).toEqual({
      apiKey: 'server-only-provider-secret',
      apiUrl: 'https://provider.example/v1/chat/completions',
      model: 'provider/model',
      timeoutMs: 1234,
      maxOutputTokens: 999,
    });
    expect(() => loadConfig({ OPENROUTER_API_URL: 'http://provider.example/v1' }))
      .toThrow('OPENROUTER_API_URL');
    expect(() => loadConfig({ OPENROUTER_API_URL: 'https://user:pass@provider.example/v1' }))
      .toThrow('OPENROUTER_API_URL');
    expect(() => loadConfig({ OPENROUTER_TIMEOUT_MS: '0' })).toThrow('OPENROUTER_TIMEOUT_MS');
    expect(() => loadConfig({ OPENROUTER_MAX_TOKENS: '4097' })).toThrow('OPENROUTER_MAX_TOKENS');
  });

  it('supports mutually exclusive trusted-header and local-MMDB country modes', () => {
    expect(loadConfig({
      POOLSTATIS_COUNTRY_HEADER: 'cf-ipcountry',
      POOLSTATIS_TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    }).browserCountry).toEqual({
      mode: 'trusted_header',
      header: 'cf-ipcountry',
      trustedProxyCidrs: ['10.0.0.0/8'],
    });
    expect(loadConfig({
      POOLSTATIS_COUNTRY_MMDB_PATH: '/run/geoip/dbip-country-lite.mmdb',
      POOLSTATIS_CLIENT_IP_HEADER: 'x-poolstatis-client-ip',
      POOLSTATIS_TRUSTED_PROXY_CIDRS: '172.30.0.0/24',
    }).browserCountry).toEqual({
      mode: 'local_mmdb',
      databasePath: '/run/geoip/dbip-country-lite.mmdb',
      clientIpHeader: 'x-poolstatis-client-ip',
      trustedProxyCidrs: ['172.30.0.0/24'],
    });

    expect(() => loadConfig({
      POOLSTATIS_COUNTRY_MMDB_PATH: 'relative.mmdb',
      POOLSTATIS_CLIENT_IP_HEADER: 'x-client-ip',
      POOLSTATIS_TRUSTED_PROXY_CIDRS: '172.30.0.0/24',
    })).toThrow('must be an absolute path');
    expect(() => loadConfig({
      POOLSTATIS_COUNTRY_MMDB_PATH: '/run/geoip/country.mmdb',
      POOLSTATIS_TRUSTED_PROXY_CIDRS: '172.30.0.0/24',
    })).toThrow('must be configured together');
    expect(() => loadConfig({
      POOLSTATIS_COUNTRY_HEADER: 'cf-ipcountry',
      POOLSTATIS_COUNTRY_MMDB_PATH: '/run/geoip/country.mmdb',
      POOLSTATIS_CLIENT_IP_HEADER: 'x-client-ip',
      POOLSTATIS_TRUSTED_PROXY_CIDRS: '172.30.0.0/24',
    })).toThrow('mutually exclusive');
  });

  it('uses the approved hosted-claim namespace and safe CORS defaults', () => {
    const hosted = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
    });
    const production = loadConfig({ NODE_ENV: 'production' });

    expect(hosted.auth).toMatchObject({
      claims: {
        email: 'https://poolstatis.xyz/email',
        emailVerified: 'https://poolstatis.xyz/email_verified',
        displayName: 'https://poolstatis.xyz/name',
        picture: 'https://poolstatis.xyz/picture',
      },
    });
    expect(hosted.corsOrigins).toEqual([
      'http://localhost:5273',
      'http://127.0.0.1:5273',
      'http://[::1]:5273',
    ]);
    expect(production.corsOrigins).toEqual([]);
  });

  it('fails closed to the local Core runner until the pinned public MCP package is enabled', () => {
    const pending = loadConfig({});
    expect(pending.mcpRunner).toMatchObject({
      command: 'pnpm',
      args: ['--silent', '--dir', '<path-to-poolstatis-core>', 'mcp'],
      packageStatus: 'publish_pending',
    });
    expect(pending.mcpRunner.args.join(' ')).not.toContain('@poolstatis/mcp');

    const published = loadConfig({ POOLSTATIS_MCP_PACKAGE_PUBLISHED: 'true' });
    expect(published.mcpRunner).toMatchObject({
      command: 'pnpm',
      args: ['--silent', 'dlx', '@poolstatis/mcp@0.7.0'],
      packageStatus: 'published',
    });
    expect(() => loadConfig({
      POOLSTATIS_MCP_PACKAGE_PUBLISHED: 'true',
      POOLSTATIS_MCP_ARGS: '--silent dlx @poolstatis/mcp',
    })).toThrow('requires pnpm dlx pinned to @poolstatis/mcp@0.7.0');
    expect(() => loadConfig({
      POOLSTATIS_MCP_PACKAGE_PUBLISHED: 'true',
      POOLSTATIS_MCP_COMMAND: 'node',
    })).toThrow('requires pnpm dlx pinned to @poolstatis/mcp@0.7.0');
    expect(() => loadConfig({
      POOLSTATIS_MCP_ARGS: '--silent dlx @poolstatis/mcp@0.7.0',
    })).toThrow('must be true before POOLSTATIS_MCP_ARGS can use @poolstatis/mcp');
  });

  it('requires an explicit hosted opt-in before enforcing external organization policy', () => {
    const selfHost = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
    });
    const hosted = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: 'postgres://core-runtime@db.example/poolstatis',
      MIGRATION_DATABASE_URL: 'postgres://core-deploy@db.example/poolstatis',
    });

    expect(selfHost.auth?.requireOrganizationPolicy).toBe(false);
    expect(hosted.auth?.requireOrganizationPolicy).toBe(true);
    expect(hosted.databaseUrl).toBe('postgres://core-runtime@db.example/poolstatis');
    expect(hosted.migrationDatabaseUrl).toBe('postgres://core-deploy@db.example/poolstatis');
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'yes',
    })).toThrow('HOSTED_POLICY_REQUIRED must be true or false');
  });

  it('requires an exact OAuth client allowlist and scopes in hosted mode', () => {
    const base = {
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: 'postgres://core-runtime@db.example/poolstatis',
    };

    expect(() => loadConfig(base)).toThrow('AUTH_JWT_ALLOWED_CLIENT_IDS');
    expect(() => loadConfig({
      ...base,
      AUTH_JWT_ALLOWED_CLIENT_IDS: 'customer-web',
    })).toThrow('AUTH_JWT_REQUIRED_SCOPES');
    expect(() => loadConfig({
      ...base,
      AUTH_JWT_ALLOWED_CLIENT_IDS: 'customer-web, customer-web, mcp-client',
      AUTH_JWT_REQUIRED_SCOPES: 'poolstatis:customer poolstatis:read',
    })).toThrow('AUTH_JWT_REQUIRED_SCOPES must contain comma-separated values');

    expect(loadConfig({
      ...base,
      ...hostedTokenPolicy,
    }).auth).toMatchObject({
      allowedClientIds: ['customer-web', 'mcp-client'],
      requiredScopes: ['poolstatis:customer'],
    });
  });

  it('requires separate deploy and runtime database credentials for hosted policy', () => {
    const runtime = 'postgres://core-runtime@db.example/poolstatis';
    expect(loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: runtime,
    }).migrationDatabaseUrl).toBeNull();
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: `${runtime}?application_name=migrator`,
    })).toThrow('must use a different database credential');
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: 'postgres://core-deploy@other-db.example/poolstatis',
    })).toThrow('must target the same database');

    const selfHost = loadConfig({ DATABASE_URL: runtime });
    expect(selfHost.migrationDatabaseUrl).toBe(runtime);

    const hostedRuntime = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: runtime,
    });
    expect(() => assertHostedApiCredentialBoundary(hostedRuntime)).not.toThrow();
    const hostedJob = loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      ...hostedTokenPolicy,
      HOSTED_POLICY_REQUIRED: 'true',
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: 'postgres://core-deploy@db.example/poolstatis',
    });
    expect(() => assertHostedApiCredentialBoundary(hostedJob)).toThrow(
      'must not be present in the hosted API process',
    );
  });

  it('normalizes a comma-separated exact-origin CORS allowlist and rejects unsafe entries', () => {
    expect(loadConfig({
      POOLSTATIS_CORS_ORIGINS: 'https://console.example/, https://console.example, http://localhost:5273',
    }).corsOrigins).toEqual(['https://console.example', 'http://localhost:5273']);

    for (const origin of [
      'ftp://console.example',
      'https://user:pass@console.example',
      'https://console.example/path',
      'https://console.example?query=true',
    ]) {
      expect(() => loadConfig({ POOLSTATIS_CORS_ORIGINS: origin })).toThrow('POOLSTATIS_CORS_ORIGINS');
    }
  });

  it('rejects an explicitly empty hosted-auth claim name', () => {
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      AUTH_JWT_EMAIL_CLAIM: ' ',
    })).toThrow('AUTH_JWT_EMAIL_CLAIM must not be empty');
  });

  it('fails fast when legacy issuer adoption is configured for a different issuer', () => {
    expect(() => loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      AUTH_JWT_LEGACY_ISSUER: 'https://another-issuer.example/',
    })).toThrow('AUTH_JWT_LEGACY_ISSUER must equal AUTH_JWT_ISSUER');

    expect(loadConfig({
      AUTH_JWT_ISSUER: 'https://issuer.example/',
      AUTH_JWT_AUDIENCE: 'https://api.example/',
      AUTH_JWT_LEGACY_ISSUER: 'https://issuer.example/',
    }).auth?.legacyIssuer).toBe('https://issuer.example/');
  });

  it('enables bounded tenant limits and automatic retention by default', () => {
    const config = loadConfig({});
    expect(config.cursorSigningSecret).toBeNull();

    expect(config.rateLimit).toEqual(expect.objectContaining({
      ingest: expect.objectContaining({
        key: expect.objectContaining({ ratePerSecond: expect.any(Number), burst: expect.any(Number) }),
        project: expect.objectContaining({ ratePerSecond: expect.any(Number), burst: expect.any(Number) }),
      }),
      api: expect.any(Object),
      maxEntries: expect.any(Number),
      maxEntriesPerTenant: expect.any(Number),
    }));
    expect(config.retentionWorker).toEqual({
      enabled: true,
      intervalMs: 900_000,
      continuationDelayMs: 1_000,
      maxConsecutiveContinuations: 5,
      batchSize: 5_000,
      maxBatchesPerRun: 100,
      maxRowsPerRun: 100_000,
      maxRunMs: 5_000,
    });
    expect(config.releaseMonitor).toEqual({
      enabled: true,
      intervalMs: 60_000,
      batchSize: 25,
      maxAttempts: 8,
      baseRetryMs: 60_000,
      maxRetryMs: 3_600_000,
      leaseMs: 300_000,
    });
    expect(config.webhookOutbox).toEqual({
      enabled: true,
      intervalMs: 5_000,
      batchSize: 25,
      maxAttempts: 8,
      baseRetryMs: 5_000,
      maxRetryMs: 3_600_000,
      leaseMs: 300_000,
      requestTimeoutMs: 10_000,
    });
    expect(config.controlTowerAutomation).toEqual({
      enabled: true,
      intervalMs: 60_000,
      batchSize: 25,
      maxAttempts: 8,
      baseRetryMs: 60_000,
      maxRetryMs: 3_600_000,
      leaseMs: 300_000,
    });
  });

  it('supports explicit operational overrides and strict booleans', () => {
    const config = loadConfig({
      RATE_LIMIT_ENABLED: 'false',
      RETENTION_WORKER_ENABLED: 'false',
      RETENTION_INTERVAL_MS: '1234',
      RETENTION_BATCH_SIZE: '321',
      RETENTION_CONTINUATION_DELAY_MS: '12',
      RETENTION_MAX_CONSECUTIVE_CONTINUATIONS: '2',
      RETENTION_MAX_BATCHES: '8',
      RETENTION_MAX_ROWS_PER_RUN: '999',
      RETENTION_MAX_RUN_MS: '88',
      RELEASE_MONITOR_ENABLED: 'false',
      RELEASE_MONITOR_INTERVAL_MS: '2222',
      RELEASE_MONITOR_BATCH_SIZE: '7',
      RELEASE_MONITOR_MAX_ATTEMPTS: '4',
      RELEASE_MONITOR_BASE_RETRY_MS: '333',
      RELEASE_MONITOR_MAX_RETRY_MS: '4444',
      RELEASE_MONITOR_LEASE_MS: '5555',
      WEBHOOK_OUTBOX_ENABLED: 'false',
      WEBHOOK_OUTBOX_INTERVAL_MS: '111',
      WEBHOOK_OUTBOX_BATCH_SIZE: '6',
      WEBHOOK_OUTBOX_MAX_ATTEMPTS: '3',
      WEBHOOK_OUTBOX_BASE_RETRY_MS: '222',
      WEBHOOK_OUTBOX_MAX_RETRY_MS: '3333',
      WEBHOOK_OUTBOX_LEASE_MS: '4444',
      WEBHOOK_REQUEST_TIMEOUT_MS: '555',
      CONTROL_TOWER_AUTOMATION_ENABLED: 'false',
      CONTROL_TOWER_AUTOMATION_INTERVAL_MS: '666',
      CONTROL_TOWER_AUTOMATION_BATCH_SIZE: '5',
      CONTROL_TOWER_AUTOMATION_MAX_ATTEMPTS: '6',
      CONTROL_TOWER_AUTOMATION_BASE_RETRY_MS: '777',
      CONTROL_TOWER_AUTOMATION_MAX_RETRY_MS: '8888',
      CONTROL_TOWER_AUTOMATION_LEASE_MS: '9999',
      OUTBOUND_ALLOW_LOCAL_HTTP: 'true',
      POOLSTATIS_CURSOR_SIGNING_SECRET: 'synthetic-server-only-secret-123456',
    });
    expect(config.rateLimit).toBe(false);
    expect(config.outboundPolicy).toEqual({ allowLocalHttp: true });
    expect(config.retentionWorker).toEqual({
      enabled: false,
      intervalMs: 1234,
      continuationDelayMs: 12,
      maxConsecutiveContinuations: 2,
      batchSize: 321,
      maxBatchesPerRun: 8,
      maxRowsPerRun: 999,
      maxRunMs: 88,
    });
    expect(config.releaseMonitor).toEqual({
      enabled: false,
      intervalMs: 2222,
      batchSize: 7,
      maxAttempts: 4,
      baseRetryMs: 333,
      maxRetryMs: 4444,
      leaseMs: 5555,
    });
    expect(config.webhookOutbox).toEqual({
      enabled: false,
      intervalMs: 111,
      batchSize: 6,
      maxAttempts: 3,
      baseRetryMs: 222,
      maxRetryMs: 3333,
      leaseMs: 4444,
      requestTimeoutMs: 555,
    });
    expect(config.cursorSigningSecret).toBe('synthetic-server-only-secret-123456');
    expect(config.controlTowerAutomation).toEqual({
      enabled: false,
      intervalMs: 666,
      batchSize: 5,
      maxAttempts: 6,
      baseRetryMs: 777,
      maxRetryMs: 8888,
      leaseMs: 9999,
    });

    expect(() => loadConfig({ RATE_LIMIT_ENABLED: 'yes' })).toThrow(
      'RATE_LIMIT_ENABLED must be true or false',
    );
    expect(() => loadConfig({ RETENTION_MAX_BATCHES: '3' })).toThrow(
      'RETENTION_MAX_BATCHES must be at least 4',
    );
    expect(() => loadConfig({ RETENTION_MAX_BATCHES: '1001' })).toThrow(
      'RETENTION_MAX_BATCHES must be less than or equal to 1000',
    );
    expect(() => loadConfig({ POOLSTATIS_CURSOR_SIGNING_SECRET: 'too-short' })).toThrow(
      'POOLSTATIS_CURSOR_SIGNING_SECRET must be at least 32 characters',
    );
  });
});
