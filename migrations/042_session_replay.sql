-- Session Replay metadata is authoritative in PostgreSQL; untrusted rrweb
-- payload bytes live behind ReplayObjectStore and never enter analytics events.
CREATE TABLE replay_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface_id          uuid NOT NULL REFERENCES experience_surfaces(id) ON DELETE RESTRICT,
  route_id            uuid NOT NULL REFERENCES experience_routes(id) ON DELETE RESTRICT,
  env                 text NOT NULL CHECK (length(env) BETWEEN 1 AND 40),
  session_id          text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  distinct_id         text NOT NULL CHECK (length(distinct_id) BETWEEN 1 AND 200),
  host                text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  version             text NOT NULL CHECK (length(version) BETWEEN 1 AND 120),
  device              text NOT NULL CHECK (device IN ('desktop', 'mobile')),
  consent_version     text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 120),
  policy_version      text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 120),
  policy_hash         text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  text_mode           text NOT NULL CHECK (text_mode IN ('masked', 'visible')),
  status              text NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'playable', 'incomplete', 'deleting', 'deleted')),
  upload_token_hash   text NOT NULL,
  chunk_count         integer NOT NULL DEFAULT 0 CHECK (chunk_count BETWEEN 0 AND 120),
  event_count         integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 50000),
  byte_size           bigint NOT NULL DEFAULT 0 CHECK (byte_size BETWEEN 0 AND 20971520),
  started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at        timestamptz,
  last_seen_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  delete_after        timestamptz NOT NULL,
  deleted_at          timestamptz,
  delete_attempts     integer NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  last_delete_error   text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE replay_chunks (
  replay_id       uuid NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  sequence        integer NOT NULL CHECK (sequence BETWEEN 0 AND 119),
  object_key      text NOT NULL UNIQUE,
  checksum        text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  stored_checksum text NOT NULL CHECK (stored_checksum ~ '^[a-f0-9]{64}$'),
  byte_size       integer NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  event_count     integer NOT NULL CHECK (event_count BETWEEN 1 AND 500),
  first_timestamp bigint NOT NULL,
  last_timestamp  bigint NOT NULL CHECK (last_timestamp >= first_timestamp),
  has_checkout    boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (replay_id, sequence)
);

CREATE TABLE replay_audit_log (
  id          bigserial PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  replay_id   uuid NOT NULL,
  actor       text NOT NULL,
  action      text NOT NULL CHECK (action IN ('view', 'delete')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX replay_sessions_project_time_idx
  ON replay_sessions (project_id, env, started_at DESC);
CREATE INDEX replay_sessions_retention_idx
  ON replay_sessions (delete_after, status)
  WHERE status <> 'deleted';
CREATE INDEX replay_chunks_replay_sequence_idx
  ON replay_chunks (replay_id, sequence);
CREATE INDEX replay_audit_project_time_idx
  ON replay_audit_log (project_id, created_at DESC);

CREATE FUNCTION poolstatis_prepare_replay_role_grants()
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
      public.replay_chunks,
      public.replay_audit_log
    TO poolstatis_core_runtime
  $grant$;
  EXECUTE $grant$
    GRANT USAGE, SELECT ON SEQUENCE public.replay_audit_log_id_seq
    TO poolstatis_core_runtime
  $grant$;
END
$replay_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_replay_role_grants() FROM PUBLIC;
