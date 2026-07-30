-- Personal tokens are displayed only as a non-secret prefix/suffix pair.
-- The credential itself remains represented exclusively by token_hash.

ALTER TABLE api_keys
  ADD COLUMN issued_by_user_id uuid REFERENCES auth_users(id),
  ADD COLUMN token_prefix text,
  ADD COLUMN token_suffix text,
  ADD COLUMN last_used_at timestamptz;

CREATE INDEX api_keys_personal_owner_idx
  ON api_keys (org_id, issued_by_user_id, created_at DESC)
  WHERE kind = 'personal';

ALTER TABLE projects
  ADD CONSTRAINT projects_org_id_id_unique UNIQUE (org_id, id);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_project_same_org_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id),
  ADD CONSTRAINT api_keys_project_scope_check CHECK (
    (kind = 'personal' AND project_id IS NULL)
    OR (kind IN ('ingest', 'secret') AND project_id IS NOT NULL)
  );
