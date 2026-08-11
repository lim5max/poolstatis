-- Immutable semantic metric definition history. Existing metrics are adopted
-- lazily on their first definition read/write so this additive migration does
-- not invent historical authors or rewrite customer rows.

CREATE TABLE metric_definition_revisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric_id            uuid NOT NULL,
  metric_key           text NOT NULL,
  revision             integer NOT NULL CHECK (revision > 0),
  action               text NOT NULL CHECK (action IN ('created', 'updated', 'legacy_update')),
  semantic_fingerprint text NOT NULL CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  aggregation          text NOT NULL CHECK (length(aggregation) BETWEEN 1 AND 80),
  snapshot             jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot->>'key' = metric_key
    AND snapshot->>'purpose' IS NOT NULL
    AND snapshot->>'type' IS NOT NULL
    AND snapshot->>'aggregation' = aggregation
    AND jsonb_typeof(snapshot->'source') = 'object'
  ),
  actor                text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, metric_id, revision),
  UNIQUE (project_id, metric_key, revision)
);

CREATE INDEX metric_definition_revisions_current_idx
  ON metric_definition_revisions (project_id, metric_key, revision DESC);

CREATE OR REPLACE FUNCTION poolstatis_reject_metric_definition_revision_mutation()
RETURNS trigger AS $metric_definition_revision_immutable$
BEGIN
  -- Project deletion is an explicit audited destructive operation. Allow the
  -- parent FK cascade while rejecting direct revision deletion and all edits.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'metric definition revisions are append-only' USING ERRCODE = '55000';
END
$metric_definition_revision_immutable$
LANGUAGE plpgsql;

CREATE TRIGGER metric_definition_revisions_immutable
  BEFORE UPDATE OR DELETE ON metric_definition_revisions
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_metric_definition_revision_mutation();

-- Hosted Core uses curated grants. Ordinary self-host migration remains
-- schema-only; prepare-hosted invokes this after role bootstrap.
CREATE FUNCTION poolstatis_prepare_metric_definition_role_grants()
RETURNS void AS $metric_definition_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'poolstatis_core_runtime'
      AND NOT rolcanlogin
      AND NOT rolinherit
  ) THEN
    RAISE EXCEPTION
      'hosted policy role poolstatis_core_runtime is missing or not NOLOGIN NOINHERIT; run the privileged role bootstrap'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE $grant$
    GRANT SELECT, INSERT ON TABLE
      public.metric_definition_revisions
    TO poolstatis_core_runtime
  $grant$;
END
$metric_definition_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_metric_definition_role_grants()
  FROM PUBLIC;

-- Rollback is operator-driven because migrations are forward-only: first
-- deploy a binary that no longer reads/writes revision history, then drop the
-- trigger/function/table. The metrics table itself is not altered by rollback.
