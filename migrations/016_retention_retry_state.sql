ALTER TABLE projects
  ADD COLUMN retention_failed_at timestamptz,
  ADD COLUMN retention_retry_at timestamptz,
  ADD COLUMN retention_last_error text;

CREATE INDEX projects_retention_retry_idx
  ON projects (retention_retry_at)
  WHERE retention_retry_at IS NOT NULL;
