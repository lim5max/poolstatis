-- Browser Experience is a purpose-tagged capture surface, not raw DOM replay.
CREATE TABLE experience_surfaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  key         text NOT NULL,
  name        text NOT NULL,
  purpose     text NOT NULL CHECK (length(trim(purpose)) >= 10),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
CREATE INDEX experience_surfaces_project_status_idx ON experience_surfaces (project_id, status, created_at);
