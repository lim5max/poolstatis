import type pg from 'pg';
import { badRequest, notFound } from '../errors.js';
import type { EventStore } from '../stores/eventStore.js';
import { analysisViewMetricKeys, listAnalysisViews } from './analysisViews.js';
import { listFunnels, listMetrics, type Metric } from './registry.js';
import type { WarningKind } from './warnings.js';

type Interval = 'hour' | 'day';

export interface DataHealthWatermark {
  count: number;
  last_seen: string;
}

export interface DataHealthIssueNovelty {
  state: 'new' | 'recurring' | 'historical';
  basis: 'privacy-safe warning occurrences';
  current_window: { from: string; to: string; count: number };
  comparison_baseline: { from: string; to: string; count: number };
}

export interface DataHealthIssueSignature {
  signature_id: string;
  kind: WarningKind;
  category: 'schema_rejection' | 'missing_definition' | 'clock_skew';
  remediation: 'fix_schema' | 'register_definition' | 'fix_clock';
  registered_event_name: string | null;
  count: number;
  first_seen: string;
  last_seen: string;
  novelty: DataHealthIssueNovelty;
  affected_answer_ids: string[];
  repair_action: { kind: 'navigate'; label: string; href: string };
  watermark: DataHealthWatermark;
  verify_after_fix: {
    method: 'POST';
    href: string;
    body: { env: string; signature_id: string; watermark: DataHealthWatermark };
  };
}

interface ProjectScope { id: string; slug: string }

interface WarningRow {
  signature_id: string;
  kind: WarningKind;
  event: string;
  count: string;
  first_seen: Date;
  last_seen: Date;
}

interface RejectedPointRow { bucket: Date; rejected: string }
interface WarningNoveltyRow { signature_id: string; current_count: string; baseline_count: string }

const KIND_PRESENTATION: Record<WarningKind, {
  category: DataHealthIssueSignature['category'];
  remediation: DataHealthIssueSignature['remediation'];
  title: string;
}> = {
  rejected: { category: 'schema_rejection', remediation: 'fix_schema', title: 'Rejected observations need repair' },
  unregistered: { category: 'missing_definition', remediation: 'register_definition', title: 'Observed events need definitions' },
  clock_skew: { category: 'clock_skew', remediation: 'fix_clock', title: 'Event clocks need correction' },
};

