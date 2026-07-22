-- Hosted identity/profile metadata.  No credentials or JWT payloads are persisted.

ALTER TABLE auth_users
  ADD COLUMN identity_issuer text NOT NULL DEFAULT 'legacy',
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN display_name text,
  ADD COLUMN connection_strategy text NOT NULL DEFAULT 'oidc';

UPDATE auth_users
SET display_name = name
WHERE display_name IS NULL AND name IS NOT NULL;

ALTER TABLE auth_users DROP CONSTRAINT auth_users_subject_key;
CREATE UNIQUE INDEX auth_users_identity_issuer_subject_key
  ON auth_users (identity_issuer, subject);
