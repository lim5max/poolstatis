import type pg from 'pg';
import type {
  ActorSummary,
  ActorActivityQuery,
  ActorActivityResult,
  ActorListItem,
  ActorListRecord,
  ActorsQuery,
  ActorsResult,
  EntityStatusEvidence,
  EntityStatusEvidenceQuery,
  ExperimentResultsQuery,
  ExperimentVariantOutcome,
  ExperienceSessionEvent,
  ExperienceSessionQuery,
  ExperienceSessionResult,
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
  WebAnalyticsQuery,
  WebAnalyticsResult,
  WebEngagementBaseQuery,
  WebSessionsQuery,
  WebSessionsResult,
  WebSessionQuery,
  WebSessionResult,
  WebSessionSummary,
  PageEngagementQuery,
  WebPageEngagement,
  WebPageEngagementResult,
} from './eventStore.js';
import { andFilters, compileFilters, numericPropSql } from './filters.js';
import { ApiError } from '../errors.js';

export class PostgresEventStore implements EventStore {
  private readonly knownPartitions = new Set<string>();

  constructor(private readonly pool: pg.Pool) {}

  async append(events: StorableEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensurePartitions(events.map((e) => e.timestamp));

    await this.insert(this.pool, events);
  }

  /**
   * Atomically claims a Browser Experience batch and writes its events on one
   * connection. A lost HTTP response can therefore only observe a completed
   * batch, never append the same clicks twice on retry.
   */
  async appendIdempotent(batch: IdempotentAppend): Promise<boolean> {
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
           ON CONFLICT (project_id, env, batch_id) DO NOTHING
           RETURNING batch_id`,
          [batch.projectId, batch.env, batch.batchId],
        )
        : await client.query(
          `INSERT INTO ingest_batches (project_id, env, batch_id, status, completed_at, last_error)
           VALUES ($1, $2, $3, 'completed', now(), NULL)
           ON CONFLICT (project_id, env, batch_id) DO UPDATE
           SET received_at = now(), status = 'completed', completed_at = now(), last_error = NULL
           WHERE ingest_batches.status = 'failed'
              OR ingest_batches.received_at < now() - interval '24 hours'
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
        return false;
      }
      if (batch.events.length > 0) await this.insert(client, batch.events);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async insert(client: pg.Pool | pg.PoolClient, events: StorableEvent[]): Promise<void> {
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
    await client.query(
      `INSERT INTO events (project_id, env, event, "timestamp", distinct_id, session_id, properties, registered, is_system, event_source)
       VALUES ${rows.join(', ')}`,
      params,
    );
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

  async webAnalytics(q: WebAnalyticsQuery): Promise<WebAnalyticsResult> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const filters = andFilters(q.filters, 'properties', params);
    const where = `project_id = $1 AND env = $2 AND event = $3
      AND "timestamp" >= $4 AND "timestamp" < $5${filters}`;
    const counts = `count(DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id))::int AS visitors,
      count(DISTINCT (
        poolstatis_resolve_actor(project_id, env, distinct_id), session_id
      )) FILTER (WHERE session_id IS NOT NULL AND session_id <> '')::int AS sessions,
      count(*)::int AS page_views`;
    const summaryRow = (await this.pool.query(
      `SELECT ${counts} FROM events WHERE ${where}`,
      params,
    )).rows[0] ?? {};
    const engagementParams: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const engagementRow = (await this.pool.query(
      `${this.webEngagementCtes(q, engagementParams)}
       SELECT
         count(*) FILTER (WHERE engaged IS NOT NULL)::int AS measured_sessions,
         count(*) FILTER (WHERE NOT complete)::int AS incomplete_sessions,
         count(*) FILTER (WHERE engaged IS NULL)::int AS unknown_sessions,
         count(*) FILTER (WHERE engaged)::int AS engaged_sessions,
         count(*) FILTER (WHERE bounce)::int AS bounce_sessions,
         count(*) FILTER (WHERE single_page)::int AS single_page_sessions,
         COALESCE(sum(timed_page_views), 0)::int AS timed_page_views,
         COALESCE(sum(page_views), 0)::int AS total_page_views,
         COALESCE(sum(foreground_ms), 0)::bigint AS foreground_ms,
         COALESCE(sum(session_span_ms), 0)::bigint AS session_span_ms,
         floor(avg(session_span_ms) FILTER (WHERE complete))::bigint
           AS average_session_duration_ms
       FROM session_rows`,
      engagementParams,
    )).rows[0] ?? {};
    const summary = {
      visitors: Number(summaryRow.visitors ?? 0),
      sessions: Number(summaryRow.sessions ?? 0),
      page_views: Number(summaryRow.page_views ?? 0),
      average_session_duration_ms: engagementRow.average_session_duration_ms === null
        || engagementRow.average_session_duration_ms === undefined
        ? null
        : Number(engagementRow.average_session_duration_ms),
    };
    const measuredSessions = Number(engagementRow.measured_sessions ?? 0);
    const engagedSessions = Number(engagementRow.engaged_sessions ?? 0);
    const bounceSessions = Number(engagementRow.bounce_sessions ?? 0);
    const timedPageViews = Number(engagementRow.timed_page_views ?? 0);
    const engagement = {
      measured_sessions: measuredSessions,
      incomplete_sessions: Number(engagementRow.incomplete_sessions ?? 0),
      unknown_sessions: Number(engagementRow.unknown_sessions ?? 0),
      engaged_sessions: engagedSessions,
      bounce_sessions: bounceSessions,
      measured_session_coverage: summary.sessions === 0 ? null : measuredSessions / summary.sessions,
      engaged_rate: measuredSessions === 0 ? null : engagedSessions / measuredSessions,
      bounce_rate: measuredSessions === 0 ? null : bounceSessions / measuredSessions,
      single_page_sessions: Number(engagementRow.single_page_sessions ?? 0),
      timed_page_views: timedPageViews,
      total_page_views: summary.page_views,
      timed_page_coverage: summary.page_views === 0 ? null : timedPageViews / summary.page_views,
      foreground_ms: Number(engagementRow.foreground_ms ?? 0),
      session_span_ms: Number(engagementRow.session_span_ms ?? 0),
    };
    const breakdowns: WebAnalyticsResult['breakdowns'] = {};
    const truncatedDimensions: string[] = [];
    for (const dimension of q.dimensions) {
      const dimensionParams = [...params, dimension.property, dimension.missingValue];
      const propertyParam = dimensionParams.length - 1;
      const missingParam = dimensionParams.length;
      const rows = await this.pool.query(
        `SELECT COALESCE(properties->>$${propertyParam}, $${missingParam}) AS value, ${counts}
         FROM events WHERE ${where}
         GROUP BY 1
         ORDER BY page_views DESC, value ASC
         LIMIT 51`,
        dimensionParams,
      );
      if (rows.rows.length > 50) truncatedDimensions.push(dimension.key);
      breakdowns[dimension.key] = rows.rows.slice(0, 50).map((row) => ({
        value: String(row.value),
        visitors: Number(row.visitors),
        sessions: Number(row.sessions),
        page_views: Number(row.page_views),
      }));
    }
    return { summary, engagement, breakdowns, truncatedDimensions };
  }

