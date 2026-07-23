import type pg from 'pg';
import type {
  AppendResult,
  UsageWarning,
  ActorSummary,
  EntityStatusEvidence,
  EntityStatusEvidenceQuery,
  ExperimentResultsQuery,
  ExperimentVariantOutcome,
  ExperienceSessionEvent,
  ExperienceSessionQuery,
  EventStore,
  IdempotentAppend,
  EventNameStat,
  EventStatsQuery,
  FunnelQuery,
  IntervalActivityQuery,
  InteractionMapQuery,
  InteractionMapResult,
  LifecyclePoint,
  MeasurementCoverage,
  MeasurementCoverageQuery,
  MetricAggregate,
  MetricAggregateQuery,
  RawEvent,
  RetentionCohort,
  RetentionQuery,
  SampleQuery,
  StickinessBin,
  StorableEvent,
  TrendPoint,
  TrendQuery,
} from './eventStore.js';
import { andFilters, compileFilters, numericPropSql } from './filters.js';
import { ApiError } from '../errors.js';
import { randomUUID } from 'node:crypto';
import { recordUsageWarnings, type PendingUsageWarning } from '../services/usageWarnings.js';

const IDEMPOTENCY_RECLAIM_INTERVAL = '35 days';
const MAX_METER_QUANTITY = BigInt(Number.MAX_SAFE_INTEGER);

interface MeteredInsertResult {
  inserted: number;
  warnings: PendingUsageWarning[];
}

interface MeteredGroup {
  projectId: string;
  env: string;
  events: StorableEvent[];
  orgId?: string;
}

interface MeteredScope {
  orgId: string;
  periodStart: string;
}

export class PostgresEventStore implements EventStore {
  private readonly knownPartitions = new Set<string>();

  constructor(private readonly pool: pg.Pool) {}

