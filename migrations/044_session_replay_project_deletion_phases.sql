-- Existing installations may already have recorded migration 043 by name.
-- Add phased, crash-resumable project deletion in a new migration so those
-- databases receive the same privacy cleanup contract as fresh installs.

ALTER TABLE replay_project_deletion_jobs
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'artifacts'
    CHECK (phase IN ('artifacts', 'events', 'replays', 'metadata', 'objects')),
  ADD COLUMN IF NOT EXISTS artifacts_deleted integer NOT NULL DEFAULT 0
    CHECK (artifacts_deleted >= 0),
  ADD COLUMN IF NOT EXISTS events_deleted bigint NOT NULL DEFAULT 0
    CHECK (events_deleted >= 0),
  ADD COLUMN IF NOT EXISTS replays_deleted integer NOT NULL DEFAULT 0
    CHECK (replays_deleted >= 0);

-- Snapshot object keys must survive the project cascade just like the replay
-- prefix job. Each delete is idempotent and individually checkpointed.
CREATE TABLE IF NOT EXISTS replay_project_deletion_artifacts (
  project_id   uuid NOT NULL REFERENCES replay_project_deletion_jobs(project_id) ON DELETE CASCADE,
  artifact_key text NOT NULL,
  deleted_at   timestamptz,
  PRIMARY KEY (project_id, artifact_key)
);

-- Snapshot bytes are written before their metadata row. The project-row share
-- lock serializes this trigger with beginProjectDeletion(): either the insert
-- commits first and its key is copied, or it observes the barrier and the
-- service removes the just-written object after PSD01.
CREATE OR REPLACE FUNCTION poolstatis_reject_snapshot_for_deleting_project()
RETURNS trigger AS $snapshot_delete_barrier$
DECLARE
  deletion_pending boolean;
BEGIN
  SELECT replay_deletion_pending INTO deletion_pending
  FROM projects
  WHERE id = NEW.project_id
  FOR SHARE;

  IF NOT FOUND OR deletion_pending THEN
    RAISE EXCEPTION 'project deletion has disabled snapshot writes'
      USING ERRCODE = 'PSD01';
  END IF;
  RETURN NEW;
END
$snapshot_delete_barrier$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION poolstatis_reject_snapshot_for_deleting_project() FROM PUBLIC;

DROP TRIGGER IF EXISTS experience_snapshots_project_delete_barrier ON experience_snapshots;

CREATE TRIGGER experience_snapshots_project_delete_barrier
  BEFORE INSERT OR UPDATE ON experience_snapshots
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_snapshot_for_deleting_project();

CREATE OR REPLACE FUNCTION poolstatis_prepare_replay_hardening_role_grants()
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
      public.replay_project_deletion_jobs,
      public.replay_project_deletion_artifacts
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
