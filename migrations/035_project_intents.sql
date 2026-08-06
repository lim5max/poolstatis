-- Additive, nullable-by-absence project intent. Existing projects deliberately
-- receive no row: no historical project mode or goal is fabricated.

CREATE TABLE project_intents (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  project_mode text NOT NULL CHECK (project_mode IN ('website', 'product', 'both')),
  website_domain text,
  goal_ids text[] NOT NULL,
  custom_goal text,
  primary_goal_id text NOT NULL,
  generated_plan jsonb,
  generated_plan_source text NOT NULL DEFAULT 'deterministic'
    CHECK (generated_plan_source IN ('deterministic', 'llm', 'fallback')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(goal_ids) BETWEEN 1 AND 3),
  CHECK (array_position(goal_ids, NULL) IS NULL),
  CHECK (goal_ids <@ ARRAY[
    'website_traffic',
    'website_pages',
    'website_conversion',
    'campaigns_referrals',
    'content_engagement',
    'activation',
    'feature_adoption',
    'retention',
    'release',
    'reliability_performance',
    'custom'
  ]::text[]),
  CHECK (
    (goal_ids[1] IS NULL OR cardinality(array_positions(goal_ids, goal_ids[1])) = 1)
    AND (goal_ids[2] IS NULL OR cardinality(array_positions(goal_ids, goal_ids[2])) = 1)
    AND (goal_ids[3] IS NULL OR cardinality(array_positions(goal_ids, goal_ids[3])) = 1)
  ),
  CHECK (primary_goal_id = ANY(goal_ids)),
  CHECK (
    CASE WHEN project_mode = 'product'
      THEN website_domain IS NULL
      ELSE website_domain IS NULL OR (
        length(website_domain) BETWEEN 1 AND 253
        AND website_domain = lower(btrim(website_domain))
        AND website_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$'
      )
    END
  ),
  CHECK (
    CASE WHEN 'custom' = ANY(goal_ids)
      THEN custom_goal IS NOT NULL
        AND length(btrim(custom_goal)) BETWEEN 10 AND 500
        AND custom_goal = btrim(custom_goal)
      ELSE custom_goal IS NULL
    END
  ),
  CHECK (
    generated_plan IS NULL
    OR (
      jsonb_typeof(generated_plan) = 'object'
      AND generated_plan->>'schema_version' = '1'
    )
  )
);

CREATE TABLE setup_task_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'fallback', 'blocked', 'abandoned')),
  blocker text CHECK (
    blocker IS NULL
    OR (length(blocker) BETWEEN 1 AND 100 AND blocker ~ '^[a-z][a-z0-9_]*$')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'blocked') = (blocker IS NOT NULL))
);

CREATE INDEX setup_task_feedback_project_created_idx
  ON setup_task_feedback (project_id, created_at DESC);
