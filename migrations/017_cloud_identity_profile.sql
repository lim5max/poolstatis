-- Hosted identity/profile metadata.  No credentials or JWT payloads are persisted.

ALTER TABLE auth_users
  ADD COLUMN identity_issuer text,
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN display_name text,
  ADD COLUMN connection_strategy text NOT NULL DEFAULT 'oidc';

UPDATE auth_users
SET display_name = name
WHERE display_name IS NULL AND name IS NOT NULL;

-- Expand phase: keep UNIQUE(subject) while old binaries can still execute
-- `ON CONFLICT (subject)`. A later contract migration may replace it with a
-- composite issuer+subject constraint after rollback binaries are retired.
CREATE INDEX auth_users_identity_issuer_subject_idx
  ON auth_users (identity_issuer, subject);