  async append(events: StorableEvent[]): Promise<AppendResult> {
    if (events.length === 0) return { inserted: 0 };
    await this.ensurePartitions(events.map((e) => e.timestamp));
    const groups = new Map<string, MeteredGroup>();
    for (const event of events) {
      const key = `${event.projectId}:${event.env}`;
      const group = groups.get(key);
      if (group) group.events.push(event);
      else groups.set(key, { projectId: event.projectId, env: event.env, events: [event] });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const resolved = await this.resolveMeteredGroups(client, [...groups.values()]);
      await this.acquireUsageConfigLocks(client, resolved
        .filter((group) => hasBillableEvents(group.events))
        .map((group) => group.orgId!));
      const periodStart = await this.currentPeriodStart(client);
      let inserted = 0;
      const warnings: PendingUsageWarning[] = [];
      for (const group of resolved.sort(compareMeteredGroups)) {
        const result = await this.insertMetered(client, group.events, `direct:${randomUUID()}`, group.orgId ? {
          orgId: group.orgId, periodStart,
        } : undefined);
        inserted += result.inserted;
        warnings.push(...result.warnings);
      }
      await client.query('COMMIT');
      await recordUsageWarnings(this.pool, warnings).catch(() => {});
      return { inserted, ...(warnings.length > 0 ? { warnings: warnings.map(toUsageWarning) } : {}) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically claims a Browser Experience batch and writes its events on one
   * connection. A lost HTTP response can therefore only observe a completed
   * batch, never append the same clicks twice on retry.
   */
  async appendIdempotent(batch: IdempotentAppend): Promise<AppendResult> {
    if (batch.events.length > 0) {
      await this.ensurePartitions(batch.events.map((event) => event.timestamp));
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lockKey = `${batch.dedupe}:${batch.projectId}:${batch.env}:${batch.batchId}`;
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
        [lockKey],
      );
      if (!lock.rows[0]?.locked) {
        throw new ApiError(
          503,
          'batch_processing',
          'this batch_id is already being processed',
          'retry the same batch_id shortly; Poolstatis will return duplicate once it is stored',
        );
      }
      const claim = batch.dedupe === 'experience'
        ? await client.query(
          `INSERT INTO experience_batches (project_id, env, batch_id, status, completed_at, last_error)
           VALUES ($1, $2, $3, 'completed', now(), NULL)
           ON CONFLICT (project_id, env, batch_id) DO UPDATE
           SET received_at = now(), status = 'completed', completed_at = now(), last_error = NULL
           WHERE experience_batches.status = 'failed'
              OR experience_batches.received_at < now() - interval '${IDEMPOTENCY_RECLAIM_INTERVAL}'
           RETURNING batch_id`,
          [batch.projectId, batch.env, batch.batchId],
        )
        : await client.query(
          `INSERT INTO ingest_batches (project_id, env, batch_id, status, completed_at, last_error)
           VALUES ($1, $2, $3, 'completed', now(), NULL)
           ON CONFLICT (project_id, env, batch_id) DO UPDATE
           SET received_at = now(), status = 'completed', completed_at = now(), last_error = NULL
           WHERE ingest_batches.status = 'failed'
              OR ingest_batches.received_at < now() - interval '${IDEMPOTENCY_RECLAIM_INTERVAL}'
           RETURNING batch_id`,
          [batch.projectId, batch.env, batch.batchId],
        );
      if ((claim.rowCount ?? 0) === 0) {
        const table = batch.dedupe === 'experience' ? 'experience_batches' : 'ingest_batches';
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM ${table} WHERE project_id = $1 AND env = $2 AND batch_id = $3`,
          [batch.projectId, batch.env, batch.batchId],
        );
        if (existing.rows[0]?.status === 'processing') {
          throw new ApiError(
            503,
            'batch_processing',
            'this batch_id is still marked as processing',
            'retry the same batch_id shortly; only a completed batch is treated as duplicate',
          );
        }
        await client.query('COMMIT');
        return { inserted: 0, duplicate: true };
      }
      const [group] = await this.resolveMeteredGroups(client, [{
        projectId: batch.projectId, env: batch.env, events: batch.events,
      }]);
      if (group?.orgId && hasBillableEvents(batch.events)) {
        await this.acquireUsageConfigLocks(client, [group.orgId]);
      }
      const periodStart = await this.currentPeriodStart(client);
      const metered = batch.events.length > 0
        ? await this.insertMetered(client, batch.events, `${batch.dedupe}:${batch.projectId}:${batch.env}:${batch.batchId}`, group?.orgId ? {
          orgId: group.orgId, periodStart,
        } : undefined)
        : { inserted: 0, warnings: [] };
      await client.query('COMMIT');
      await recordUsageWarnings(this.pool, metered.warnings).catch(() => {});
      return {
        inserted: metered.inserted,
        ...(metered.warnings.length > 0 ? { warnings: metered.warnings.map(toUsageWarning) } : {}),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertMetered(
    client: pg.PoolClient,
    events: StorableEvent[],
    sourceBatch: string,
    scope?: MeteredScope,
  ): Promise<MeteredInsertResult> {
    const first = events[0];
    if (!first) return { inserted: 0, warnings: [] };
    if (events.some((event) => event.projectId !== first.projectId || event.env !== first.env)) {
      throw new Error('a metered append must contain one project and environment');
    }
    const billable = events.filter((event) => event.isSystem !== true && event.eventSource !== 'system');
    if (billable.length === 0) return { inserted: await this.insert(client, events), warnings: [] };

    if (!scope) throw new Error('metered append scope was not resolved');
    const { orgId, periodStart } = scope;
    await client.query(
      `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
       VALUES ($1, 'events_stored', $2::date, 0)
       ON CONFLICT (org_id, meter_key, period_start) DO NOTHING`,
      [orgId, periodStart],
    );
    const usage = await client.query<{ quantity: string }>(
      `SELECT quantity FROM organization_usage
       WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date FOR UPDATE`,
      [orgId, periodStart],
    );
    const entitlement = await client.query<{ hard_limit: string | null; warning_thresholds: string[] }>(
      `SELECT hard_limit, warning_thresholds FROM organization_entitlements WHERE org_id = $1 AND meter_key = 'events_stored'`,
      [orgId],
    );
    const used = BigInt(usage.rows[0]?.quantity ?? 0);
    const limit = entitlement.rows[0]?.hard_limit;
    const nextQuantity = used + BigInt(billable.length);
    if (nextQuantity > MAX_METER_QUANTITY || (limit !== null && limit !== undefined && nextQuantity > BigInt(limit))) {
      throw new ApiError(
        402,
        'billing_limit_reached',
        'the accepted event batch would exceed this organization\'s configured limit',
        'wait for the next UTC billing period or raise the generic events_stored entitlement',
      );
    }
    const inserted = await this.insert(client, events);
    const warnings = (entitlement.rows[0]?.warning_thresholds ?? [])
      .map(BigInt)
      .filter((threshold) => used < threshold && threshold <= nextQuantity)
      .map((threshold) => ({
        orgId, periodStart, meter: 'events_stored' as const, threshold: Number(threshold), quantity: Number(nextQuantity),
      }));
    await client.query(
      `INSERT INTO usage_ledger (org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key)
       VALUES ($1, $2, $3, 'events_stored', $4::date, $5, $6, $7)`,
      [orgId, first.projectId, first.env, periodStart, billable.length, sourceBatch, sourceBatch],
    );
    await client.query(
      `UPDATE organization_usage SET quantity = quantity + $3, updated_at = now()
       WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date`,
      [orgId, periodStart, billable.length],
    );
    return { inserted, warnings };
  }

  private async currentPeriodStart(client: pg.PoolClient): Promise<string> {
    const period = await client.query<{ period_start: string }>(
      `SELECT date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date::text AS period_start`,
    );
    return period.rows[0]!.period_start;
  }

  private async resolveMeteredGroups(client: pg.PoolClient, groups: MeteredGroup[]): Promise<MeteredGroup[]> {
    const projectIds = [...new Set(groups.filter((group) => hasBillableEvents(group.events)).map((group) => group.projectId))];
    if (projectIds.length === 0) return groups;
    const projects = await client.query<{ id: string; org_id: string }>(
      'SELECT id::text, org_id::text FROM projects WHERE id = ANY($1::uuid[]) FOR KEY SHARE', [projectIds],
    );
    const orgByProject = new Map(projects.rows.map((project) => [project.id, project.org_id]));
    for (const group of groups) {
      if (!hasBillableEvents(group.events)) continue;
      const orgId = orgByProject.get(group.projectId);
      if (!orgId) throw new Error(`project ${group.projectId} does not exist`);
      group.orgId = orgId;
    }
    return groups;
  }

  private async acquireUsageConfigLocks(client: pg.PoolClient, orgIds: string[]): Promise<void> {
    for (const orgId of [...new Set(orgIds)].sort((left, right) => left.localeCompare(right))) {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           poolstatis_usage_config_lock_key($1::uuid, 'events_stored')
         )`,
        [orgId],
      );
    }
  }

  private async insert(client: pg.Pool | pg.PoolClient, events: StorableEvent[]): Promise<number> {
    const params: unknown[] = [];
    const rows = events.map((e) => {
      params.push(
        e.projectId, e.env, e.event, e.timestamp, e.distinctId,
        e.sessionId, JSON.stringify(e.properties), e.registered, e.isSystem ?? false,
        e.eventSource ?? (e.isSystem ? 'system' : 'ingest'),
      );
      const base = params.length - 10;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
    });
    const result = await client.query(
      `INSERT INTO events (project_id, env, event, "timestamp", distinct_id, session_id, properties, registered, is_system, event_source)
       VALUES ${rows.join(', ')}`,
      params,
    );
    return result.rowCount ?? 0;
  }

  async trend(q: TrendQuery): Promise<TrendPoint[]> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const where = [
      'project_id = $1',
      'env = $2',
      'event = $3',
      '"timestamp" >= $4',
      '"timestamp" < $5',
      ...compileFilters(q.filters, 'properties', params),
    ].join(' AND ');

    params.push(q.interval);
    // date_trunc on timestamptz truncates in the session timezone; the
    // platform pins it to UTC per connection (see createPool consumers).
    const bucketExpr = `date_trunc($${params.length}, "timestamp")`;

    let valueExpr: string;
    let aggExpr: string;
    switch (q.agg.kind) {
      case 'count':
        valueExpr = '1';
        aggExpr = 'count(*)';
        break;
      case 'unique_actors':
        valueExpr = 'poolstatis_resolve_actor(project_id, env, distinct_id)';
        aggExpr = 'count(DISTINCT val)';
        break;
      case 'value': {
        params.push(q.agg.property);
        valueExpr = numericPropSql('properties', params.length);
        aggExpr =
          q.agg.fn === 'p90'
            ? 'percentile_cont(0.9) WITHIN GROUP (ORDER BY val)'
            : `${q.agg.fn}(val)`;
        break;
      }
    }

    if (!q.breakdownProperty) {
      const sql = `
        SELECT ${bucketExpr} AS bucket, ${aggExpr} AS value
        FROM (SELECT "timestamp", ${valueExpr} AS val FROM events WHERE ${where}) src
        GROUP BY 1 ORDER BY 1`;
      const { rows } = await this.pool.query(sql, params);
      return rows.map((r) => ({ bucket: toIso(r.bucket), value: Number(r.value ?? 0) }));
    }

    params.push(q.breakdownProperty);
    const bvExpr = `COALESCE(properties->>$${params.length}, '(none)')`;
    // Top 10 breakdown values by row count; the long tail is re-aggregated
    // under '$other' from raw rows, so avg/p90 stay mathematically correct.
    const sql = `
      WITH raw AS (
        SELECT ${bucketExpr} AS bucket, ${bvExpr} AS bv, ${valueExpr} AS val
        FROM events WHERE ${where}
      ),
      top AS (
        SELECT bv FROM raw GROUP BY bv ORDER BY count(*) DESC, bv LIMIT 10
      )
      SELECT bucket,
             CASE WHEN raw.bv IN (SELECT bv FROM top) THEN raw.bv ELSE '$other' END AS bv,
             ${aggExpr} AS value
      FROM raw
      GROUP BY 1, 2
      ORDER BY 1, 2`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      bucket: toIso(r.bucket),
      value: Number(r.value ?? 0),
      breakdown_value: String(r.bv),
    }));
  }

  async funnel(q: FunnelQuery): Promise<number[]> {
    const params: unknown[] = [q.projectId, q.env, q.from, q.to, q.windowSeconds];
    const ctes: string[] = [];

    q.steps.forEach((step, i) => {
      params.push(step.event);
      const eventParam = params.length;
      const filterClauses = compileFilters(step.filters, 'e.properties', params)
        .map((c) => ` AND ${c}`)
        .join('');
      if (i === 0) {
        ctes.push(`s0 AS (
          SELECT poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id) AS distinct_id,
                 min(e."timestamp") AS t, min(e."timestamp") AS t0
          FROM events e
          WHERE e.project_id = $1 AND e.env = $2 AND e.event = $${eventParam}
            AND e."timestamp" >= $3 AND e."timestamp" < $4${filterClauses}
          GROUP BY poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id)
        )`);
      } else {
        // Each step must happen after the previous step, within the window
        // anchored at the *first* step (t0), matching how activation windows
        // are usually defined.
        ctes.push(`s${i} AS (
          SELECT poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id) AS distinct_id,
                 min(e."timestamp") AS t, s${i - 1}.t0
          FROM events e
          JOIN s${i - 1}
            ON s${i - 1}.distinct_id = poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id)
          WHERE e.project_id = $1 AND e.env = $2 AND e.event = $${eventParam}
            AND e."timestamp" > s${i - 1}.t
            AND e."timestamp" <= s${i - 1}.t0 + make_interval(secs => $5)${filterClauses}
          GROUP BY poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id), s${i - 1}.t0
        )`);
      }
    });

    const selects = q.steps.map((_, i) => `(SELECT count(*) FROM s${i}) AS c${i}`);
    const sql = `WITH ${ctes.join(', ')} SELECT ${selects.join(', ')}`;
    const { rows } = await this.pool.query(sql, params);
    return q.steps.map((_, i) => Number(rows[0][`c${i}`]));
  }

  /**
   * `active` CTE body: distinct (actor, interval-bucket) pairs for one event.
   * Shared by lifecycle and stickiness. Assumes params already hold
   * [projectId, env, from, to] at $1..$4; appends the event + filter params.
   */
  private activeBucketsBody(q: IntervalActivityQuery, params: unknown[]): string {
    params.push(q.event);
    const eventParam = params.length;
    const filters = andFilters(q.filters, 'properties', params);
    return `SELECT DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id) AS distinct_id,
                   date_trunc('${q.interval}', "timestamp") AS b
            FROM events
            WHERE project_id = $1 AND env = $2 AND event = $${eventParam}
              AND "timestamp" >= $3 AND "timestamp" < $4${filters}`;
  }

  async retention(q: RetentionQuery): Promise<RetentionCohort[]> {
    const iv = q.interval; // safe enum: 'day' | 'week' | 'month'
    const params: unknown[] = [q.projectId, q.env, q.from, q.to];
    const startFilters = andFilters(q.startFilters, 'properties', params);
    params.push(q.startEvent);
    const startEventParam = params.length;
    const returnFilters = andFilters(q.returnFilters, 'properties', params);
    params.push(q.returnEvent);
    const returnEventParam = params.length;
    params.push(q.periods);
    const periodsParam = params.length;

    // period index from cohort bucket to a return bucket, per interval unit
    const periodExpr =
      iv === 'day'
        ? `(r.rbucket::date - s.cohort::date)`
        : iv === 'week'
          ? `((r.rbucket::date - s.cohort::date) / 7)`
          : `((extract(year FROM r.rbucket)::int - extract(year FROM s.cohort)::int) * 12
              + (extract(month FROM r.rbucket)::int - extract(month FROM s.cohort)::int))`;

    const sql = `
      WITH starts AS (
        SELECT poolstatis_resolve_actor(project_id, env, distinct_id) AS distinct_id,
               min(date_trunc('${iv}', "timestamp")) AS cohort
        FROM events
        WHERE project_id = $1 AND env = $2 AND event = $${startEventParam}
          AND "timestamp" >= $3 AND "timestamp" < $4${startFilters}
        GROUP BY poolstatis_resolve_actor(project_id, env, distinct_id)
      ),
      sizes AS (SELECT cohort, count(*)::int AS size FROM starts GROUP BY cohort),
      returns AS (
        SELECT DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id) AS distinct_id,
                        date_trunc('${iv}', "timestamp") AS rbucket
        FROM events
        WHERE project_id = $1 AND env = $2 AND event = $${returnEventParam}
          AND "timestamp" >= $3 AND "timestamp" < $4${returnFilters}
      ),
      grid AS (
        SELECT s.cohort, ${periodExpr} AS period, count(DISTINCT s.distinct_id)::int AS retained
        FROM starts s
        JOIN returns r ON r.distinct_id = s.distinct_id AND r.rbucket >= s.cohort
        GROUP BY s.cohort, period
      )
      SELECT sizes.cohort, sizes.size, grid.period, grid.retained
      FROM sizes
      LEFT JOIN grid ON grid.cohort = sizes.cohort AND grid.period BETWEEN 0 AND $${periodsParam} - 1
      ORDER BY sizes.cohort, grid.period`;

    const { rows } = await this.pool.query(sql, params);
    const byCohort = new Map<string, RetentionCohort>();
    for (const r of rows) {
      const cohort = toIso(r.cohort);
      let entry = byCohort.get(cohort);
      if (!entry) {
        entry = {
          cohort,
          size: Number(r.size),
          retained: new Array(q.periods).fill(0),
          mature_periods: maturePeriods(cohort, q.interval, q.periods, q.to),
        };
        byCohort.set(cohort, entry);
      }
      if (r.period !== null && r.period >= 0 && r.period < q.periods) {
        entry.retained[Number(r.period)] = Number(r.retained);
      }
    }
    return [...byCohort.values()];
  }

  async lifecycle(q: IntervalActivityQuery): Promise<LifecyclePoint[]> {
    const iv = q.interval;
    const step = `interval '1 ${iv}'`;
    const params: unknown[] = [q.projectId, q.env, q.from, q.to];

    // active = distinct (actor, bucket); classify each active bucket by its
    // relation to the actor's previous active bucket; dormant = the bucket
    // right after an active one where the actor did NOT return.
    const sql = `
      WITH active AS (${this.activeBucketsBody(q, params)}),
      seq AS (
        SELECT distinct_id, b,
               lag(b) OVER (PARTITION BY distinct_id ORDER BY b) AS prev_b,
               min(b) OVER (PARTITION BY distinct_id) AS first_b
        FROM active
      ),
      classified AS (
        SELECT b AS bucket,
          CASE
            WHEN b = first_b THEN 'new'
            WHEN prev_b = b - ${step} THEN 'returning'
            ELSE 'resurrecting'
          END AS cls
        FROM seq
      ),
      dormant AS (
        -- Only count an actor dormant in an interval that has fully elapsed by the to bound.
        -- The current (partial) interval is excluded, or every actor active last
        -- interval looks churned merely because this interval hasn't finished.
        SELECT (a.b + ${step}) AS bucket
        FROM active a
        WHERE NOT EXISTS (
          SELECT 1 FROM active a2 WHERE a2.distinct_id = a.distinct_id AND a2.b = a.b + ${step}
        ) AND (a.b + ${step}) < date_trunc('${iv}', $4::timestamptz)
      ),
      live AS (
        SELECT bucket,
          count(*) FILTER (WHERE cls = 'new')::int AS n_new,
          count(*) FILTER (WHERE cls = 'returning')::int AS n_returning,
          count(*) FILTER (WHERE cls = 'resurrecting')::int AS n_resurrecting
        FROM classified GROUP BY bucket
      ),
      dead AS (SELECT bucket, count(*)::int AS n_dormant FROM dormant GROUP BY bucket)
      SELECT b.bucket,
             COALESCE(live.n_new, 0) AS n_new,
             COALESCE(live.n_returning, 0) AS n_returning,
             COALESCE(live.n_resurrecting, 0) AS n_resurrecting,
             COALESCE(dead.n_dormant, 0) AS n_dormant
      FROM (SELECT bucket FROM live UNION SELECT bucket FROM dead) b
      LEFT JOIN live ON live.bucket = b.bucket
      LEFT JOIN dead ON dead.bucket = b.bucket
      ORDER BY b.bucket`;

    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      bucket: toIso(r.bucket),
      new: Number(r.n_new),
      returning: Number(r.n_returning),
      resurrecting: Number(r.n_resurrecting),
      dormant: -Number(r.n_dormant),
    }));
  }

  async stickiness(q: IntervalActivityQuery): Promise<StickinessBin[]> {
    const params: unknown[] = [q.projectId, q.env, q.from, q.to];
    const sql = `
      WITH active AS (${this.activeBucketsBody(q, params)}),
      per AS (SELECT distinct_id, count(*)::int AS n FROM active GROUP BY distinct_id)
      SELECT n AS intervals_active, count(*)::int AS actors
      FROM per GROUP BY n ORDER BY n`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({ intervals_active: Number(r.intervals_active), actors: Number(r.actors) }));
  }

  async experimentResults(q: ExperimentResultsQuery): Promise<ExperimentVariantOutcome[]> {
    const params: unknown[] = [q.projectId, q.env, q.flagKey, q.from, q.to, q.metricEvent];
    const outcomeFilters = compileFilters(q.metricFilters, 'e.properties', params)
      .map((clause) => ` AND ${clause}`)
      .join('');
    const { rows } = await this.pool.query<{ variant: string; exposed: string; converted: string }>(
      `WITH first_exposures AS (
         SELECT DISTINCT ON (poolstatis_resolve_actor(project_id, env, distinct_id))
           poolstatis_resolve_actor(project_id, env, distinct_id) AS distinct_id,
           properties->>'variant' AS variant,
           "timestamp" AS exposed_at
         FROM events
         WHERE project_id = $1
           AND env = $2
           AND event = '$feature_flag_called'
           AND is_system = true
           AND properties->>'flag_key' = $3
           AND "timestamp" >= $4
           AND "timestamp" < $5
         ORDER BY poolstatis_resolve_actor(project_id, env, distinct_id), "timestamp"
       ),
       outcomes AS (
         SELECT DISTINCT x.distinct_id
         FROM first_exposures x
         JOIN events e ON e.project_id = $1
           AND e.env = $2
           AND e.event = $6
           AND poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id) = x.distinct_id
           AND e."timestamp" >= x.exposed_at
           AND e."timestamp" < $5${outcomeFilters}
       )
       SELECT x.variant,
              count(*)::int AS exposed,
              count(o.distinct_id)::int AS converted
       FROM first_exposures x
       LEFT JOIN outcomes o ON o.distinct_id = x.distinct_id
       GROUP BY x.variant
       ORDER BY x.variant`,
      params,
    );
    return rows.map((row) => ({
      variant: row.variant,
      exposed: Number(row.exposed),
      converted: Number(row.converted),
    }));
  }

  async interactionMap(q: InteractionMapQuery): Promise<InteractionMapResult> {
    const params: unknown[] = [q.projectId, q.env, q.surface, q.from, q.to, q.grid];
    const [cells, labels] = await Promise.all([
      this.pool.query<{ x: string; y: string; count: string; actors: string }>(
        `SELECT
           least($6 - 1, floor((properties->>'x')::double precision * $6)::int) AS x,
           least($6 - 1, floor((properties->>'y')::double precision * $6)::int) AS y,
           count(*)::int AS count,
           count(DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id))::int AS actors
         FROM events
         WHERE project_id = $1 AND env = $2
           AND event = 'experience.element_clicked' AND event_source = 'experience'
           AND properties->>'surface' = $3
           AND "timestamp" >= $4 AND "timestamp" < $5
         GROUP BY 1, 2
         ORDER BY count DESC, y, x`,
        params,
      ),
      this.pool.query<{ label: string; count: string; actors: string }>(
        `SELECT properties->>'label' AS label, count(*)::int AS count,
                count(DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id))::int AS actors
         FROM events
         WHERE project_id = $1 AND env = $2
           AND event = 'experience.element_clicked' AND event_source = 'experience'
           AND properties->>'surface' = $3
           AND "timestamp" >= $4 AND "timestamp" < $5
         GROUP BY 1
         ORDER BY count DESC, label
         LIMIT 20`,
        params.slice(0, 5),
      ),
    ]);
    return {
      cells: cells.rows.map((row) => ({ x: Number(row.x), y: Number(row.y), count: Number(row.count), actors: Number(row.actors) })),
      labels: labels.rows.map((row) => ({ label: row.label, count: Number(row.count), actors: Number(row.actors) })),
    };
  }

  async experienceSession(q: ExperienceSessionQuery): Promise<ExperienceSessionEvent[]> {
    const { rows } = await this.pool.query<{ event: string; timestamp: Date; properties: Record<string, unknown> }>(
      `SELECT event, "timestamp", properties
       FROM events
       WHERE project_id = $1 AND env = $2 AND session_id = $3
         AND event_source = 'experience'
         AND event IN ('experience.page_viewed', 'experience.element_clicked', 'experience.scroll_depth', 'experience.client_error')
         AND properties->>'surface' = $4
         AND "timestamp" >= $5 AND "timestamp" < $6
       ORDER BY "timestamp", (properties->>'sequence')::int
       LIMIT $7`,
      [q.projectId, q.env, q.sessionId, q.surface, q.from, q.to, q.limit],
    );
    return rows.map((row) => toExperienceSessionEvent(row));
  }

  async purge(projectId: string, env?: string, distinctId?: string): Promise<number> {
    const params: unknown[] = [projectId];
    let sql = 'DELETE FROM events WHERE project_id = $1';
    if (env !== undefined) {
      params.push(env);
      sql += ` AND env = $${params.length}`;
    }
    if (distinctId !== undefined) {
      params.push(distinctId);
      sql += ` AND distinct_id = $${params.length}`;
    }
    const { rowCount } = await this.pool.query(sql, params);
    return rowCount ?? 0;
  }

  async sample(q: SampleQuery): Promise<RawEvent[]> {
    const params: unknown[] = [q.projectId];
    const where = ['project_id = $1'];
    if (q.env !== undefined) {
      params.push(q.env);
      where.push(`env = $${params.length}`);
    }
    if (q.event !== undefined) {
      params.push(q.event);
      where.push(`event = $${params.length}`);
    }
    if (q.registered !== undefined) {
      params.push(q.registered);
      where.push(`registered = $${params.length}`);
    }
    if (q.distinct_id !== undefined) {
      params.push(q.distinct_id);
      where.push(`distinct_id = $${params.length}`);
    }
    if (q.from !== undefined) {
      params.push(q.from);
      where.push(`"timestamp" >= $${params.length}`);
    }
    if (q.to !== undefined) {
      params.push(q.to);
      where.push(`"timestamp" < $${params.length}`);
    }
    if (q.filters?.length) {
      where.push(...compileFilters(q.filters, 'properties', params));
    }
    params.push(q.limit);
    const sql = `
      SELECT event, "timestamp", distinct_id, session_id, properties, registered, env
      FROM events WHERE ${where.join(' AND ')}
      ORDER BY ingested_at DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      event: r.event,
      timestamp: toIso(r.timestamp),
      distinct_id: r.distinct_id,
      session_id: r.session_id,
      properties: r.properties,
      registered: r.registered,
      env: r.env,
    }));
  }

  async actorSummary(projectId: string, env: string, distinctId: string): Promise<ActorSummary> {
    const where = `project_id = $1 AND env = $2
      AND poolstatis_resolve_actor(project_id, env, distinct_id)
        = poolstatis_resolve_actor($1::uuid, $2, $3)`;
    const args = [projectId, env, distinctId];
    const [agg, top] = await Promise.all([
      this.pool.query(
        `SELECT min("timestamp") AS first_seen, max("timestamp") AS last_seen,
                count(*)::int AS total_events,
                count(DISTINCT event)::int AS distinct_events,
                count(DISTINCT date_trunc('day', "timestamp"))::int AS active_days,
                count(DISTINCT session_id)::int AS sessions,
                COALESCE(avg(registered::int), 0)::float AS registered_share
         FROM events WHERE ${where}`,
        args,
      ),
      this.pool.query(
        `SELECT event, count(*)::int AS count FROM events WHERE ${where}
         GROUP BY event ORDER BY count DESC LIMIT 8`,
        args,
      ),
    ]);
    const r = agg.rows[0];
    return {
      first_seen: r.first_seen ? toIso(r.first_seen) : null,
      last_seen: r.last_seen ? toIso(r.last_seen) : null,
      total_events: Number(r.total_events),
      distinct_events: Number(r.distinct_events),
      active_days: Number(r.active_days),
      sessions: Number(r.sessions),
      registered_share: Number(r.registered_share),
      top_events: top.rows.map((t) => ({ event: t.event, count: Number(t.count) })),
    };
  }

  async eventNames(projectId: string, env: string, sinceDays: number): Promise<EventNameStat[]> {
    const { rows } = await this.pool.query(
      `SELECT event, count(*) AS count, avg(registered::int) AS registered_share,
              max("timestamp") AS last_seen
       FROM events
       WHERE project_id = $1 AND env = $2 AND "timestamp" >= now() - make_interval(days => $3)
       GROUP BY event ORDER BY count DESC`,
      [projectId, env, sinceDays],
    );
    return rows.map((r) => ({
      event: r.event,
      count: Number(r.count),
      registered_share: Number(r.registered_share),
      last_seen: toIso(r.last_seen),
    }));
  }

  async eventStats(q: EventStatsQuery): Promise<EventNameStat[]> {
    if (q.events.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT event, count(*) AS count, avg(registered::int) AS registered_share,
              max("timestamp") AS last_seen
       FROM events
       WHERE project_id = $1
         AND env = $2
         AND "timestamp" >= now() - make_interval(days => $3)
         AND event = ANY($4::text[])
       GROUP BY event ORDER BY count DESC`,
      [q.projectId, q.env, q.sinceDays, q.events],
    );
    return rows.map((r) => ({
      event: r.event,
      count: Number(r.count),
      registered_share: Number(r.registered_share),
      last_seen: toIso(r.last_seen),
    }));
  }

  async measurementCoverage(q: MeasurementCoverageQuery): Promise<MeasurementCoverage> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.sinceDays];
    const filters = andFilters(q.filters, 'properties', params);
    const where = `project_id = $1 AND env = $2 AND event = $3
      AND "timestamp" >= now() - make_interval(days => $4)${filters}`;
    const totals = await this.pool.query(
      `SELECT
         count(*)::int AS events,
         count(DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id))::int AS actors,
         count(DISTINCT distinct_id)::int AS raw_actors,
         COALESCE(avg(registered::int), 0)::float AS registered_coverage,
         COALESCE(avg((length(distinct_id) > 0)::int), 0)::float AS distinct_id_coverage
       FROM events WHERE ${where}`,
      params,
    );
    const propertyCoverage: Record<string, number> = {};
    if (q.properties.length > 0) {
      params.push(q.properties);
      const propertyParam = params.length;
      const properties = await this.pool.query<{ key: string; coverage: number }>(
        `SELECT keys.key,
                COALESCE(
                  count(*) FILTER (WHERE events.properties ? keys.key)::float
                    / NULLIF(count(*), 0),
                  0
                ) AS coverage
         FROM events
         CROSS JOIN unnest($${propertyParam}::text[]) AS keys(key)
         WHERE ${where}
         GROUP BY keys.key`,
        params,
      );
      for (const row of properties.rows) propertyCoverage[row.key] = Number(row.coverage);
    }
    const row = totals.rows[0]!;
    return {
      events: Number(row.events),
      actors: Number(row.actors),
      rawActors: Number(row.raw_actors),
      registeredCoverage: Number(row.registered_coverage),
      distinctIdCoverage: Number(row.distinct_id_coverage),
      propertyCoverage,
    };
  }

  async metricAggregate(q: MetricAggregateQuery): Promise<MetricAggregate> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const filters = andFilters(q.filters, 'properties', params);
    const where = `project_id = $1 AND env = $2 AND event = $3
      AND "timestamp" >= $4 AND "timestamp" < $5${filters}`;
    let valueExpression: string;
    if (q.agg.kind === 'count') {
      valueExpression = 'count(*)';
    } else if (q.agg.kind === 'unique_actors') {
      valueExpression = 'count(DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id))';
    } else {
      params.push(q.agg.property);
      const numeric = numericPropSql('properties', params.length);
      valueExpression = q.agg.fn === 'p90'
        ? `percentile_cont(0.9) WITHIN GROUP (ORDER BY ${numeric})`
        : `${q.agg.fn}(${numeric})`;
    }
    const totals = await this.pool.query(
      `SELECT
         COALESCE(${valueExpression}, 0)::float AS value,
         count(*)::int AS events,
         count(DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id))::int AS actors,
         count(DISTINCT distinct_id)::int AS raw_actors,
         COALESCE(avg(registered::int), 0)::float AS registered_coverage,
         COALESCE(avg((length(distinct_id) > 0)::int), 0)::float AS distinct_id_coverage
       FROM events WHERE ${where}`,
      params,
    );
    const propertyCoverage: Record<string, number> = {};
    if (q.properties.length > 0) {
      params.push(q.properties);
      const propertyParam = params.length;
      const properties = await this.pool.query<{ key: string; coverage: number }>(
        `SELECT keys.key,
                COALESCE(count(*) FILTER (WHERE events.properties ? keys.key)::float
                  / NULLIF(count(*), 0), 0) AS coverage
         FROM events
         CROSS JOIN unnest($${propertyParam}::text[]) AS keys(key)
         WHERE ${where}
         GROUP BY keys.key`,
        params,
      );
      for (const row of properties.rows) propertyCoverage[row.key] = Number(row.coverage);
    }
    const row = totals.rows[0]!;
    return {
      value: Number(row.value),
      events: Number(row.events),
      actors: Number(row.actors),
      rawActors: Number(row.raw_actors),
      registeredCoverage: Number(row.registered_coverage),
      distinctIdCoverage: Number(row.distinct_id_coverage),
      propertyCoverage,
    };
  }

  async entityStatusEvidence(q: EntityStatusEvidenceQuery): Promise<EntityStatusEvidence[]> {
    if (q.specs.length === 0) return [];
    const { rows } = await this.pool.query(
      `WITH expected AS (
         SELECT event, entity_type, expected_status
         FROM jsonb_to_recordset($3::jsonb)
           AS x(event text, entity_type text, expected_status text)
       ),
       matched AS (
         SELECT
           expected.entity_type,
           COALESCE(
             events.properties->>'entity_id',
             events.properties->>(expected.entity_type || '_id'),
             events.properties->>'id'
           ) AS entity_id,
           events.event,
           expected.expected_status,
           max(events."timestamp") AS last_event_at,
           count(*)::int AS evidence_events
         FROM events
         JOIN expected ON expected.event = events.event
         WHERE events.project_id = $1
           AND events.env = $2
           AND events."timestamp" >= now() - make_interval(days => $4)
         GROUP BY expected.entity_type, entity_id, events.event, expected.expected_status
       )
       SELECT
         matched.entity_type,
         matched.entity_id,
         entities.properties->>'status' AS current_status,
         matched.event,
         matched.expected_status,
         matched.last_event_at,
         matched.evidence_events,
         entities.updated_at AS entity_updated_at
       FROM matched
       JOIN entities
         ON entities.project_id = $1
        AND entities.env = $2
        AND entities.entity_type = matched.entity_type
        AND entities.entity_id = matched.entity_id
       WHERE matched.entity_id IS NOT NULL
         AND entities.properties->>'status' IS NOT NULL
         AND lower(entities.properties->>'status') <> matched.expected_status
       ORDER BY last_event_at DESC
       LIMIT $5`,
      [q.projectId, q.env, JSON.stringify(q.specs), q.sinceDays, q.limit],
    );
    return rows.map((r) => ({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      current_status: r.current_status,
      event: r.event,
      expected_status: r.expected_status,
      last_event_at: toIso(r.last_event_at),
      evidence_events: Number(r.evidence_events),
      entity_updated_at: toIso(r.entity_updated_at),
    }));
  }

  /**
   * Create monthly partitions for every month present in the batch.
   * The DEFAULT partition is a safety net, but routing rows to monthly
   * partitions keeps retention cheap (DROP TABLE instead of DELETE).
   */
  private async ensurePartitions(timestamps: Date[]): Promise<void> {
    const months = new Set<string>();
    for (const ts of timestamps) {
      months.add(`${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    for (const month of months) {
      if (this.knownPartitions.has(month)) continue;
      const [y, m] = month.split('-').map(Number) as [number, number];
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const table = `events_y${y}m${String(m).padStart(2, '0')}`;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // Advisory lock serializes concurrent partition creation across workers.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${table} PARTITION OF events
           FOR VALUES FROM ('${from}') TO ('${next}')`,
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        // A row for this month will land in the DEFAULT partition instead —
        // ingest must not fail because partition DDL raced or was denied.
        if (!isPartitionOverlapError(err)) throw err;
      } finally {
        client.release();
      }
      this.knownPartitions.add(month);
    }
  }
}

