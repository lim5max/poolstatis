-- Additive experiment integrity metadata. Existing feature flags remain
-- project-wide (env IS NULL) and existing experiment rows keep working. Rows
-- that already started receive a best-effort snapshot of their current
-- definitions and are labelled honestly as backfilled rather than pretending
-- the snapshot was captured at start time.

ALTER TABLE feature_flags
  ADD COLUMN env text;

ALTER TABLE experiments
  ADD COLUMN env text,
  ADD COLUMN control_variant_key text,
  ADD COLUMN flag_snapshot jsonb,
  ADD COLUMN metric_snapshots jsonb,
  ADD COLUMN snapshot_integrity text NOT NULL DEFAULT 'legacy_unfrozen'
    CHECK (snapshot_integrity IN ('legacy_unfrozen', 'backfilled_current', 'frozen_at_start'));

UPDATE experiments AS e
SET env = ff.env,
    control_variant_key = ff.variants->0->>'key',
    flag_snapshot = jsonb_build_object(
      'key', ff.key,
      'env', ff.env,
      'salt', ff.salt,
      'variants', ff.variants
    ),
    metric_snapshots = COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'key', m.key,
          'name', m.name,
          'purpose', m.purpose,
          'type', m.type,
          'source', m.source
        )
        ORDER BY refs.ordinality
      )
      FROM unnest(ARRAY[e.primary_metric_key] || e.secondary_metric_keys)
        WITH ORDINALITY AS refs(metric_key, ordinality)
      JOIN metrics AS m
        ON m.project_id = e.project_id AND m.key = refs.metric_key
    ), '[]'::jsonb),
    snapshot_integrity = 'backfilled_current'
FROM feature_flags AS ff
WHERE ff.project_id = e.project_id
  AND ff.key = e.flag_key
  AND e.status IN ('running', 'concluded');

CREATE INDEX feature_flags_project_env_status_idx
  ON feature_flags (project_id, env, status, created_at);

CREATE INDEX experiments_project_env_status_idx
  ON experiments (project_id, env, status, created_at);
