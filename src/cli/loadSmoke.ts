import { pathToFileURL } from 'node:url';

interface PublicLoadSmokeConfig {
  baseUrl: string;
  project: string;
  concurrency: number;
  durationMs: number;
  batchSize: number;
}

interface LoadSmokeConfig {
  ingestToken: string;
  platformToken: string;
  env: string;
  metric?: string;
  requestTimeoutMs: number;
  thresholds: LoadSmokeThresholds;
  public: PublicLoadSmokeConfig;
  concurrency: number;
  durationMs: number;
  batchSize: number;
}

interface PhaseInput {
  latenciesMs: number[];
  requests: number;
  errors: number;
  acceptedEvents: number;
  durationMs: number;
}

interface LoadSmokeThresholds {
  ingestP95Ms: number;
  queryP95Ms: number;
  maxErrorRate: number;
}

interface PhaseSummary {
  requests: number;
  errors: number;
  error_rate: number;
  accepted_events: number;
  requests_per_second: number;
  events_per_second: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
}

interface LoadSmokeSummaryInput {
  ingest: PhaseInput;
  query: PhaseInput;
  queryCached?: PhaseInput;
  thresholds: LoadSmokeThresholds;
  publicConfig: PublicLoadSmokeConfig;
  verifiedEventDelta?: { expectedAtLeast: number; observed: number };
}

function positiveInt(raw: string | undefined, fallback: number, name: string, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function nonNegativeNumber(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

export function loadSmokeConfig(env: NodeJS.ProcessEnv): LoadSmokeConfig {
  const ingestToken = env.POOLSTATIS_INGEST_TOKEN;
  const platformToken = env.POOLSTATIS_PLATFORM_TOKEN;
  const project = env.POOLSTATIS_PROJECT;
  if (!ingestToken) throw new Error('POOLSTATIS_INGEST_TOKEN is required');
  if (!platformToken) throw new Error('POOLSTATIS_PLATFORM_TOKEN is required');
  if (!project) throw new Error('POOLSTATIS_PROJECT is required');

  const baseUrl = (env.POOLSTATIS_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '');
  const concurrency = positiveInt(env.LOAD_SMOKE_CONCURRENCY, 8, 'LOAD_SMOKE_CONCURRENCY', 100);
  const durationMs = positiveInt(env.LOAD_SMOKE_DURATION_MS, 10_000, 'LOAD_SMOKE_DURATION_MS', 300_000);
  const batchSize = positiveInt(env.LOAD_SMOKE_BATCH_SIZE, 100, 'LOAD_SMOKE_BATCH_SIZE', 500);
  const publicConfig = { baseUrl, project, concurrency, durationMs, batchSize };
  return {
    ingestToken,
    platformToken,
    env: env.LOAD_SMOKE_ENV ?? 'prod',
    ...(env.LOAD_SMOKE_METRIC ? { metric: env.LOAD_SMOKE_METRIC } : {}),
    requestTimeoutMs: positiveInt(env.LOAD_SMOKE_REQUEST_TIMEOUT_MS, 5_000, 'LOAD_SMOKE_REQUEST_TIMEOUT_MS', 60_000),
    thresholds: {
      ingestP95Ms: nonNegativeNumber(env.LOAD_SMOKE_INGEST_P95_MS, 250, 'LOAD_SMOKE_INGEST_P95_MS'),
      queryP95Ms: nonNegativeNumber(env.LOAD_SMOKE_QUERY_P95_MS, 500, 'LOAD_SMOKE_QUERY_P95_MS'),
      maxErrorRate: nonNegativeNumber(env.LOAD_SMOKE_MAX_ERROR_RATE, 0.01, 'LOAD_SMOKE_MAX_ERROR_RATE'),
    },
    public: publicConfig,
    concurrency,
    durationMs,
    batchSize,
  };
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return Number(sorted[rank - 1]!.toFixed(2));
}

export async function runConcurrently(
  concurrency: number,
  task: (worker: number) => Promise<boolean>,
): Promise<void> {
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (await task(worker)) { /* bounded by task */ }
  }));
}

function summarizePhase(input: PhaseInput): PhaseSummary {
  const seconds = Math.max(input.durationMs / 1_000, 0.001);
  return {
    requests: input.requests,
    errors: input.errors,
    error_rate: Number((input.errors / Math.max(input.requests, 1)).toFixed(4)),
    accepted_events: input.acceptedEvents,
    requests_per_second: Number((input.requests / seconds).toFixed(2)),
    events_per_second: Number((input.acceptedEvents / seconds).toFixed(2)),
    latency_p50_ms: percentile(input.latenciesMs, 0.5),
    latency_p95_ms: percentile(input.latenciesMs, 0.95),
    latency_p99_ms: percentile(input.latenciesMs, 0.99),
  };
}

