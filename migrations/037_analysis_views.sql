-- Saved analytics answers are bounded, project/environment-scoped snapshots.
-- The current row supports the active/archive lifecycle; the audit is append-only
-- and intentionally stores only fingerprints and bounded credential role metadata.

CREATE TABLE analysis_views (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env                 text NOT NULL CHECK (length(env) BETWEEN 1 AND 100),
  title               text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description         text CHECK (description IS NULL OR length(description) <= 1000),
  template_key        text CHECK (
    template_key IS NULL
    OR (length(template_key) BETWEEN 1 AND 100 AND template_key ~ '^[a-z][a-z0-9_]*$')
  ),
  schema_version      integer NOT NULL CHECK (schema_version = 1),
  visualization_spec jsonb NOT NULL CHECK (jsonb_typeof(visualization_spec) = 'object'),
  answer_snapshot     jsonb NOT NULL CHECK (jsonb_typeof(answer_snapshot) = 'object'),
  evidence_snapshot   jsonb NOT NULL CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  spec_fingerprint    text NOT NULL CHECK (spec_fingerprint ~ '^[a-f0-9]{64}$'),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  official            boolean NOT NULL DEFAULT false,
  created_by_kind     text NOT NULL CHECK (created_by_kind IN ('secret', 'personal', 'user')),
  created_by_role     text CHECK (created_by_role IS NULL OR created_by_role IN ('owner', 'admin')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  CHECK (NOT official OR status = 'active'),
  CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE INDEX analysis_views_project_env_status_idx
  ON analysis_views (project_id, env, status, official, updated_at DESC, id DESC);

CREATE TABLE analysis_view_audit (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_view_id      uuid NOT NULL REFERENCES analysis_views(id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env                   text NOT NULL CHECK (length(env) BETWEEN 1 AND 100),
  action                text NOT NULL CHECK (action IN ('created', 'updated', 'official_changed', 'archived')),
  performed_by_kind     text NOT NULL CHECK (performed_by_kind IN ('secret', 'personal', 'user')),
  performed_by_role     text CHECK (performed_by_role IS NULL OR performed_by_role IN ('owner', 'admin')),
  schema_version        integer NOT NULL CHECK (schema_version = 1),
  spec_fingerprint      text NOT NULL CHECK (spec_fingerprint ~ '^[a-f0-9]{64}$'),
  previous_status       text CHECK (previous_status IS NULL OR previous_status IN ('active', 'archived')),
  next_status           text NOT NULL CHECK (next_status IN ('active', 'archived')),
  previous_official     boolean,
  next_official         boolean NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analysis_view_audit_project_view_idx
  ON analysis_view_audit (project_id, analysis_view_id, created_at, id);

CREATE TRIGGER analysis_view_audit_append_only
  BEFORE UPDATE OR DELETE ON analysis_view_audit
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();

-- Hosted Core runs through a curated NOLOGIN role. Ordinary self-host migration
-- remains schema-only; prepare-hosted invokes this grant after role bootstrap.
CREATE FUNCTION poolstatis_prepare_analysis_views_role_grants()
RETURNS void AS $analysis_views_grants$
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
    GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_views
      TO poolstatis_core_runtime;
    GRANT SELECT, INSERT ON TABLE public.analysis_view_audit
      TO poolstatis_core_runtime
  $grant$;
END
$analysis_views_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_analysis_views_role_grants()
  FROM PUBLIC;