export async function getProjectDataHealth(
  pool: pg.Pool,
  eventStore: EventStore,
  project: ProjectScope,
  env: string,
  now = new Date(),
) {
  const last24 = bucketWindow(now, 'hour', 24);
  const last7 = bucketWindow(now, 'day', 7);
  const previous24 = { from: new Date(last24.from.getTime() - 24 * 60 * 60 * 1000), to: last24.from };
  const [accepted24, accepted7, rejected24, rejected7, warningResult, metrics, funnels, views, coverage] = await Promise.all([
    eventStore.acceptedIngestTrend({ projectId: project.id, env, ...last24, interval: 'hour' }),
    eventStore.acceptedIngestTrend({ projectId: project.id, env, ...last7, interval: 'day' }),
    rejectedTrend(pool, project.id, env, last24.from, last24.to, 'hour'),
    rejectedTrend(pool, project.id, env, last7.from, last7.to, 'day'),
    pool.query<WarningRow>(
      `SELECT signature_id, kind, event, count::text, first_seen, last_seen
       FROM ingest_warnings
       WHERE project_id = $1 AND env = $2
       ORDER BY last_seen DESC, signature_id
       LIMIT 20`,
      [project.id, env],
    ),
    listMetrics(pool, project.id, { status: 'active' }),
    listFunnels(pool, project.id),
    listAnalysisViews(pool, project, { env, status: 'active' }),
    pool.query<{ applied_at: Date | null }>(
      `SELECT min(occurrence.bucket) AS applied_at
       FROM ingest_warning_occurrences occurrence
       JOIN ingest_warnings warning ON warning.signature_id = occurrence.signature_id
       WHERE warning.project_id = $1 AND warning.env = $2`,
      [project.id, env],
    ),
  ]);
  const noveltyBySignature = await warningNovelty(
    pool,
    project.id,
    env,
    warningResult.rows.map((warning) => warning.signature_id),
    previous24,
    last24,
  );

  const metricEvents = activeMetricEvents(metrics);
  const metricKeysByEvent = invertMetricEvents(metricEvents);
  const viewMetrics = views.map((view) => ({ id: view.id, keys: new Set(analysisViewMetricKeys(view)) }));
  const issueSignatures = warningResult.rows.map((warning) => {
    const metricKeys = metricKeysByEvent.get(warning.event) ?? new Set<string>();
    const registeredEventName = metricKeys.size > 0 ? warning.event : null;
    const affected = new Set<string>(['home']);
    for (const key of metricKeys) affected.add(`product:${key}`);
    for (const funnel of funnels) {
      if (funnel.steps.some((step) => metricKeys.has(step.metric_key))) affected.add(`funnel:${funnel.key}`);
    }
    for (const view of viewMetrics) {
      if ([...view.keys].some((key) => metricKeys.has(key))) affected.add(view.id);
    }
    const watermark = {
      count: Number(warning.count),
      last_seen: warning.last_seen.toISOString(),
    };
    const repairAction = registeredEventName
      ? {
          kind: 'navigate' as const,
          label: 'Inspect registered event',
          href: `/data?tab=events&event=${encodeURIComponent(registeredEventName)}`,
        }
      : {
          kind: 'navigate' as const,
          label: 'Open bounded warning',
          href: `/data?signature=${encodeURIComponent(warning.signature_id)}`,
        };
    const presentation = KIND_PRESENTATION[warning.kind];
    const windowCounts = noveltyBySignature.get(warning.signature_id) ?? { current: 0, baseline: 0 };
    const novelty: DataHealthIssueNovelty = {
      state: windowCounts.current > 0
        ? windowCounts.baseline === 0 ? 'new' : 'recurring'
        : 'historical',
      basis: 'privacy-safe warning occurrences',
      current_window: {
        from: last24.from.toISOString(),
        to: last24.to.toISOString(),
        count: windowCounts.current,
      },
      comparison_baseline: {
        from: previous24.from.toISOString(),
        to: previous24.to.toISOString(),
        count: windowCounts.baseline,
      },
    };
    return {
      signature_id: warning.signature_id,
      kind: warning.kind,
      category: presentation.category,
      remediation: presentation.remediation,
      registered_event_name: registeredEventName,
      count: watermark.count,
      first_seen: warning.first_seen.toISOString(),
      last_seen: watermark.last_seen,
      novelty,
      affected_answer_ids: [...affected].sort(),
      repair_action: repairAction,
      watermark,
      verify_after_fix: {
        method: 'POST' as const,
        href: `/api/v1/projects/${project.slug}/data-health/verify`,
        body: { env, signature_id: warning.signature_id, watermark },
      },
    } satisfies DataHealthIssueSignature;
  });

  const window24 = mergeWindow(last24, 'hour', accepted24, rejected24);
  const window7 = mergeWindow(last7, 'day', accepted7, rejected7);
  const rejectedHistoryFirstObservedAt = coverage.rows[0]?.applied_at?.toISOString() ?? null;
  return {
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    project: project.slug,
    env,
    coverage: {
      accepted_basis: 'durable event rows by ingested_at',
      rejected_basis: 'privacy-safe warning occurrences recorded after data-health tracking began',
      issue_novelty_basis: 'current 24 hourly buckets compared with the immediately preceding 24 hourly buckets',
      rejected_history_first_observed_at: rejectedHistoryFirstObservedAt,
    },
    summary: {
      accepted_24h: window24.accepted_total,
      rejected_24h: window24.rejected_total,
      accepted_7d: window7.accepted_total,
      rejected_7d: window7.rejected_total,
    },
    windows: { last_24h: window24, last_7d: window7 },
    issue_signatures: issueSignatures,
    improvements: issueSignatures.map((issue) => ({
      signature_id: issue.signature_id,
      severity: issue.kind === 'rejected' ? 'high' as const : 'medium' as const,
      title: KIND_PRESENTATION[issue.kind].title,
      affected_answer_ids: issue.affected_answer_ids,
      repair_action: issue.repair_action,
      verify_after_fix: issue.verify_after_fix,
    })),
    doing_well: [
      ...(window24.accepted_total > 0 ? [{
        code: 'accepted_events_flowing' as const,
        title: 'Accepted events are flowing',
        evidence: `${window24.accepted_total} accepted observations in the latest 24 hourly buckets.`,
      }] : []),
    ],
  };
}

async function warningNovelty(
  pool: pg.Pool,
  projectId: string,
  env: string,
  signatureIds: string[],
  baseline: { from: Date; to: Date },
  current: { from: Date; to: Date },
): Promise<Map<string, { current: number; baseline: number }>> {
  if (signatureIds.length === 0) return new Map();
  const result = await pool.query<WarningNoveltyRow>(
    `SELECT warning.signature_id,
       COALESCE(sum(occurrence.count) FILTER (
         WHERE occurrence.bucket >= $4 AND occurrence.bucket <= $5
       ), 0)::text AS current_count,
       COALESCE(sum(occurrence.count) FILTER (
         WHERE occurrence.bucket >= $3 AND occurrence.bucket < $4
       ), 0)::text AS baseline_count
     FROM ingest_warnings warning
     LEFT JOIN ingest_warning_occurrences occurrence
       ON occurrence.signature_id = warning.signature_id
       AND occurrence.bucket >= $3 AND occurrence.bucket <= $5
     WHERE warning.project_id = $1 AND warning.env = $2
       AND warning.signature_id = ANY($6::uuid[])
     GROUP BY warning.signature_id`,
    [projectId, env, baseline.from, current.from, current.to, signatureIds],
  );
  return new Map(result.rows.map((row) => [
    row.signature_id,
    { current: Number(row.current_count), baseline: Number(row.baseline_count) },
  ] as const));
}

