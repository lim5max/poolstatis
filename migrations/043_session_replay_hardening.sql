-- Upgrade-safe replay hardening. This migration intentionally follows 042 so
-- installations that tested the earlier feature branch receive the same
-- privacy policy, deletion audit and durable project cleanup contract.

ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS mask_selectors text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(mask_selectors) <= 20),
  ADD COLUMN IF NOT EXISTS block_selectors text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(block_selectors) <= 20),
  ADD COLUMN delete_retry_after timestamptz NOT NULL DEFAULT '-infinity',
  ADD COLUMN deletion_claimed_until timestamptz NOT NULL DEFAULT '-infinity';

ALTER TABLE projects
  ADD COLUMN replay_deletion_pending boolean NOT NULL DEFAULT false;

-- Deletion audit is the evidence that replay bytes were withdrawn. Keep its
-- immutable project UUID after the tenant row and replay manifest are gone;
-- there is intentionally no FK/cascade on this audit-only identifier.
ALTER TABLE replay_audit_log
  DROP CONSTRAINT replay_audit_log_project_id_fkey;

ALTER TABLE replay_audit_log
  DROP CONSTRAINT replay_audit_log_action_check,
  ADD CONSTRAINT replay_audit_log_action_check
    CHECK (action IN ('view', 'delete', 'delete_requested', 'delete_completed'));

CREATE UNIQUE INDEX IF NOT EXISTS replay_audit_delete_once_idx
  ON replay_audit_log (replay_id, action)
  WHERE action IN ('delete_requested', 'delete_completed');

CREATE FUNCTION poolstatis_reject_replay_audit_mutation()
RETURNS trigger AS $replay_audit_immutable$
BEGIN
  RAISE EXCEPTION 'replay_audit_log rows are append-only'
    USING ERRCODE = '55000';
END
$replay_audit_immutable$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION poolstatis_reject_replay_audit_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS replay_audit_log_append_only ON replay_audit_log;

CREATE TRIGGER replay_audit_log_append_only
  BEFORE UPDATE OR DELETE ON replay_audit_log
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_replay_audit_mutation();

-- This job deliberately has no project foreign key: it must survive the
-- project-row cascade and make the final object-prefix sweep retryable.
CREATE TABLE replay_project_deletion_jobs (
  project_id       uuid PRIMARY KEY,
  actor            text NOT NULL,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_after      timestamptz NOT NULL DEFAULT '-infinity',
  claimed_until    timestamptz NOT NULL DEFAULT '-infinity',
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at     timestamptz
);

CREATE INDEX replay_project_deletion_jobs_retry_idx
  ON replay_project_deletion_jobs (retry_after, claimed_until, created_at)
  WHERE completed_at IS NULL;

CREATE INDEX replay_sessions_deletion_claim_idx
  ON replay_sessions (delete_retry_after, deletion_claimed_until, delete_attempts, delete_after)
  WHERE status <> 'deleted';

-- Replace the 042 helper as part of the upgrade so calling the stable helper
-- again cannot re-grant mutation access to append-only replay audit rows.
CREATE OR REPLACE FUNCTION poolstatis_prepare_replay_role_grants()
RETURNS void AS $replay_grants$
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
      public.replay_sessions,
      public.replay_chunks
    TO poolstatis_core_runtime
  $grant$;
  EXECUTE $grant$
    GRANT SELECT, INSERT ON TABLE public.replay_audit_log
    TO poolstatis_core_runtime
  $grant$;
  EXECUTE $revoke$
    REVOKE UPDATE, DELETE ON TABLE public.replay_audit_log
    FROM poolstatis_core_runtime
  $revoke$;
  EXECUTE $grant$
    GRANT USAGE, SELECT ON SEQUENCE public.replay_audit_log_id_seq
    TO poolstatis_core_runtime
  $grant$;
END
$replay_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

CREATE FUNCTION poolstatis_prepare_replay_hardening_role_grants()
RETURNS void AS $replay_hardening_grants$
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
      public.replay_project_deletion_jobs
    TO poolstatis_core_runtime
  $grant$;
  EXECUTE $revoke$
    REVOKE UPDATE, DELETE ON TABLE public.replay_audit_log
    FROM poolstatis_core_runtime
  $revoke$;
END
$replay_hardening_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_replay_hardening_role_grants() FROM PUBLIC;
