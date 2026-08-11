import type pg from 'pg';
import { ApiError } from '../errors.js';
import type { AuthContext } from '../http/auth.js';
import type { SemanticProjectComparisonInput } from '../schemas.js';
import type { QueryService } from './query.js';
import {
  metricSemanticDefinition,
  metricSemanticFingerprint,
  type SemanticMetricLike,
} from './metricSemantics.js';

type ComparisonState = 'ready' | 'unavailable';

export interface ProjectComparisonIncompatibility {
  project_slug: string;
  code:
    | 'project_not_found'
    | 'metric_missing'
    | 'metric_inactive'
    | 'unsupported_type'
    | 'purpose_mismatch'
    | 'type_mismatch'
    | 'aggregation_mismatch'
    | 'fingerprint_mismatch';
  message: string;
}

interface ComparisonMetricRow extends SemanticMetricLike {
  project_id: string;
  project_slug: string;
  project_name: string;
  status: 'proposed' | 'active' | 'deprecated';
}

export async function compareProjects(
  pool: pg.Pool,
  query: QueryService,
  auth: AuthContext,
  input: SemanticProjectComparisonInput,
): Promise<{
  schema_version: 1;
  state: ComparisonState;
  generated_at: string;
  metric: { key: string; purpose: string | null; type: string | null; aggregation: string | null; fingerprint: string | null };
  scope: { environment: string; window: { from: string; to: string; timezone: 'UTC' } };
  projects: Array<{
    slug: string;
    name: string;
    fingerprint: string | null;
    value?: number;
    events?: number;
    actors?: number;
    registered_coverage?: number;
  }>;
  incompatibilities: ProjectComparisonIncompatibility[];
  primary_action:
    | { id: 'open_comparison_evidence'; kind: 'navigate'; label: string; href: string }
    | { id: 'review_metric_definitions'; kind: 'navigate'; label: string; href: '/registry' };
}> {
  requireOrganizationComparisonAccess(auth);
  const projects = await pool.query<{
    id: string;
    slug: string;
    name: string;
  }>(
    `SELECT id, slug, name FROM projects
     WHERE org_id = $1 AND slug = ANY($2::text[])`,
    [auth.orgId, input.projects],
  );
  const bySlug = new Map(projects.rows.map((project) => [project.slug, project]));
  const projectIds = projects.rows.map((project) => project.id);
  const metrics = projectIds.length === 0
    ? { rows: [] as ComparisonMetricRow[] }
    : await pool.query<ComparisonMetricRow>(
        `SELECT m.id, m.project_id, p.slug AS project_slug, p.name AS project_name,
           m.key, m.purpose, m.type, m.source, m.status, m.owner
         FROM metrics m JOIN projects p ON p.id = m.project_id
         WHERE m.project_id = ANY($1::uuid[]) AND m.key = $2`,
        [projectIds, input.metric_key],
      );
  const metricBySlug = new Map(metrics.rows.map((metric) => [metric.project_slug, metric]));
  const baseline = metricBySlug.get(input.projects[0]!);
  const baselineDefinition = baseline ? metricSemanticDefinition(baseline) : null;
  const baselineFingerprint = baselineDefinition ? metricSemanticFingerprint(baselineDefinition) : null;
  const incompatibilities: ProjectComparisonIncompatibility[] = [];

  for (const slug of input.projects) {
    const project = bySlug.get(slug);
    if (!project) {
      incompatibilities.push({
        project_slug: slug,
        code: 'project_not_found',
        message: 'Project is not available in this organization scope.',
      });
      continue;
    }
    const metric = metricBySlug.get(slug);
    if (!metric) {
      incompatibilities.push({
        project_slug: slug,
        code: 'metric_missing',
        message: `Metric "${input.metric_key}" is not registered in this project.`,
      });
      continue;
    }
    if (metric.status !== 'active') {
      incompatibilities.push({
        project_slug: slug,
        code: 'metric_inactive',
        message: `Metric has status=${metric.status}; comparison requires active definitions.`,
      });
    }
    if (!['count', 'unique_actors', 'value'].includes(metric.type)) {
      incompatibilities.push({
        project_slug: slug,
        code: 'unsupported_type',
        message: `Metric type=${metric.type} cannot be compared with the bounded aggregate contract.`,
      });
    }
    if (!baselineDefinition) continue;
    const definition = metricSemanticDefinition(metric);
    const fingerprint = metricSemanticFingerprint(definition);
    if (definition.purpose !== baselineDefinition.purpose) {
      incompatibilities.push({
        project_slug: slug,
        code: 'purpose_mismatch',
        message: 'Metric purpose differs from the first selected project.',
      });
    }
    if (definition.type !== baselineDefinition.type) {
      incompatibilities.push({
        project_slug: slug,
        code: 'type_mismatch',
        message: 'Metric type differs from the first selected project.',
      });
    }
    if (definition.aggregation !== baselineDefinition.aggregation) {
      incompatibilities.push({
        project_slug: slug,
        code: 'aggregation_mismatch',
        message: 'Metric aggregation differs from the first selected project.',
      });
    }
    if (fingerprint !== baselineFingerprint) {
      incompatibilities.push({
        project_slug: slug,
        code: 'fingerprint_mismatch',
        message: 'The versioned semantic fingerprint differs from the first selected project.',
      });
    }
  }

  const scope = {
    environment: input.environment,
    window: { from: input.window.from, to: input.window.to, timezone: 'UTC' as const },
  };
  const baseProjects = input.projects.map((slug) => {
    const project = bySlug.get(slug);
    const metric = metricBySlug.get(slug);
    return {
      slug,
      name: project?.name ?? slug,
      fingerprint: metric ? metricSemanticFingerprint(metricSemanticDefinition(metric)) : null,
    };
  });
  const metricShape = {
    key: input.metric_key,
    purpose: baselineDefinition?.purpose ?? null,
    type: baselineDefinition?.type ?? null,
    aggregation: baselineDefinition?.aggregation ?? null,
    fingerprint: baselineFingerprint,
  };
  if (incompatibilities.length > 0 || !baselineDefinition || !baseline) {
    return {
      schema_version: 1,
      state: 'unavailable',
      generated_at: new Date().toISOString(),
      metric: metricShape,
      scope,
      projects: baseProjects,
      incompatibilities,
      primary_action: {
        id: 'review_metric_definitions',
        kind: 'navigate',
        label: 'Review metric definitions',
        href: '/registry',
      },
    };
  }

  const values = [];
  for (const slug of input.projects) {
    const project = bySlug.get(slug)!;
    const result = await query.aggregateMetricWindow(project.id, {
      metricKey: input.metric_key,
      env: input.environment,
      filters: [],
      properties: [],
      from: new Date(input.window.from),
      to: new Date(input.window.to),
      windowName: 'observed',
    });
    values.push({
      slug,
      name: project.name,
      fingerprint: baselineFingerprint,
      value: result.result.value,
      events: result.result.events,
      actors: result.result.actors,
      registered_coverage: result.result.registeredCoverage,
    });
  }
  return {
    schema_version: 1,
    state: 'ready',
    generated_at: new Date().toISOString(),
    metric: metricShape,
    scope,
    projects: values,
    incompatibilities: [],
    primary_action: {
      id: 'open_comparison_evidence',
      kind: 'navigate',
      label: 'Review comparison evidence',
      href: '/projects#comparison-evidence',
    },
  };
}

export function requireOrganizationComparisonAccess(auth: AuthContext): void {
  const roleAllowed = auth.userRole === undefined
    || auth.userRole === 'owner'
    || auth.userRole === 'admin';
  if (auth.kind === 'personal' && auth.projectId === null && roleAllowed) return;
  if (auth.kind === 'user' && auth.projectId === null && roleAllowed) return;
  if (auth.kind === 'secret') {
    throw new ApiError(
      403,
      'insufficient_scope',
      'cross-project comparison requires an organization-wide credential',
      'use a personal token or a hosted owner/admin session',
    );
  }
  throw new ApiError(
    403,
    'insufficient_role',
    'this hosted account role cannot compare organization projects',
    'ask an owner or admin to run the portfolio comparison',
  );
}