export async function verifyProjectDataHealthFix(
  pool: pg.Pool,
  projectId: string,
  env: string,
  signatureId: string,
  watermark: DataHealthWatermark,
  now = new Date(),
) {
  const result = await pool.query<{ count: string; last_seen: Date }>(
    `SELECT count::text, last_seen
     FROM ingest_warnings
     WHERE project_id = $1 AND env = $2 AND signature_id = $3`,
    [projectId, env, signatureId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('warning_signature');
  const current = { count: Number(row.count), last_seen: row.last_seen.toISOString() };
  const watermarkTime = new Date(watermark.last_seen).getTime();
  if (watermark.count > current.count || watermarkTime > row.last_seen.getTime()) {
    throw badRequest(
      'invalid_data_health_watermark',
      'the verification watermark is ahead of the current warning signature',
      'read data-health again and retry with the exact server-issued signature watermark',
    );
  }
  const occurrencesSince = Math.max(0, current.count - watermark.count);
  const recurred = occurrencesSince > 0 || row.last_seen.getTime() > watermarkTime;
  return {
    schema_version: 1 as const,
    signature_id: signatureId,
    status: recurred ? 'still_occurring' as const : 'resolved' as const,
    occurrences_since_watermark: occurrencesSince,
    checked_at: now.toISOString(),
    previous_watermark: watermark,
    current_watermark: current,
  };
}

function activeMetricEvents(metrics: Metric[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const metric of metrics) {
    if (metric.type === 'state') continue;
    const source = metric.source as Record<string, unknown>;
    const sources = metric.type === 'conversion'
      ? [source.from, source.to] as Array<Record<string, unknown>>
      : [source];
    for (const candidate of sources) {
      if (candidate.data_source === 'posthog' || typeof candidate.event !== 'string') continue;
      const keys = result.get(metric.key) ?? new Set<string>();
      keys.add(candidate.event);
      result.set(metric.key, keys);
    }
  }
  return result;
}

function invertMetricEvents(metricEvents: Map<string, Set<string>>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [metricKey, events] of metricEvents) {
    for (const event of events) {
      const keys = result.get(event) ?? new Set<string>();
      keys.add(metricKey);
      result.set(event, keys);
    }
  }
  return result;
}

function bucketWindow(now: Date, interval: Interval, count: number): { from: Date; to: Date } {
  const current = new Date(now);
  if (interval === 'hour') current.setUTCMinutes(0, 0, 0);
  else current.setUTCHours(0, 0, 0, 0);
  const from = new Date(current);
  if (interval === 'hour') from.setUTCHours(from.getUTCHours() - (count - 1));
  else from.setUTCDate(from.getUTCDate() - (count - 1));
  return { from, to: now };
}

async function rejectedTrend(
  pool: pg.Pool,
  projectId: string,
  env: string,
  from: Date,
  to: Date,
  interval: Interval,
) {
  const result = await pool.query<RejectedPointRow>(
    `SELECT date_trunc($5, occurrence.bucket) AS bucket, sum(occurrence.count)::text AS rejected
     FROM ingest_warning_occurrences occurrence
     JOIN ingest_warnings warning ON warning.signature_id = occurrence.signature_id
     WHERE warning.project_id = $1 AND warning.env = $2 AND warning.kind = 'rejected'
       AND occurrence.bucket >= $3 AND occurrence.bucket <= $4
     GROUP BY 1
     ORDER BY 1`,
    [projectId, env, from, to, interval],
  );
  return result.rows.map((row) => ({ bucket: row.bucket.toISOString(), rejected: Number(row.rejected) }));
}

function mergeWindow(
  range: { from: Date; to: Date },
  interval: Interval,
  accepted: Array<{ bucket: string; accepted: number }>,
  rejected: Array<{ bucket: string; rejected: number }>,
) {
  const acceptedMap = new Map(accepted.map((point) => [point.bucket, point.accepted]));
  const rejectedMap = new Map(rejected.map((point) => [point.bucket, point.rejected]));
  const points: Array<{ bucket: string; accepted: number; rejected: number }> = [];
  for (let bucket = new Date(range.from); bucket <= range.to; bucket = nextBucket(bucket, interval)) {
    const key = bucket.toISOString();
    points.push({ bucket: key, accepted: acceptedMap.get(key) ?? 0, rejected: rejectedMap.get(key) ?? 0 });
  }
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    interval,
    accepted_total: points.reduce((sum, point) => sum + point.accepted, 0),
    rejected_total: points.reduce((sum, point) => sum + point.rejected, 0),
    points,
  };
}

function nextBucket(value: Date, interval: Interval): Date {
  const next = new Date(value);
  if (interval === 'hour') next.setUTCHours(next.getUTCHours() + 1);
  else next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