  async webSessions(q: WebSessionsQuery): Promise<WebSessionsResult> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const ctes = this.webEngagementCtes(q, params);
    params.push(q.limit);
    const { rows } = await this.pool.query(
      `${ctes}
       SELECT *, count(*) OVER ()::int AS total
       FROM session_rows
       ORDER BY started_at DESC, session_id, actor_id
       LIMIT $${params.length}`,
      params,
    );
    return {
      sessions: rows.map((row) => this.webSessionSummary(row)),
      total: Number(rows[0]?.total ?? 0),
    };
  }

  async webSession(q: WebSessionQuery): Promise<WebSessionResult> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const ctes = this.webEngagementCtes(q, params);
    params.push(q.sessionId);
    const sessionParam = params.length;
    params.push(q.actorId ?? null);
    const actorParam = params.length;
    params.push(q.pageLimit);
    const limitParam = params.length;
    const [summaryRows, pageRows] = await Promise.all([
      this.pool.query(
        `${ctes}
         SELECT * FROM session_rows
         WHERE session_id = $${sessionParam}
           AND ($${actorParam}::text IS NULL OR actor_id = $${actorParam})
           AND $${limitParam}::int > 0`,
        params,
      ),
      this.pool.query(
        `${ctes}
         SELECT *, count(*) OVER ()::int AS total_pages
         FROM pages
         WHERE session_id = $${sessionParam}
           AND ($${actorParam}::text IS NULL OR actor_id = $${actorParam})
         ORDER BY viewed_at, page_view_id, actor_id
         LIMIT $${limitParam}`,
        params,
      ),
    ]);
    if (!q.actorId && summaryRows.rows.length > 1) {
      return { summary: null, pages: [], total: 0, ambiguous_actor: true };
    }
    return {
      summary: summaryRows.rows[0] ? this.webSessionSummary(summaryRows.rows[0]) : null,
      pages: pageRows.rows.map((row) => this.webPageEngagement(row)),
      total: Number(pageRows.rows[0]?.total_pages ?? summaryRows.rows[0]?.page_views ?? 0),
      ambiguous_actor: false,
    };
  }

  async pageEngagement(q: PageEngagementQuery): Promise<WebPageEngagementResult> {
    const params: unknown[] = [q.projectId, q.env, q.event, q.from, q.to];
    const ctes = this.webEngagementCtes(q, params);
    params.push(q.pageViewId);
    const pageParam = params.length;
    params.push(q.actorId ?? null);
    const actorParam = params.length;
    params.push(q.sessionId ?? null);
    const sessionParam = params.length;
    const { rows } = await this.pool.query(
      `${ctes},
       matched_pages AS (
         SELECT * FROM pages
         WHERE page_view_id = $${pageParam}
           AND ($${actorParam}::text IS NULL OR actor_id = $${actorParam})
           AND ($${sessionParam}::text IS NULL OR session_id = $${sessionParam})
       )
       SELECT *,
         (SELECT count(DISTINCT (actor_id, session_id))::int FROM matched_pages) AS identity_count
       FROM matched_pages
       ORDER BY viewed_at DESC, session_id, actor_id
       LIMIT 1`,
      params,
    );
    const ambiguousActor = Number(rows[0]?.identity_count ?? 0) > 1;
    return {
      page: rows[0] && !ambiguousActor ? this.webPageEngagement(rows[0]) : null,
      ambiguous_actor: ambiguousActor,
    };
  }

  private webEngagementCtes(q: WebEngagementBaseQuery, params: unknown[]): string {
    const pageFilters = andFilters(q.filters, 'p.properties', params);
    const keySessions = q.keyMetric
      ? (() => {
          params.push(q.keyMetric.event);
          const eventParam = params.length;
          const keyFilters = andFilters(q.keyMetric.filters, 'k.properties', params);
          return `key_sessions AS (
            SELECT DISTINCT
              k.project_id,
              k.env,
              k.session_id,
              poolstatis_resolve_actor(k.project_id, k.env, k.distinct_id) AS actor_id
            FROM events k
            WHERE k.project_id = $1
              AND k.env = $2
              AND k.event = $${eventParam}
              AND k."timestamp" >= $4
              AND k."timestamp" < $5
              AND k.session_id IS NOT NULL
              AND k.session_id <> ''${keyFilters}
          )`;
        })()
      : `key_sessions AS (
          SELECT
            NULL::uuid AS project_id,
            NULL::text AS env,
            NULL::text AS session_id,
            NULL::text AS actor_id
          WHERE false
        )`;
    return `
      WITH page_views AS (
        SELECT
          p.project_id,
          p.env,
          p.session_id,
          poolstatis_resolve_actor(p.project_id, p.env, p.distinct_id) AS actor_id,
          p.properties->>'$page_view_id' AS page_view_id,
          p.properties->>'$route_key' AS route,
          p."timestamp" AS viewed_at
        FROM events p
        WHERE p.project_id = $1
          AND p.env = $2
          AND p.event = $3
          AND p."timestamp" >= $4
          AND p."timestamp" < $5
          AND p.session_id IS NOT NULL
          AND p.session_id <> ''
          AND p.properties->>'$page_view_id' IS NOT NULL${pageFilters}
      ),
      ranked_engagement AS (
        SELECT
          e.project_id,
          e.env,
          e.session_id,
          poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id) AS actor_id,
          e.properties->>'$page_view_id' AS page_view_id,
          e."timestamp" AS last_snapshot_at,
          CASE WHEN e.properties->>'sequence' ~ '^\\d{1,10}$'
            AND (e.properties->>'sequence')::numeric <= 2147483647
            THEN (e.properties->>'sequence')::int END AS sequence,
          CASE WHEN e.properties->>'foreground_ms' ~ '^\\d{1,9}$'
            AND (e.properties->>'foreground_ms')::numeric <= 604800000
            THEN (e.properties->>'foreground_ms')::bigint END AS foreground_ms,
          CASE WHEN e.properties->>'elapsed_ms' ~ '^\\d{1,9}$'
            AND (e.properties->>'elapsed_ms')::numeric <= 604800000
            THEN (e.properties->>'elapsed_ms')::bigint END AS elapsed_ms,
          CASE WHEN e.properties->>'max_scroll_pct' ~ '^\\d{1,3}$'
            AND (e.properties->>'max_scroll_pct')::numeric <= 100
            THEN (e.properties->>'max_scroll_pct')::double precision END AS max_scroll_pct,
          CASE WHEN e.properties->>'interaction_count' ~ '^\\d{1,10}$'
            AND (e.properties->>'interaction_count')::numeric <= 2147483647
            THEN (e.properties->>'interaction_count')::int END AS interaction_count,
          CASE WHEN e.properties->>'reason' IN (
            'heartbeat', 'visibility_hidden', 'blur', 'route_change',
            'pagehide', 'freeze', 'duration_rollover', 'destroy'
          ) THEN e.properties->>'reason' END AS reason,
          row_number() OVER (
            PARTITION BY
              e.project_id,
              e.env,
              poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id),
              e.session_id,
              e.properties->>'$page_view_id'
            ORDER BY
              CASE WHEN e.properties->>'sequence' ~ '^\\d{1,10}$'
                AND (e.properties->>'sequence')::numeric <= 2147483647
                THEN (e.properties->>'sequence')::int ELSE -1 END DESC,
              e."timestamp" DESC
          ) AS rank
        FROM events e
        WHERE e.project_id = $1
          AND e.env = $2
          AND e.event = 'page.engagement'
          AND e."timestamp" >= $4
          AND e."timestamp" < $5
          AND e.session_id IS NOT NULL
          AND e.session_id <> ''
          AND e.properties->>'$browser_context' = '1'
          AND e.properties->>'$page_view_id' IS NOT NULL
      ),
      latest_engagement AS (
        SELECT * FROM ranked_engagement WHERE rank = 1
      ),
      pages AS (
        SELECT
          p.project_id,
          p.env,
          p.page_view_id,
          p.session_id,
          p.actor_id,
          p.route,
          p.viewed_at,
          l.last_snapshot_at,
          l.sequence,
          l.foreground_ms,
          l.elapsed_ms,
          l.max_scroll_pct,
          l.interaction_count,
          l.reason,
          (
            l.sequence IS NOT NULL
            AND l.foreground_ms IS NOT NULL
            AND l.elapsed_ms IS NOT NULL
            AND l.foreground_ms <= l.elapsed_ms
          ) AS timed,
          (
            l.sequence IS NOT NULL
            AND l.foreground_ms IS NOT NULL
            AND l.elapsed_ms IS NOT NULL
            AND l.foreground_ms <= l.elapsed_ms
            AND l.reason IN (
              'visibility_hidden', 'blur', 'route_change',
              'pagehide', 'freeze', 'duration_rollover', 'destroy'
            )
          ) AS complete,
          CASE
            WHEN l.sequence IS NOT NULL
              AND l.elapsed_ms IS NOT NULL
              AND l.elapsed_ms >= 0
            THEN p.viewed_at + l.elapsed_ms * interval '1 millisecond'
            ELSE COALESCE(l.last_snapshot_at, p.viewed_at)
          END AS evidence_ended_at
        FROM page_views p
        LEFT JOIN latest_engagement l
          ON l.project_id = p.project_id
          AND l.env = p.env
          AND l.actor_id = p.actor_id
          AND l.session_id = p.session_id
          AND l.page_view_id = p.page_view_id
      ),
      ${keySessions},
      session_rows AS (
        SELECT
          p.project_id,
          p.env,
          p.session_id,
          p.actor_id,
          min(p.viewed_at) AS started_at,
          max(p.evidence_ended_at) AS ended_at,
          count(*)::int AS page_views,
          count(*) FILTER (WHERE p.timed)::int AS timed_page_views,
          COALESCE(sum(p.foreground_ms), 0)::bigint AS foreground_ms,
          floor(extract(epoch FROM (
            max(p.evidence_ended_at) - min(p.viewed_at)
          )) * 1000)::bigint AS session_span_ms,
          (count(*) FILTER (WHERE p.complete) = count(*)) AS complete,
          CASE
            WHEN (
              COALESCE(sum(p.foreground_ms), 0) >= 10000
              OR count(*) >= 2
              OR bool_or(k.session_id IS NOT NULL)
            ) THEN true
            WHEN count(*) FILTER (WHERE p.complete) = count(*) THEN false
            ELSE NULL
          END AS engaged,
          CASE
            WHEN count(*) FILTER (WHERE p.complete) = count(*)
            THEN NOT (
              COALESCE(sum(p.foreground_ms), 0) >= 10000
              OR count(*) >= 2
              OR bool_or(k.session_id IS NOT NULL)
            )
            ELSE NULL
          END AS bounce,
          (count(*) = 1) AS single_page
        FROM pages p
        LEFT JOIN key_sessions k
          ON k.project_id = p.project_id
          AND k.env = p.env
          AND k.actor_id = p.actor_id
          AND k.session_id = p.session_id
        GROUP BY p.project_id, p.env, p.actor_id, p.session_id
      )`;
  }

  private webPageEngagement(row: Record<string, unknown>): WebPageEngagement {
    return {
      page_view_id: String(row.page_view_id),
      session_id: String(row.session_id),
      actor_id: String(row.actor_id),
      route: String(row.route),
      viewed_at: toIso(row.viewed_at as string | Date),
      last_snapshot_at: row.last_snapshot_at
        ? toIso(row.last_snapshot_at as string | Date)
        : null,
      sequence: nullableNumber(row.sequence),
      foreground_ms: nullableNumber(row.foreground_ms),
      elapsed_ms: nullableNumber(row.elapsed_ms),
      max_scroll_pct: nullableNumber(row.max_scroll_pct),
      interaction_count: nullableNumber(row.interaction_count),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      timed: Boolean(row.timed),
      complete: Boolean(row.complete),
    };
  }

  private webSessionSummary(row: Record<string, unknown>): WebSessionSummary {
    return {
      session_id: String(row.session_id),
      actor_id: String(row.actor_id),
      started_at: toIso(row.started_at as string | Date),
      ended_at: toIso(row.ended_at as string | Date),
      page_views: Number(row.page_views),
      timed_page_views: Number(row.timed_page_views),
      foreground_ms: Number(row.foreground_ms),
      session_span_ms: Number(row.session_span_ms),
      engaged: row.engaged === null || row.engaged === undefined ? null : Boolean(row.engaged),
      bounce: row.bounce === null || row.bounce === undefined ? null : Boolean(row.bounce),
      single_page: Boolean(row.single_page),
      complete: Boolean(row.complete),
    };
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

  async experienceSession(q: ExperienceSessionQuery): Promise<ExperienceSessionResult> {
    const params: unknown[] = [
      q.projectId, q.env, q.sessionId, q.surface, q.from, q.to,
    ];
    const actorFilter = q.actorId
      ? ` AND poolstatis_resolve_actor(project_id, env, distinct_id)
          = poolstatis_resolve_actor($1::uuid, $2, $${params.push(q.actorId)})`
      : '';
    const where = `project_id = $1 AND env = $2 AND session_id = $3
      AND event_source = 'experience'
      AND event IN ('experience.page_viewed', 'experience.element_clicked', 'experience.scroll_depth', 'experience.client_error')
      AND properties->>'surface' = $4
      AND "timestamp" >= $5 AND "timestamp" < $6${actorFilter}`;
    const eventParams = [...params, q.limit];
    const [actors, events] = await Promise.all([
      this.pool.query<{ actor_id: string }>(
        `SELECT DISTINCT poolstatis_resolve_actor(project_id, env, distinct_id) AS actor_id
         FROM events WHERE ${where}
         ORDER BY actor_id
         LIMIT 2`,
        params,
      ),
      this.pool.query<{
        event: string;
        timestamp: Date;
        properties: Record<string, unknown>;
      }>(
        `SELECT event, "timestamp", properties
         FROM events
         WHERE ${where}
         ORDER BY "timestamp", (properties->>'sequence')::int,
                  poolstatis_resolve_actor(project_id, env, distinct_id)
         LIMIT $${eventParams.length}`,
        eventParams,
      ),
    ]);
    return {
      actorIds: actors.rows.map((row) => row.actor_id),
      events: events.rows.map((row) => toExperienceSessionEvent(row)),
    };
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

  async actors(q: ActorsQuery): Promise<ActorsResult> {
    const params: unknown[] = [q.projectId, q.env, q.from, q.to];
    const windowWhere = [
      'e.project_id = $1',
      'e.env = $2',
      'e."timestamp" >= $3',
      'e."timestamp" < $4',
    ];
    let populationSql = 'SELECT DISTINCT actor_id FROM window_events';
    if (q.activity) {
      params.push(q.activity.event);
      const activityWhere = [
        `w.event = $${params.length}`,
        ...compileFilters(q.activity.filters, 'w.properties', params),
      ].join(' AND ');
      populationSql = `SELECT DISTINCT w.actor_id
        FROM window_events w WHERE ${activityWhere}`;
    }
    if (q.searchExactId) {
      params.push(q.searchExactId);
      populationSql = `SELECT actor_id FROM (${populationSql}) exact_population
        WHERE actor_id = poolstatis_resolve_actor($1::uuid, $2, $${params.length})`;
    }
    const restrictPopulation = Boolean(q.activity || q.searchExactId);
    const selectedEventsSql = restrictPopulation
      ? `SELECT e.*, selected_raw.actor_id
         FROM selected_raw
         JOIN events e ON e.distinct_id = selected_raw.raw_id
         WHERE ${windowWhere.join(' AND ')}`
      : 'SELECT * FROM window_events';
    const selectedRawSql = restrictPopulation
      ? `SELECT actor_map.raw_id, actor_map.actor_id
         FROM actor_map
         JOIN population ON population.actor_id = actor_map.actor_id`
      : 'SELECT raw_id, actor_id FROM actor_map';

    const browserCondition = q.trustedBrowserSessions
      ? `(w.registered = true
          AND w.event_source = 'ingest'
          AND w.event = 'page.viewed'
          AND w.properties->>'$browser_context' = '1')`
      : 'false';
    const sortColumn = q.order === 'first_seen_desc'
      ? 'first_seen'
      : q.order === 'events_desc'
        ? 'total_events'
        : 'last_seen';
    let keysetSql = '';
    if (q.cursor) {
      params.push(q.cursor.value, q.cursor.distinctId);
      const valueParam = `$${params.length - 1}`;
      const idParam = `$${params.length}`;
      const cast = q.order === 'events_desc' ? '::int' : '::timestamptz';
      keysetSql = `WHERE (
        aggregates.${sortColumn} < ${valueParam}${cast}
        OR (
          aggregates.${sortColumn} = ${valueParam}${cast}
          AND aggregates.distinct_id > ${idParam}
        )
      )`;
    }
    params.push(q.limit + 1);
    const { rows } = await this.pool.query<{
      distinct_id: string;
      raw_actor_count: number;
      first_seen: Date;
      last_seen: Date;
      total_events: number;
      distinct_events: number;
      active_days: number;
      registered_share: number;
      session_count: number | null;
      top_events: Array<{ event: string; count: number }>;
      identity_status: ActorListItem['identity_status'];
    }>(
      `WITH RECURSIVE raw_actors AS MATERIALIZED (
         SELECT DISTINCT e.distinct_id
         FROM events e
         WHERE ${windowWhere.join(' AND ')}
       ), actor_chain(raw_id, current_id, path, depth, cycle, linked) AS (
         SELECT distinct_id, distinct_id, ARRAY[distinct_id]::text[], 0, false, false
         FROM raw_actors
         UNION ALL
         SELECT chain.raw_id, links.target_distinct_id,
                chain.path || links.target_distinct_id,
                chain.depth + 1,
                links.target_distinct_id = ANY(chain.path),
                true
         FROM actor_chain chain
         JOIN actor_links links
           ON links.project_id = $1 AND links.env = $2
          AND links.status = 'active'
          AND links.source_distinct_id = chain.current_id
         WHERE NOT chain.cycle
       ), actor_map AS MATERIALIZED (
         SELECT DISTINCT ON (raw_id)
                raw_id, current_id AS actor_id
         FROM actor_chain
         WHERE NOT cycle
         ORDER BY raw_id, depth DESC, current_id
       ), window_events AS MATERIALIZED (
         SELECT e.*, actor_map.actor_id
         FROM events e
         JOIN actor_map ON actor_map.raw_id = e.distinct_id
         WHERE ${windowWhere.join(' AND ')}
       ), population AS (
         ${populationSql}
       ), selected_raw AS MATERIALIZED (
         ${selectedRawSql}
       ), selected_events AS MATERIALIZED (
         ${selectedEventsSql}
       ), identity_flags AS (
         SELECT selected_raw.actor_id,
                COALESCE(bool_or(actor_chain.cycle), false) AS ambiguous,
                COALESCE(bool_or(actor_chain.linked), false) AS linked
         FROM selected_raw
         JOIN actor_chain ON actor_chain.raw_id = selected_raw.raw_id
         GROUP BY selected_raw.actor_id
       ), aggregates AS (
         SELECT w.actor_id AS distinct_id,
                count(DISTINCT w.distinct_id)::int AS raw_actor_count,
                min(w."timestamp") AS first_seen,
                max(w."timestamp") AS last_seen,
                count(*)::int AS total_events,
                count(DISTINCT w.event)::int AS distinct_events,
                count(DISTINCT date_trunc('day', w."timestamp"))::int AS active_days,
                COALESCE(avg(w.registered::int), 0)::float AS registered_share,
                CASE
                  WHEN count(*) FILTER (WHERE ${browserCondition}) > 0
                    AND count(*) FILTER (
                      WHERE ${browserCondition}
                        AND (w.session_id IS NULL OR w.session_id = '')
                    ) = 0
                  THEN count(DISTINCT w.session_id) FILTER (WHERE ${browserCondition})::int
                  ELSE NULL
                END AS session_count
         FROM selected_events w
         GROUP BY w.actor_id
       ), event_counts AS (
         SELECT w.actor_id, w.event, count(*)::int AS count
         FROM selected_events w
         WHERE w.registered = true
         GROUP BY w.actor_id, w.event
       ), ranked_events AS (
         SELECT actor_id, event, count,
                row_number() OVER (
                  PARTITION BY actor_id ORDER BY count DESC, event
                ) AS rank
         FROM event_counts
       ), top_events AS (
         SELECT actor_id,
                jsonb_agg(jsonb_build_object('event', event, 'count', count)
                  ORDER BY count DESC, event) AS events
         FROM ranked_events
         WHERE rank <= 8
         GROUP BY actor_id
       ), top_events_map AS (
         SELECT COALESCE(
           jsonb_object_agg(actor_id, events),
           '{}'::jsonb
         ) AS actors
         FROM top_events
       )
       SELECT aggregates.*,
              COALESCE(
                top_events_map.actors -> aggregates.distinct_id,
                '[]'::jsonb
              ) AS top_events,
              CASE
                WHEN identity_flags.ambiguous THEN 'ambiguous'
                WHEN aggregates.raw_actor_count > 1 OR identity_flags.linked THEN 'linked'
                ELSE 'unknown'
              END AS identity_status
       FROM aggregates
       JOIN identity_flags ON identity_flags.actor_id = aggregates.distinct_id
       CROSS JOIN top_events_map
       ${keysetSql}
       ORDER BY aggregates.${sortColumn} DESC, aggregates.distinct_id
       LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > q.limit;
    return {
      actors: rows.slice(0, q.limit).map((row): ActorListRecord => ({
        distinct_id: row.distinct_id,
        raw_actor_count: Number(row.raw_actor_count),
        first_seen: toIso(row.first_seen),
        last_seen: toIso(row.last_seen),
        total_events: Number(row.total_events),
        distinct_events: Number(row.distinct_events),
        active_days: Number(row.active_days),
        registered_share: Number(row.registered_share),
        session_count: row.session_count === null ? null : Number(row.session_count),
        top_events: row.top_events.map((entry) => ({
          event: entry.event,
          count: Number(entry.count),
        })),
        pinned_properties: {},
        identity_status: row.identity_status,
      })),
      hasMore,
    };
  }

  async actorActivity(q: ActorActivityQuery): Promise<ActorActivityResult> {
    const params: unknown[] = [q.projectId, q.env, q.distinctId, q.from, q.to];
    let cursorSql = '';
    if (q.cursor) {
      params.push(
        q.cursor.timestamp,
        q.cursor.ingestedAt,
        q.cursor.event,
        q.cursor.rawDistinctId,
        q.cursor.sessionId,
        q.cursor.propertiesHash,
        q.cursor.duplicateOrdinal,
      );
      const first = params.length - 6;
      cursorSql = `WHERE (
        "timestamp", ingested_at, event, raw_distinct_id,
        session_key, properties_hash, duplicate_ordinal
      ) < (
        $${first}::timestamptz, $${first + 1}::timestamptz, $${first + 2},
        $${first + 3}, $${first + 4}, $${first + 5}, $${first + 6}::int
      )`;
    }
    params.push(q.limit + 1);
    const { rows } = await this.pool.query<{
      event: string;
      timestamp: Date;
      ingested_at: Date;
      distinct_id: string;
      raw_distinct_id: string;
      session_id: string | null;
      session_key: string;
      properties_hash: string;
      duplicate_ordinal: number;
      env: string;
    }>(
      `WITH base AS (
         SELECT e.event, e."timestamp", e.ingested_at,
                poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id) AS distinct_id,
                e.distinct_id AS raw_distinct_id,
                e.session_id,
                COALESCE(e.session_id, '') AS session_key,
                md5(e.properties::text) AS properties_hash,
                e.env
         FROM events e
         WHERE e.project_id = $1 AND e.env = $2
           AND poolstatis_resolve_actor(e.project_id, e.env, e.distinct_id)
             = poolstatis_resolve_actor($1::uuid, $2, $3)
           AND e."timestamp" >= $4 AND e."timestamp" < $5
           AND e.registered = true
       ), numbered AS (
         SELECT base.*,
                row_number() OVER (
                  PARTITION BY "timestamp", ingested_at, event, raw_distinct_id,
                               session_key, properties_hash
                  ORDER BY raw_distinct_id
                )::int AS duplicate_ordinal
         FROM base
       )
       SELECT * FROM numbered
       ${cursorSql}
       ORDER BY "timestamp" DESC, ingested_at DESC, event DESC,
                raw_distinct_id DESC, session_key DESC, properties_hash DESC,
                duplicate_ordinal DESC
       LIMIT $${params.length}`,
      params,
    );
    const visible = rows.slice(0, q.limit);
    const last = visible.at(-1);
    return {
      events: visible.map((row) => ({
        event: row.event,
        timestamp: toIso(row.timestamp),
        distinct_id: row.distinct_id,
        raw_distinct_id: row.raw_distinct_id,
        session_id: row.session_id,
        properties: {},
        registered: true,
        env: row.env,
      })),
      hasMore: rows.length > q.limit,
      ...(last ? {
        lastKey: {
          timestamp: toIso(last.timestamp),
          ingestedAt: toIso(last.ingested_at),
          event: last.event,
          rawDistinctId: last.raw_distinct_id,
          sessionId: last.session_key,
          propertiesHash: last.properties_hash,
          duplicateOrdinal: Number(last.duplicate_ordinal),
        },
      } : {}),
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

function isPartitionOverlapError(err: unknown): boolean {
  // 42P17 invalid_object_definition: thrown when the DEFAULT partition already
  // holds rows that would belong to the new partition.
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P17';
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
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
