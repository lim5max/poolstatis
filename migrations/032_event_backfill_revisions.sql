-- Safe historical imports and auditable corrections for native events.
--
-- The current event row remains the query-optimized materialization. Every
-- correction records immutable before/after snapshots, so a fact is never
-- changed without provenance. Existing rows receive stable UUIDs in-place;
-- no event table or partition is recreated.

SET LOCAL lock_timeout = '5s';

ALTER TABLE events ADD COLUMN id uuid;
ALTER TABLE events ALTER COLUMN id SET DEFAULT gen_random_uuid();
UPDATE events SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE events ALTER COLUMN id SET NOT NULL;

ALTER TABLE events ADD COLUMN revision integer NOT NULL DEFAULT 1
  CHECK (revision > 0);
ALTER TABLE events ADD COLUMN origin text NOT NULL DEFAULT 'live'
  CHECK (origin IN ('live', 'backfill'));
ALTER TABLE events ADD COLUMN backfill_batch_id uuid;

CREATE INDEX events_project_id_idx
  ON events (project_id, id);

CREATE TABLE event_backfill_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env            text NOT NULL,
  batch_id       text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  reason         text NOT NULL CHECK (length(trim(reason)) >= 10),
  actor          text NOT NULL,
  event_count    integer NOT NULL CHECK (event_count > 0),
  registered_count integer NOT NULL CHECK (registered_count >= 0),
  unregistered_count integer NOT NULL CHECK (unregistered_count >= 0),
  min_timestamp  timestamptz NOT NULL,
  max_timestamp  timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, env, batch_id),
  CHECK (min_timestamp <= max_timestamp),
  CHECK (registered_count + unregistered_count = event_count)
);

CREATE INDEX event_backfill_batches_project_idx
  ON event_backfill_batches (project_id, env, created_at DESC);

CREATE TABLE event_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env               text NOT NULL,
  revision          integer NOT NULL CHECK (revision > 1),
  actor             text NOT NULL,
  reason            text NOT NULL CHECK (length(trim(reason)) >= 10),
  previous_snapshot jsonb NOT NULL,
  snapshot          jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, event_id, revision)
);

CREATE INDEX event_revisions_project_event_idx
  ON event_revisions (project_id, event_id, revision DESC);

CREATE OR REPLACE FUNCTION poolstatis_protect_event_audit()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND (
       current_setting('poolstatis.event_purge', true) = 'on'
       OR NOT EXISTS (
         SELECT 1 FROM projects WHERE id = OLD.project_id
       )
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_backfill_batches_append_only
  BEFORE UPDATE OR DELETE ON event_backfill_batches
  FOR EACH ROW EXECUTE FUNCTION poolstatis_protect_event_audit();

CREATE TRIGGER event_revisions_append_only
  BEFORE UPDATE OR DELETE ON event_revisions
  FOR EACH ROW EXECUTE FUNCTION poolstatis_protect_event_audit();

CREATE OR REPLACE FUNCTION poolstatis_prepare_event_management_role_grants()
RETURNS void AS $event_management_grants$
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
      public.event_backfill_batches,
      public.event_revisions
    TO poolstatis_core_runtime
  $grant$;
END
$event_management_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_event_management_role_grants()
  FROM PUBLIC;

-- Rollback is forward-only: old runtimes ignore the additive event columns and
-- audit tables. Do not drop IDs or audit data during an application rollback.
