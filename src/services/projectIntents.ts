import type pg from 'pg';
import type { ProjectIntentInput, ProjectGoalId, ProjectMode } from '../schemas.js';

export type SetupTaskPlanSource = 'deterministic' | 'llm' | 'fallback';

export interface StoredProjectIntent {
  schema_version: 1;
  project_mode: ProjectMode;
  website_domain: string | null;
  goal_ids: ProjectGoalId[];
  custom_goal: string | null;
  primary_goal_id: ProjectGoalId;
  generated_plan: Record<string, unknown> | null;
  generated_plan_source: SetupTaskPlanSource;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<pg.Pool, 'query'>;

function mapIntent(row: Record<string, unknown>): StoredProjectIntent {
  return {
    schema_version: 1,
    project_mode: row.project_mode as ProjectMode,
    website_domain: (row.website_domain as string | null) ?? null,
    goal_ids: row.goal_ids as ProjectGoalId[],
    custom_goal: (row.custom_goal as string | null) ?? null,
    primary_goal_id: row.primary_goal_id as ProjectGoalId,
    generated_plan: (row.generated_plan as Record<string, unknown> | null) ?? null,
    generated_plan_source: row.generated_plan_source as SetupTaskPlanSource,
    created_at: new Date(row.created_at as string | Date).toISOString(),
    updated_at: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export async function getProjectIntent(
  db: Queryable,
  projectId: string,
): Promise<StoredProjectIntent | null> {
  const { rows } = await db.query(
    `SELECT schema_version, project_mode, website_domain, goal_ids, custom_goal, primary_goal_id,
            generated_plan, generated_plan_source, created_at, updated_at
     FROM project_intents
     WHERE project_id = $1`,
    [projectId],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function upsertProjectIntent(
  db: Queryable,
  projectId: string,
  input: ProjectIntentInput,
): Promise<StoredProjectIntent> {
  const { rows } = await db.query(
    `INSERT INTO project_intents (
       project_id, project_mode, website_domain, goal_ids, custom_goal, primary_goal_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id) DO UPDATE SET
       project_mode = EXCLUDED.project_mode,
       website_domain = EXCLUDED.website_domain,
       goal_ids = EXCLUDED.goal_ids,
       custom_goal = EXCLUDED.custom_goal,
       primary_goal_id = EXCLUDED.primary_goal_id,
       generated_plan = NULL,
       generated_plan_source = 'deterministic',
       updated_at = now()
     RETURNING schema_version, project_mode, website_domain, goal_ids, custom_goal, primary_goal_id,
               generated_plan, generated_plan_source, created_at, updated_at`,
    [
      projectId,
      input.project_mode,
      input.website_domain,
      input.goal_ids,
      input.custom_goal,
      input.primary_goal_id,
    ],
  );
  return mapIntent(rows[0]);
}

export async function saveGeneratedSetupPlan(
  db: Queryable,
  projectId: string,
  plan: Record<string, unknown>,
  source: SetupTaskPlanSource,
): Promise<void> {
  await db.query(
    `UPDATE project_intents SET
       generated_plan = $2,
       generated_plan_source = $3,
       updated_at = now()
     WHERE project_id = $1`,
    [projectId, JSON.stringify(plan), source],
  );
}

export async function recordSetupTaskFeedback(
  db: Queryable,
  projectId: string,
  input: { outcome: 'completed' | 'fallback' | 'blocked' | 'abandoned'; blocker: string | null },
): Promise<{ recorded: true }> {
  await db.query(
    `INSERT INTO setup_task_feedback (project_id, outcome, blocker)
     VALUES ($1, $2, $3)`,
    [projectId, input.outcome, input.blocker],
  );
  return { recorded: true };
}