function toUsageWarning(warning: PendingUsageWarning): UsageWarning {
  return { meter: warning.meter, threshold: warning.threshold, quantity: warning.quantity };
}

function hasBillableEvents(events: StorableEvent[]): boolean {
  return events.some((event) => event.isSystem !== true && event.eventSource !== 'system');
}

function compareMeteredGroups(left: MeteredGroup, right: MeteredGroup): number {
  return (left.orgId ?? '').localeCompare(right.orgId ?? '')
    || left.projectId.localeCompare(right.projectId)
    || left.env.localeCompare(right.env);
}

function isPartitionOverlapError(err: unknown): boolean {
  // 42P17 invalid_object_definition: thrown when the DEFAULT partition already
  // holds rows that would belong to the new partition. PostgreSQL can surface
  // the same race as a 23514 partition-constraint violation after another
  // writer has populated the default partition.
  if (typeof err !== 'object' || err === null) return false;
  const value = err as { code?: string; message?: string };
  return value.code === '42P17'
    || (value.code === '23514' && value.message?.includes('default partition') === true);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toExperienceSessionEvent(
  row: { event: string; timestamp: Date; properties: Record<string, unknown> },
): ExperienceSessionEvent {
  const properties = row.properties;
  const base = {
    timestamp: toIso(row.timestamp),
    route: String(properties.route),
    sequence: Number(properties.sequence),
  };
  if (row.event === 'experience.element_clicked') {
    return { ...base, kind: 'element_clicked', label: String(properties.label), x: Number(properties.x), y: Number(properties.y) };
  }
  if (row.event === 'experience.scroll_depth') return { ...base, kind: 'scroll_depth', depth: Number(properties.depth) };
  if (row.event === 'experience.client_error') {
    return { ...base, kind: 'client_error', error_type: properties.error_type as 'error' | 'unhandled_rejection' };
  }
  return { ...base, kind: 'page_viewed' };
}

/**
 * How many leading retention periods have fully elapsed for a cohort by `to`.
 * Period p observes the window [cohort + p·interval, cohort + (p+1)·interval); it
 * is mature only once that window has fully passed. Periods past this are
 * right-censored (their 0s mean "not yet", not "churned").
 */
function maturePeriods(
  cohortIso: string,
  interval: 'day' | 'week' | 'month',
  periods: number,
  to: Date,
): number {
  for (let p = 0; p < periods; p++) {
    const end = new Date(cohortIso);
    if (interval === 'month') end.setUTCMonth(end.getUTCMonth() + (p + 1));
    else end.setUTCDate(end.getUTCDate() + (interval === 'week' ? 7 : 1) * (p + 1));
    if (end.getTime() > to.getTime()) return p;
  }
  return periods;
}
