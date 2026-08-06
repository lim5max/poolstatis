import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { buildServer, type ServerOptions } from '../src/http/server.js';
import { createApiKey, createOrganization, createProject } from '../src/services/projects.js';
import { TEST_DB_URL } from './urls.js';

export interface TestEnv {
  pool: pg.Pool;
  app: FastifyInstance;
  projectId: string;
  projectSlug: string;
  ingestToken: string;
  ingestDevToken: string;
  secretToken: string;
  personalToken: string;
  close: () => Promise<void>;
}

let counter = 0;

/** Fresh org + project + keys on the shared test database. */
export async function createTestEnv(serverOptions: ServerOptions = {}): Promise<TestEnv> {
  const pool = createPool(TEST_DB_URL);
  const app = buildServer(pool, {
    cursorSigningSecret: 'synthetic-test-only-cursor-signing-secret',
    ...serverOptions,
  });
  const slug = `proj-${Date.now()}-${counter++}`;

  const org = await createOrganization(pool, `org-${slug}`);
  const project = await createProject(pool, org.id, slug, slug);
  const ingest = await createApiKey(pool, { orgId: org.id, projectId: project.id, kind: 'ingest', env: 'prod' });
  const ingestDev = await createApiKey(pool, { orgId: org.id, projectId: project.id, kind: 'ingest', env: 'dev' });
  const secret = await createApiKey(pool, { orgId: org.id, projectId: project.id, kind: 'secret' });
  const personal = await createApiKey(pool, { orgId: org.id, projectId: null, kind: 'personal', legacySelfHost: true });

  return {
    pool,
    app,
    projectId: project.id,
    projectSlug: slug,
    ingestToken: ingest.token,
    ingestDevToken: ingestDev.token,
    secretToken: secret.token,
    personalToken: personal.token,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export async function api(
  env: TestEnv,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await env.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.json() };
}

/** Register a metric and activate it in one go. */
export async function activeMetric(
  env: TestEnv,
  metric: { key: string; name?: string; type?: string; source: unknown; purpose?: string },
): Promise<void> {
  const reg = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/metrics`, {
    name: metric.key,
    type: 'count',
    purpose: `test metric for ${metric.key}, informs nothing real`,
    ...metric,
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const act = await api(env, env.secretToken, 'PATCH',
    `/api/v1/projects/${env.projectSlug}/metrics/${metric.key}`, { status: 'active' });
  if (act.status !== 200) throw new Error(`activate failed: ${JSON.stringify(act.body)}`);
}

export function hoursAgo(h: number, now: Date = new Date()): string {
  return new Date(now.getTime() - h * 3600_000).toISOString();
}
