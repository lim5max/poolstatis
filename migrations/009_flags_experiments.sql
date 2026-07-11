-- Feature delivery metadata. Exposure itself remains an immutable event in the
-- normal EventStore; these tables only hold project-scoped definitions.

CREATE TABLE feature_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  key         text NOT NULL,
  name        text NOT NULL,
  purpose     text NOT NULL CHECK (length(trim(purpose)) >= 10),
  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'archived')),
  salt        text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  variants    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
CREATE INDEX feature_flags_project_status_idx ON feature_flags (project_id, status, created_at);

CREATE TABLE experiments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id),
  key                   text NOT NULL,
  name                  text NOT NULL,
  hypothesis            text NOT NULL CHECK (length(trim(hypothesis)) >= 10),
  flag_key              text NOT NULL,
  primary_metric_key    text NOT NULL,
  secondary_metric_keys text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'running', 'concluded')),
  started_at            timestamptz,
  concluded_at          timestamptz,
  decision              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  CHECK ((status = 'draft' AND started_at IS NULL AND concluded_at IS NULL)
      OR (status = 'running' AND started_at IS NOT NULL AND concluded_at IS NULL)
      OR (status = 'concluded' AND started_at IS NOT NULL AND concluded_at IS NOT NULL))
);
CREATE INDEX experiments_project_status_idx ON experiments (project_id, status, created_at);
CREATE INDEX experiments_flag_idx ON experiments (project_id, flag_key, status);