export function summarizeLoadSmoke(input: LoadSmokeSummaryInput) {
  const ingest = summarizePhase(input.ingest);
  const query = summarizePhase(input.query);
  const queryCached = input.queryCached ? summarizePhase(input.queryCached) : undefined;
  const violations: string[] = [];
  if (ingest.latency_p95_ms > input.thresholds.ingestP95Ms) {
    violations.push(`ingest p95 ${ingest.latency_p95_ms}ms exceeds ${input.thresholds.ingestP95Ms}ms`);
  }
  if (query.latency_p95_ms > input.thresholds.queryP95Ms) {
    violations.push(`query p95 ${query.latency_p95_ms}ms exceeds ${input.thresholds.queryP95Ms}ms`);
  }
  if (queryCached && queryCached.latency_p95_ms > input.thresholds.queryP95Ms) {
    violations.push(`query_cached p95 ${queryCached.latency_p95_ms}ms exceeds ${input.thresholds.queryP95Ms}ms`);
  }
  const checkedPhases: Array<[string, PhaseSummary]> = [['ingest', ingest], ['query', query]];
  if (queryCached) checkedPhases.push(['query_cached', queryCached]);
  for (const [name, phase] of checkedPhases) {
    if (phase.error_rate > input.thresholds.maxErrorRate) {
      violations.push(`${name} error rate ${phase.error_rate} exceeds ${input.thresholds.maxErrorRate}`);
    }
  }
  if (input.verifiedEventDelta && input.verifiedEventDelta.observed < input.verifiedEventDelta.expectedAtLeast) {
    violations.push(
      `metric event delta ${input.verifiedEventDelta.observed} is below accepted ${input.verifiedEventDelta.expectedAtLeast}`,
    );
  }
  return {
    ok: violations.length === 0,
    config: input.publicConfig,
    thresholds: input.thresholds,
    ingest,
    query,
    ...(queryCached ? { query_cached: queryCached } : {}),
    ...(input.verifiedEventDelta ? { verified_event_delta: input.verifiedEventDelta } : {}),
    violations,
  };
}

async function jsonRequest(url: string, token: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function resolveMetric(config: LoadSmokeConfig): Promise<{ key: string; event: string }> {
  const schema = await jsonRequest(
    `${config.public.baseUrl}/api/v1/projects/${encodeURIComponent(config.public.project)}/schema?env=${encodeURIComponent(config.env)}`,
    config.platformToken,
    { method: 'GET', headers: {} },
    config.requestTimeoutMs,
  ) as { metrics?: Array<{ key: string; status: string; type: string; source: { event?: string; filters?: unknown[] } }> };
  const metric = schema.metrics?.find((candidate) =>
    candidate.status === 'active'
      && candidate.type === 'count'
      && typeof candidate.source?.event === 'string'
      && (candidate.source.filters?.length ?? 0) === 0
      && (!config.metric || candidate.key === config.metric));
  if (!metric?.source.event) {
    throw new Error(config.metric
      ? `active unfiltered count metric "${config.metric}" was not found`
      : 'the project needs at least one active unfiltered count metric');
  }
  return { key: metric.key, event: metric.source.event };
}

async function runPhase(
  config: LoadSmokeConfig,
  action: (worker: number, sequence: number) => Promise<number>,
): Promise<PhaseInput> {
  const latenciesMs: number[] = [];
  let requests = 0;
  let errors = 0;
  let acceptedEvents = 0;
  let sequence = 0;
  const started = performance.now();
  const deadline = started + config.durationMs;
  await runConcurrently(config.concurrency, async (worker) => {
    if (performance.now() >= deadline) return false;
    const current = sequence++;
    const requestStarted = performance.now();
    try {
      const accepted = await action(worker, current);
      acceptedEvents += accepted;
    } catch {
      errors += 1;
    } finally {
      requests += 1;
      latenciesMs.push(performance.now() - requestStarted);
    }
    return performance.now() < deadline;
  });
  return { latenciesMs, requests, errors, acceptedEvents, durationMs: performance.now() - started };
}

export async function runLoadSmoke(env: NodeJS.ProcessEnv = process.env) {
  const config = loadSmokeConfig(env);
  const metric = await resolveMetric(config);
  const queryBody = { kind: 'trend', metric: metric.key, date_from: '-1d', interval: 'hour', env: config.env };
  const queryUrl = `${config.public.baseUrl}/api/v1/projects/${encodeURIComponent(config.public.project)}/query`;
  const queryTotal = async (body: Record<string, unknown>): Promise<number> => {
    const result = await jsonRequest(
      queryUrl,
      config.platformToken,
      { method: 'POST', body: JSON.stringify(body) },
      config.requestTimeoutMs,
    ) as { kind?: string; series?: Array<{ value?: number }> };
    if (result.kind !== 'trend' || !Array.isArray(result.series)) throw new Error('trend query returned an invalid shape');
    return result.series.reduce((total, point) => total + Number(point.value ?? 0), 0);
  };
  const beforeTotal = await queryTotal(queryBody);

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ingest = await runPhase(config, async (worker, sequence) => {
    const events = Array.from({ length: config.batchSize }, (_, index) => ({
      event: metric.event,
      distinct_id: `load-${runId}-${worker}-${sequence}-${index}`,
      properties: { load_smoke: true },
    }));
    const body = await jsonRequest(
      `${config.public.baseUrl}/i/v1/events`,
      config.ingestToken,
      { method: 'POST', body: JSON.stringify({ batch_id: `load-${runId}-${worker}-${sequence}`, events }) },
      config.requestTimeoutMs,
    ) as { accepted?: number; errors?: number };
    if (body.errors || body.accepted !== config.batchSize) {
      throw new Error(`partial ingest: accepted=${body.accepted ?? 0}, errors=${body.errors ?? 0}`);
    }
    return body.accepted ?? 0;
  });

  const verifiedBody = { ...queryBody, date_to: new Date().toISOString() };
  const afterTotal = await queryTotal(verifiedBody);
  const queryCached = await runPhase(config, async () => {
    await queryTotal(verifiedBody);
    return 0;
  });
  const query = await runPhase(config, async (_worker, sequence) => {
    await queryTotal({ ...queryBody, date_to: new Date(Date.now() + sequence).toISOString() });
    return 0;
  });
  return summarizeLoadSmoke({
    ingest,
    query,
    queryCached,
    thresholds: config.thresholds,
    publicConfig: config.public,
    verifiedEventDelta: { expectedAtLeast: ingest.acceptedEvents, observed: afterTotal - beforeTotal },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLoadSmoke()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      process.exitCode = summary.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
      process.exitCode = 1;
    });
}
