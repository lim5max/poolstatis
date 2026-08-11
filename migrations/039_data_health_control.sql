-- Privacy-safe, stable warning identities plus bounded hourly occurrence history.
-- The legacy ingest_warnings row remains the compatibility source for existing
-- REST/MCP consumers; the new public data-health contract never serializes its
-- detail or sample columns.
ALTER TABLE ingest_warnings
  ADD COLUMN signature_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX ingest_warnings_signature_id_idx
  ON ingest_warnings (signature_id);

CREATE TABLE ingest_warning_occurrences (
  signature_id uuid NOT NULL REFERENCES ingest_warnings(signature_id) ON DELETE CASCADE,
  bucket       timestamptz NOT NULL,
  count        bigint NOT NULL CHECK (count > 0),
  PRIMARY KEY (signature_id, bucket)
);

CREATE INDEX ingest_warning_occurrences_bucket_idx
  ON ingest_warning_occurrences (bucket DESC);

-- Hosted Core uses curated grants. Self-host migrations remain schema-only;
-- prepare-hosted invokes this after the NOLOGIN role bootstrap.
CREATE FUNCTION poolstatis_prepare_data_health_role_grants()
RETURNS void AS $data_health_grants$
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.ingest_warning_occurrences
    TO poolstatis_core_runtime
  $grant$;
END
$data_health_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_data_health_role_grants()
  FROM PUBLIC;
