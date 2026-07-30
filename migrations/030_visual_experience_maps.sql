-- Visual Experience Maps keeps immutable page-version evidence separate from
-- analytics events. Events remain the billing unit; image bytes live in the
-- configured artifact store and are referenced by an opaque project-scoped key.
CREATE TABLE experience_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface_id    uuid NOT NULL REFERENCES experience_surfaces(id) ON DELETE CASCADE,
  key           text NOT NULL,
  name          text NOT NULL,
  path_pattern  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, surface_id, key),
  CHECK (path_pattern LIKE '/%' AND position('?' IN path_pattern) = 0 AND position('#' IN path_pattern) = 0)
);

-- Existing single-route surfaces get a conservative canonical route. Products
-- can register additional route keys without changing historic events.
INSERT INTO experience_routes (project_id, surface_id, key, name, path_pattern)
SELECT project_id, id, key, name, '/' || key
FROM experience_surfaces;

CREATE INDEX experience_routes_project_surface_idx
  ON experience_routes (project_id, surface_id, key);

CREATE TABLE experience_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface_id       uuid NOT NULL REFERENCES experience_surfaces(id) ON DELETE CASCADE,
  route_id         uuid NOT NULL REFERENCES experience_routes(id) ON DELETE RESTRICT,
  env              text NOT NULL,
  version          text NOT NULL,
  device           text NOT NULL CHECK (device IN ('desktop', 'mobile')),
  release_hash     text NOT NULL,
  artifact_key     text NOT NULL UNIQUE,
  mime_type        text NOT NULL CHECK (mime_type IN ('image/png', 'image/webp')),
  byte_size        integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  width            integer NOT NULL CHECK (width BETWEEN 1 AND 10000),
  height           integer NOT NULL CHECK (height BETWEEN 1 AND 50000),
  viewport_width   integer NOT NULL CHECK (viewport_width BETWEEN 240 AND 10000),
  viewport_height  integer NOT NULL CHECK (viewport_height BETWEEN 240 AND 10000),
  document_width   integer NOT NULL CHECK (document_width BETWEEN 1 AND 10000),
  document_height  integer NOT NULL CHECK (document_height BETWEEN 1 AND 50000),
  captured_at      timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX experience_snapshots_lookup_idx
  ON experience_snapshots (project_id, surface_id, env, route_id, version, device, captured_at DESC);
CREATE INDEX experience_snapshots_expiry_idx
  ON experience_snapshots (expires_at);

-- Version/device/route predicates are common for visual maps. The expression
-- index keeps the EventStore implementation viable on a busy Postgres tenant.
CREATE INDEX events_visual_experience_lookup_idx
  ON ONLY events (
    project_id,
    env,
    (properties->>'surface'),
    (properties->>'route'),
    (properties->>'version'),
    (properties->>'device'),
    "timestamp" DESC
  )
  WHERE event_source = 'experience';

-- Hosted Core uses a curated NOLOGIN role rather than table-owner credentials.
-- Keep ordinary self-host migration schema-only: the explicit prepare-hosted
-- job invokes this grant after the stable role has been bootstrapped.
CREATE FUNCTION poolstatis_prepare_visual_experience_role_grants()
RETURNS void AS $visual_experience_grants$
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
      public.experience_routes,
      public.experience_snapshots
    TO poolstatis_core_runtime
  $grant$;
END
$visual_experience_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_visual_experience_role_grants()
  FROM PUBLIC;
