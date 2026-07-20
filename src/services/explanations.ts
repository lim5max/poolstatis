import { createHash } from 'node:crypto';
import type pg from 'pg';
import { getDecision } from './decisions.js';
import type { QueryService } from './query.js';

export interface ExplanationCandidate {
  kind: 'metric' | 'property';
  key: string;
  purpose: string;
  measured_movement: number | null;
  score: number;
  strength: 'strong' | 'medium' | 'weak';
  why_considered: string;
  supporting_query: { baseline: Record<string, unknown>; observed: Record<string, unknown> };
  interpretation: 'hypothesis';
}

export interface DecisionExplanation {
  id: string;
  decision_id: string;
  evidence_id: string;
  algorithm_version: 'v1';
  explanation_key: string;
  label: 'hypothesis';
  candidates: ExplanationCandidate[];
  omitted: Array<{ key: string; reason: string }>;
  created_by: string;
  created_at: string;
}

const ALGORITHM_VERSION = 'v1' as const;

export async function explainDecision(
  pool: pg.Pool,
  query: QueryService,
  projectId: string,
  decisionId: string,
  actor: string,
): Promise<{ explanation: DecisionExplanation; idempotent: boolean }> {
  const detail = await getDecision(pool, projectId, decisionId);
  const explanationKey = createHash('sha256').update(JSON.stringify({
    evidence_id: detail.evidence.id,
    algorithm_version: ALGORITHM_VERSION,
    contract_revision: detail.release.contract_revision,
  })).digest('hex');
  const existing = await pool.query<Record<string, any>>(
    `SELECT id, decision_id, evidence_id, algorithm_version, explanation_key,
            label, candidates, omitted, created_by, created_at
     FROM decision_explanations
     WHERE project_id = $1 AND decision_id = $2 AND explanation_key = $3`,
    [projectId, decisionId, explanationKey],
  );
  if (existing.rows[0]) return { explanation: rowToExplanation(existing.rows[0]), idempotent: true };

  const metricRows = await pool.query<{
    key: string; purpose: string; category: string | null; tags: string[];
  }>(
    `SELECT key, purpose, category, tags
     FROM metrics
     WHERE project_id = $1 AND status = 'active'
       AND type IN ('count', 'unique_actors', 'value')
       AND key <> $2
     ORDER BY key`,
    [projectId, detail.evidence.primary_evidence.metric.key],
  );
  const primaryRegistry = await pool.query<{ category: string | null; tags: string[] }>(
    'SELECT category, tags FROM metrics WHERE project_id = $1 AND key = $2',
    [projectId, detail.evidence.primary_evidence.metric.key],
  );
  const primaryCategory = primaryRegistry.rows[0]?.category ?? null;
  const primaryTags = new Set(primaryRegistry.rows[0]?.tags ?? []);
  const baselineFrom = new Date(detail.evidence.baseline_window.from);
  const baselineTo = new Date(detail.evidence.baseline_window.to);
  const observedFrom = new Date(detail.evidence.observed_window.from);
  const observedTo = new Date(detail.evidence.observed_window.to);
  const primaryMovement = detail.evidence.primary_evidence.change.relative;
  const filters = detail.contract.target_filters;
  const candidates: ExplanationCandidate[] = [];
  const omitted: Array<{ key: string; reason: string }> = [];

  for (const metric of metricRows.rows) {
    try {
      const [baseline, observed] = await Promise.all([
        query.aggregateMetricWindow(projectId, {
          metricKey: metric.key, env: detail.release.env, filters, properties: [],
          from: baselineFrom, to: baselineTo, windowName: 'baseline',
        }),
        query.aggregateMetricWindow(projectId, {
          metricKey: metric.key, env: detail.release.env, filters, properties: [],
          from: observedFrom, to: observedTo, windowName: 'observed',
        }),
      ]);
      if (baseline.result.events + observed.result.events < 2 || baseline.result.value === 0) {
        omitted.push({ key: metric.key, reason: 'insufficient_registered_evidence' });
        continue;
      }
      const movement = Number(((observed.result.value - baseline.result.value) / Math.abs(baseline.result.value)).toFixed(6));
      const sharedTags = metric.tags.filter((tag) => primaryTags.has(tag));
      const movementSimilarity = primaryMovement === null
        ? 0
        : Math.max(0, 1 - Math.min(1, Math.abs(movement - primaryMovement)));
      const score = clampScore(
        movementSimilarity * 0.5
        + (metric.category !== null && metric.category === primaryCategory ? 0.2 : 0)
        + (sharedTags.length > 0 ? 0.2 : 0)
        + (Math.min(baseline.result.actors, observed.result.actors) >= 2 ? 0.1 : 0),
      );
      candidates.push({
        kind: 'metric', key: metric.key, purpose: metric.purpose,
        measured_movement: movement, score, strength: strength(score),
        why_considered: whyMetric(metric.category, primaryCategory, sharedTags, movementSimilarity),
        supporting_query: {
          baseline: baseline.query,
          observed: observed.query,
        },
        interpretation: 'hypothesis',
      });
    } catch {
      omitted.push({ key: metric.key, reason: 'candidate_query_unavailable' });
    }
  }

  if (detail.evidence.source === 'native') {
    const targetProperties = new Set(filters.map((filter) => filter.property));
    const trusted = await pool.query<{ key: string; purpose: string }>(
      `SELECT key, purpose FROM property_definitions
       WHERE project_id = $1 AND scope = 'event' AND status = 'trusted'
       ORDER BY key LIMIT 25`,
      [projectId],
    );
    if (trusted.rows.length > 0) {
      const keys = trusted.rows.map((property) => property.key);
      const [baselineProperties, observedProperties] = await Promise.all([
        query.aggregateMetricWindow(projectId, {
          metricKey: detail.evidence.primary_evidence.metric.key,
          env: detail.release.env, filters, properties: keys,
          from: baselineFrom, to: baselineTo, windowName: 'baseline',
        }),
        query.aggregateMetricWindow(projectId, {
          metricKey: detail.evidence.primary_evidence.metric.key,
          env: detail.release.env, filters, properties: keys,
          from: observedFrom, to: observedTo, windowName: 'observed',
        }),
      ]);
      for (const property of trusted.rows) {
        const baselineCoverage = baselineProperties.result.propertyCoverage[property.key] ?? 0;
        const observedCoverage = observedProperties.result.propertyCoverage[property.key] ?? 0;
        if (Math.max(baselineCoverage, observedCoverage) < 0.1) {
          omitted.push({ key: property.key, reason: 'insufficient_property_coverage' });
          continue;
        }
        const movement = Number((observedCoverage - baselineCoverage).toFixed(6));
        const isTarget = targetProperties.has(property.key);
        const score = clampScore(0.25 + (isTarget ? 0.2 : 0) + Math.min(0.3, Math.abs(movement)));
        const baseQuery = {
          kind: 'trend', metric: detail.evidence.primary_evidence.metric.key,
          interval: 'day', breakdown: { property: property.key },
          filters, env: detail.release.env,
        };
        candidates.push({
          kind: 'property', key: property.key, purpose: property.purpose,
          measured_movement: movement, score, strength: strength(score),
          why_considered: isTarget
            ? 'This trusted registered property defines the release target segment; compare its bounded breakdown before treating the association as meaningful.'
            : 'This trusted registered property has enough primary-metric coverage for a bounded segment hypothesis; it is not causal evidence.',
          supporting_query: {
            baseline: { ...baseQuery, date_from: baselineFrom.toISOString(), date_to: baselineTo.toISOString() },
            observed: { ...baseQuery, date_from: observedFrom.toISOString(), date_to: observedTo.toISOString() },
          },
          interpretation: 'hypothesis',
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  omitted.sort((a, b) => a.key.localeCompare(b.key));
  const inserted = await pool.query<Record<string, any>>(
    `INSERT INTO decision_explanations (
       project_id, decision_id, evidence_id, algorithm_version,
       explanation_key, candidates, omitted, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, decision_id, explanation_key) DO UPDATE SET
       explanation_key = EXCLUDED.explanation_key
     RETURNING id, decision_id, evidence_id, algorithm_version, explanation_key,
               label, candidates, omitted, created_by, created_at`,
    [
      projectId, decisionId, detail.evidence.id, ALGORITHM_VERSION, explanationKey,
      JSON.stringify(candidates), JSON.stringify(omitted), actor,
    ],
  );
  return { explanation: rowToExplanation(inserted.rows[0]!), idempotent: false };
}

export async function listDecisionExplanations(
  pool: pg.Pool,
  projectId: string,
  decisionId: string,
): Promise<DecisionExplanation[]> {
  await getDecision(pool, projectId, decisionId);
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT id, decision_id, evidence_id, algorithm_version, explanation_key,
            label, candidates, omitted, created_by, created_at
     FROM decision_explanations
     WHERE project_id = $1 AND decision_id = $2
     ORDER BY created_at, id`,
    [projectId, decisionId],
  );
  return rows.map(rowToExplanation);
}

function rowToExplanation(row: Record<string, any>): DecisionExplanation {
  return {
    id: row.id, decision_id: row.decision_id, evidence_id: row.evidence_id,
    algorithm_version: row.algorithm_version, explanation_key: row.explanation_key,
    label: row.label, candidates: row.candidates, omitted: row.omitted,
    created_by: row.created_by,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function clampScore(score: number): number { return Number(Math.max(0, Math.min(1, score)).toFixed(4)); }
function strength(score: number): ExplanationCandidate['strength'] { return score >= 0.75 ? 'strong' : score >= 0.5 ? 'medium' : 'weak'; }
function whyMetric(category: string | null, primaryCategory: string | null, tags: string[], similarity: number): string {
  const reasons = [
    category && category === primaryCategory ? `shared ${category} category` : null,
    tags.length ? `shared tags: ${tags.join(', ')}` : null,
    `movement similarity ${Math.round(similarity * 100)}%`,
  ].filter(Boolean);
  return `This registered metric is a correlation candidate based on ${reasons.join('; ')}; it is not causal evidence.`;
}
