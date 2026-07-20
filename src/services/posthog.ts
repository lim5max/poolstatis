import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type {
  PostHogConnectionInput,
  PropertyFilter,
} from '../schemas.js';
import type { RetentionCohort, TrendPoint } from '../stores/eventStore.js';
import type { MetricAggregate } from '../stores/eventStore.js';

export interface SourceConnection {
  id: string;
  provider: 'posthog';
  name: string;
  host: string;
  external_project_id: string;
  status: 'configured' | 'verified' | 'error' | 'disabled';
  capabilities: Record<string, boolean>;
  last_error: string | null;
  verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface SourceConnectionRow extends SourceConnection {
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
}

interface QueryResponse {
  columns?: unknown;
  results?: unknown;
}

export interface PostHogSchema {
  events: Array<{ name: string }>;
  properties: Array<{
    name: string;
    scope: 'event' | 'actor';
    value_type: 'string' | 'number' | 'boolean' | 'datetime';
  }>;
  capabilities: {
    trend: true;
    funnel: true;
    retention: true;
    sample: true;
    value_metrics: false;
  };
}

const PUBLIC_COLS = `id, provider, name, host, external_project_id, status,
  capabilities, last_error, verified_at, created_by, created_at, updated_at`;
const INTERNAL_COLS = PUBLIC_COLS + ', secret_ciphertext, secret_iv, secret_tag';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class PostHogAdapter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly encryptionKey: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async configure(
    projectId: string,
    input: PostHogConnectionInput,
    actor: string,
  ): Promise<SourceConnection> {
    const encrypted = encryptSecret(input.personal_api_key, this.requireEncryptionKey());
    try {
      const { rows } = await this.pool.query<SourceConnection>(
        `INSERT INTO source_connections (
           project_id, provider, name, host, external_project_id,
           secret_ciphertext, secret_iv, secret_tag, created_by
         ) VALUES ($1, 'posthog', $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${PUBLIC_COLS}`,
        [
          projectId,
          input.name,
          input.host,
          input.project_id,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          actor,
        ],
      );
      return rows[0]!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          'source_connection_name_taken',
          `PostHog source "${input.name}" already exists in this project`,
          'choose a new stable name or disable the old connection first',
        );
      }
      throw error;
    }
  }

  async list(projectId: string): Promise<SourceConnection[]> {
    return listSourceConnections(this.pool, projectId);
  }

  async verify(projectId: string, id: string): Promise<SourceConnection> {
    const connection = await this.getInternal(projectId, id, true);
    try {
      await this.query(connection, {
        query: { kind: 'HogQLQuery', query: 'SELECT 1 AS ok' },
        name: 'poolstatis_connection_verify',
      });
      const { rows } = await this.pool.query<SourceConnection>(
        `UPDATE source_connections SET
           status = 'verified',
           capabilities = $3,
           last_error = NULL,
           verified_at = now(),
           updated_at = now()
         WHERE project_id = $1 AND id = $2
         RETURNING ${PUBLIC_COLS}`,
        [
          projectId,
          id,
          JSON.stringify({
            trend: true,
            funnel: true,
            retention: true,
            sample: true,
            value_metrics: false,
          }),
        ],
      );
      return rows[0]!;
    } catch (error) {
      const message = sanitizedError(error);
      await this.pool.query(
        `UPDATE source_connections SET
           status = 'error', last_error = $3, updated_at = now()
         WHERE project_id = $1 AND id = $2`,
        [projectId, id, message],
      );
      throw error;
    }
  }

  async discoverSchema(projectId: string, id: string): Promise<PostHogSchema> {
    const connection = await this.getInternal(projectId, id);
    const [events, properties] = await Promise.all([
      this.request(connection, 'GET', '/event_definitions/?limit=100'),
      this.request(connection, 'GET', '/property_definitions/?limit=100'),
    ]);
    return {
      events: resultObjects(events)
        .map((row) => ({ name: String(row.name ?? '') }))
        .filter((row) => row.name.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
      properties: resultObjects(properties)
        .map((row) => ({
          name: String(row.name ?? ''),
          scope: row.type === 'person' ? 'actor' as const : 'event' as const,
          value_type: propertyType(row.property_type),
        }))
        .filter((row) => row.name.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
      capabilities: {
        trend: true,
        funnel: true,
        retention: true,
        sample: true,
        value_metrics: false,
      },
    };
  }

  async trend(input: {
    projectId: string;
    connectionId: string;
    metricKey: string;
    event: string;
    filters: PropertyFilter[];
    agg: 'count' | 'unique_actors' | 'value';
    from: Date;
    to: Date;
    interval: 'hour' | 'day' | 'week' | 'month';
    breakdownProperty?: string;
  }): Promise<TrendPoint[]> {
    if (input.agg === 'value' || input.breakdownProperty) {
      throw new ApiError(
        400,
        'posthog_capability_unsupported',
        input.agg === 'value'
          ? 'the P0 PostHog adapter does not support value metric aggregation'
          : 'the P0 PostHog adapter does not support trend breakdowns',
        'use count or unique_actors without a breakdown, or ingest the metric natively',
      );
    }
    const connection = await this.getInternal(input.projectId, input.connectionId);
    const aggregate = input.agg === 'count' ? 'count()' : 'uniqExact(distinct_id)';
    const clauses = [
      `event = '${quote(input.event)}'`,
      `timestamp >= parseDateTimeBestEffort('${quote(input.from.toISOString())}')`,
      `timestamp < parseDateTimeBestEffort('${quote(input.to.toISOString())}')`,
      ...input.filters.map((filter) => posthogFilter(filter)),
    ];
    const query = `SELECT
        dateTrunc('${input.interval}', timestamp) AS bucket,
        ${aggregate} AS value
      FROM events
      WHERE ${clauses.join(' AND ')}
      GROUP BY bucket
      ORDER BY bucket
      LIMIT 1000`;
    const response = await this.query(connection, {
      query: { kind: 'HogQLQuery', query },
      name: 'poolstatis_trend_' + input.metricKey,
    });
    const results = resultRows(response);
    return results.map((row) => ({
      bucket: new Date(String(row[0])).toISOString(),
      value: Number(row[1] ?? 0),
    }));
  }

  async funnel(input: {
    projectId: string;
    connectionId: string;
    metricKeys: string[];
    steps: Array<{ event: string; filters: PropertyFilter[] }>;
    windowSeconds: number;
    from: Date;
    to: Date;
  }): Promise<number[]> {
    if (input.steps.length < 2) {
      throw new ApiError(400, 'posthog_capability_unsupported', 'a PostHog funnel needs at least two steps');
    }
    const connection = await this.getInternal(input.projectId, input.connectionId);
    const ctes: string[] = [];
    input.steps.forEach((step, index) => {
      const filters = [
        `e.event = '${quote(step.event)}'`,
        `e.timestamp >= parseDateTimeBestEffort('${quote(input.from.toISOString())}')`,
        `e.timestamp < parseDateTimeBestEffort('${quote(input.to.toISOString())}')`,
        ...step.filters.map((filter) => posthogFilter(filter, 'e.properties')),
      ];
      if (index === 0) {
        ctes.push(`s0 AS (
          SELECT e.distinct_id, min(e.timestamp) AS t, min(e.timestamp) AS t0
          FROM events e
          WHERE ${filters.join(' AND ')}
          GROUP BY e.distinct_id
        )`);
      } else {
        ctes.push(`s${index} AS (
          SELECT e.distinct_id, min(e.timestamp) AS t, s${index - 1}.t0
          FROM events e
          JOIN s${index - 1} ON s${index - 1}.distinct_id = e.distinct_id
          WHERE ${filters.join(' AND ')}
            AND e.timestamp > s${index - 1}.t
            AND dateDiff('second', s${index - 1}.t0, e.timestamp) <= ${input.windowSeconds}
          GROUP BY e.distinct_id, s${index - 1}.t0
        )`);
      }
    });
    const selects = input.steps.map((_, index) =>
      `(SELECT count() FROM s${index}) AS step_${index}`);
    const response = await this.query(connection, {
      query: {
        kind: 'HogQLQuery',
        query: `WITH ${ctes.join(', ')} SELECT ${selects.join(', ')}`,
      },
      name: 'poolstatis_funnel_' + input.metricKeys.join('_'),
    });
    const row = resultRows(response)[0];
    if (!row) throw new ApiError(502, 'posthog_invalid_response', 'PostHog funnel returned no result row');
    return input.steps.map((_, index) => Number(row[index] ?? 0));
  }

  async retention(input: {
    projectId: string;
    connectionId: string;
    startMetricKey: string;
    returnMetricKey: string;
    start: { event: string; filters: PropertyFilter[] };
    returning: { event: string; filters: PropertyFilter[] };
    interval: 'day' | 'week' | 'month';
    periods: number;
    from: Date;
    to: Date;
  }): Promise<RetentionCohort[]> {
    const connection = await this.getInternal(input.projectId, input.connectionId);
    const baseWindow = [
      `timestamp >= parseDateTimeBestEffort('${quote(input.from.toISOString())}')`,
      `timestamp < parseDateTimeBestEffort('${quote(input.to.toISOString())}')`,
    ];
    const startWhere = [
      `event = '${quote(input.start.event)}'`,
      ...baseWindow,
      ...input.start.filters.map((filter) => posthogFilter(filter)),
    ].join(' AND ');
    const returnWhere = [
      `event = '${quote(input.returning.event)}'`,
      ...baseWindow,
      ...input.returning.filters.map((filter) => posthogFilter(filter)),
    ].join(' AND ');
    const query = `WITH
      starts AS (
        SELECT distinct_id, min(dateTrunc('${input.interval}', timestamp)) AS cohort
        FROM events WHERE ${startWhere}
        GROUP BY distinct_id
      ),
      sizes AS (
        SELECT cohort, count() AS size FROM starts GROUP BY cohort
      ),
      returns AS (
        SELECT DISTINCT distinct_id, dateTrunc('${input.interval}', timestamp) AS rbucket
        FROM events WHERE ${returnWhere}
      ),
      grid AS (
        SELECT s.cohort,
               dateDiff('${input.interval}', s.cohort, r.rbucket) AS period,
               uniqExact(s.distinct_id) AS retained
        FROM starts s
        JOIN returns r ON r.distinct_id = s.distinct_id AND r.rbucket >= s.cohort
        GROUP BY s.cohort, period
      )
      SELECT sizes.cohort, sizes.size, grid.period, grid.retained
      FROM sizes
      LEFT JOIN grid ON grid.cohort = sizes.cohort
        AND grid.period >= 0 AND grid.period < ${input.periods}
      ORDER BY sizes.cohort, grid.period
      LIMIT 1000`;
    const response = await this.query(connection, {
      query: { kind: 'HogQLQuery', query },
      name: 'poolstatis_retention_' + input.startMetricKey + '_' + input.returnMetricKey,
    });
    const byCohort = new Map<string, RetentionCohort>();
    for (const row of resultRows(response)) {
      const cohort = new Date(String(row[0])).toISOString();
      let entry = byCohort.get(cohort);
      if (!entry) {
        entry = {
          cohort,
          size: Number(row[1] ?? 0),
          retained: new Array(input.periods).fill(0),
          mature_periods: maturePeriods(cohort, input.interval, input.periods, input.to),
        };
        byCohort.set(cohort, entry);
      }
      const period = Number(row[2]);
      if (Number.isInteger(period) && period >= 0 && period < input.periods) {
        entry.retained[period] = Number(row[3] ?? 0);
      }
    }
    return [...byCohort.values()];
  }

  async sample(
    projectId: string,
    connectionId: string,
    event: string,
    limit: number,
  ): Promise<Array<{
    event: string;
    timestamp: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  }>> {
    const connection = await this.getInternal(projectId, connectionId);
    const params = new URLSearchParams({ event, limit: String(Math.max(1, Math.min(limit, 100))) });
    const response = await this.request(connection, 'GET', '/events/?' + params.toString());
    return resultObjects(response).map((row) => ({
      event: String(row.event ?? ''),
      timestamp: new Date(String(row.timestamp)).toISOString(),
      distinct_id: String(row.distinct_id ?? ''),
      properties: row.properties && typeof row.properties === 'object' && !Array.isArray(row.properties)
        ? row.properties as Record<string, unknown>
        : {},
    }));
  }

  async aggregate(input: {
    projectId: string;
    connectionId: string;
    metricKey: string;
    windowName: 'baseline' | 'observed';
    event: string;
    filters: PropertyFilter[];
    properties: string[];
    agg: 'count' | 'unique_actors' | 'value';
    from: Date;
    to: Date;
  }): Promise<MetricAggregate> {
    if (input.agg === 'value') {
      throw new ApiError(
        400,
        'posthog_capability_unsupported',
        'the P0 PostHog adapter does not support value metric aggregation',
        'use a count or unique_actors contract metric, or ingest this value metric natively',
      );
    }
    const connection = await this.getInternal(input.projectId, input.connectionId);
    const clauses = [
      `event = '${quote(input.event)}'`,
      `timestamp >= parseDateTimeBestEffort('${quote(input.from.toISOString())}')`,
      `timestamp < parseDateTimeBestEffort('${quote(input.to.toISOString())}')`,
      ...input.filters.map((filter) => posthogFilter(filter)),
    ];
    const value = input.agg === 'count' ? 'count()' : 'uniqExact(distinct_id)';
    const propertyCounts = input.properties.map((property) =>
      `countIf(properties['${quote(property)}'] IS NOT NULL) AS property_${input.properties.indexOf(property)}`,
    );
    const query = `SELECT
        ${value} AS value,
        count() AS events,
        uniqExact(distinct_id) AS actors,
        uniqExact(distinct_id) AS raw_actors,
        countIf(notEmpty(toString(distinct_id))) AS identified_events
        ${propertyCounts.length ? ',\n        ' + propertyCounts.join(',\n        ') : ''}
      FROM events
      WHERE ${clauses.join(' AND ')}
      LIMIT 1`;
    const response = await this.query(connection, {
      query: { kind: 'HogQLQuery', query },
      name: `poolstatis_evaluate_${input.metricKey}_${input.windowName}`,
    });
    const row = resultRows(response)[0] ?? [];
    const events = Number(row[1] ?? 0);
    const propertyCoverage: Record<string, number> = {};
    input.properties.forEach((property, index) => {
      propertyCoverage[property] = events === 0 ? 0 : Number(row[5 + index] ?? 0) / events;
    });
    return {
      value: Number(row[0] ?? 0),
      events,
      actors: Number(row[2] ?? 0),
      rawActors: Number(row[3] ?? 0),
      registeredCoverage: 1,
      distinctIdCoverage: events === 0 ? 0 : Number(row[4] ?? 0) / events,
      propertyCoverage,
    };
  }

  private async getInternal(
    projectId: string,
    id: string,
    allowUnverified = false,
  ): Promise<SourceConnectionRow> {
    const { rows } = await this.pool.query<SourceConnectionRow>(
      `SELECT ${INTERNAL_COLS} FROM source_connections
       WHERE project_id = $1 AND id = $2 AND provider = 'posthog'`,
      [projectId, id],
    );
    if (!rows[0]) throw notFound('source_connection');
    if (!allowUnverified && rows[0].status !== 'verified') {
      throw new ApiError(
        409,
        'source_connection_not_verified',
        `PostHog source status=${rows[0].status} cannot be used for evidence reads`,
        'verify the source successfully before registering metrics or running queries',
      );
    }
    return rows[0];
  }

  private query(
    connection: SourceConnectionRow,
    body: Record<string, unknown>,
  ): Promise<QueryResponse> {
    return this.request(connection, 'POST', '/query/', body) as Promise<QueryResponse>;
  }

  private async request(
    connection: SourceConnectionRow,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const credential = decryptSecret({
      ciphertext: connection.secret_ciphertext,
      iv: connection.secret_iv,
      tag: connection.secret_tag,
    }, this.requireEncryptionKey());
    const url = connection.host
      + '/api/projects/' + encodeURIComponent(connection.external_project_id)
      + path;
    try {
      const response = await this.fetcher(url, {
        method,
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + credential,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const announced = Number(response.headers.get('content-length') ?? 0);
      if (announced > MAX_RESPONSE_BYTES) throw upstreamTooLarge();
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw upstreamTooLarge();
      if (!response.ok) {
        throw new ApiError(
          502,
          'posthog_upstream_error',
          `PostHog returned HTTP ${response.status} for a bounded read request`,
          'verify the host, project ID, personal API key scopes, and PostHog availability',
        );
      }
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiError(502, 'posthog_invalid_response', 'PostHog returned an invalid JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError(
          504,
          'posthog_timeout',
          'PostHog did not finish the bounded read within 10 seconds',
          'retry later or reduce the observation window',
        );
      }
      throw new ApiError(
        502,
        'posthog_unreachable',
        'Poolstatis could not reach the configured PostHog host',
        'verify the private API host and network access',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireEncryptionKey(): string {
    if (!this.encryptionKey) {
      throw new ApiError(
        503,
        'connector_encryption_not_configured',
        'external source credentials cannot be stored without encryption',
        'set POOLSTATIS_CONNECTOR_ENCRYPTION_KEY to at least 16 characters',
      );
    }
    return this.encryptionKey;
  }
}

export async function listSourceConnections(
  pool: pg.Pool,
  projectId: string,
): Promise<SourceConnection[]> {
  const { rows } = await pool.query<SourceConnection>(
    `SELECT ${PUBLIC_COLS} FROM source_connections
     WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows;
}

function resultRows(response: QueryResponse): unknown[][] {
  if (!Array.isArray(response.results) || response.results.some((row) => !Array.isArray(row))) {
    throw new ApiError(502, 'posthog_invalid_response', 'PostHog query results were not row arrays');
  }
  return response.results as unknown[][];
}

function resultObjects(response: Record<string, unknown>): Array<Record<string, unknown>> {
  const results = response.results;
  if (!Array.isArray(results)) {
    throw new ApiError(502, 'posthog_invalid_response', 'PostHog schema results were not an array');
  }
  return results.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
}

function propertyType(value: unknown): PostHogSchema['properties'][number]['value_type'] {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('bool')) return 'boolean';
  if (normalized.includes('numeric') || normalized.includes('number')) return 'number';
  if (normalized.includes('date') || normalized.includes('time')) return 'datetime';
  return 'string';
}

function posthogFilter(filter: PropertyFilter, object = 'properties'): string {
  const property = `${object}['${quote(filter.property)}']`;
  if (filter.op === 'is_set') return property + ' IS NOT NULL';
  if (filter.op === 'is_not_set') return property + ' IS NULL';
  if (filter.op === 'contains') return `position(toString(${property}), ${literal(filter.value)}) > 0`;
  if (filter.op === 'in') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return property + ' IN (' + values.map(literal).join(', ') + ')';
  }
  const operator = {
    eq: '=',
    ne: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }[filter.op];
  return property + ' ' + operator + ' ' + literal(filter.value);
}

function literal(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${quote(String(value ?? ''))}'`;
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function upstreamTooLarge(): ApiError {
  return new ApiError(
    502,
    'posthog_response_too_large',
    'PostHog returned more than 2 MiB for a bounded read',
    'reduce the requested schema/sample/window size',
  );
}

function sanitizedError(error: unknown): string {
  return error instanceof ApiError
    ? error.code + ': ' + error.message
    : 'posthog_connection_failed';
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === '23505';
}

function maturePeriods(
  cohortIso: string,
  interval: 'day' | 'week' | 'month',
  periods: number,
  to: Date,
): number {
  const cohort = new Date(cohortIso);
  let elapsed: number;
  if (interval === 'day') {
    elapsed = Math.floor((to.getTime() - cohort.getTime()) / 86_400_000);
  } else if (interval === 'week') {
    elapsed = Math.floor((to.getTime() - cohort.getTime()) / (7 * 86_400_000));
  } else {
    elapsed = (to.getUTCFullYear() - cohort.getUTCFullYear()) * 12
      + to.getUTCMonth() - cohort.getUTCMonth();
  }
  return Math.max(0, Math.min(periods, elapsed));
}
