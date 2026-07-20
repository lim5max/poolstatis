-- Product decision loop: audited identity, property semantics, external sources,
-- and proof-gated setup evidence.

CREATE TABLE actor_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id),
  env                 text NOT NULL,
  source_distinct_id  text NOT NULL,
  target_distinct_id  text NOT NULL,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'revoked')),
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_by          text,
  revoked_at          timestamptz,
  CHECK (source_distinct_id <> target_distinct_id),
  CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL)
    OR
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX actor_links_active_source_idx
  ON actor_links (project_id, env, source_distinct_id)
  WHERE status = 'active';
CREATE INDEX actor_links_target_idx
  ON actor_links (project_id, env, target_distinct_id)
  WHERE status = 'active';
CREATE INDEX actor_links_history_idx
  ON actor_links (project_id, env, created_at DESC);

-- Resolve the current canonical actor without rewriting immutable events.
-- The visited path makes reads terminate even if an operator bypasses the API
-- and corrupts the link graph, without truncating legitimate long chains.
CREATE OR REPLACE FUNCTION poolstatis_resolve_actor(
  p_project_id uuid,
  p_env text,
  p_distinct_id text
) RETURNS text AS $$
  WITH RECURSIVE chain(actor, path) AS (
    SELECT p_distinct_id, ARRAY[p_distinct_id]::text[]
    UNION ALL
    SELECT links.target_distinct_id, chain.path || links.target_distinct_id
    FROM chain
    JOIN actor_links links
      ON links.project_id = p_project_id
     AND links.env = p_env
     AND links.source_distinct_id = chain.actor
     AND links.status = 'active'
    WHERE NOT links.target_distinct_id = ANY(chain.path)
  )
  SELECT actor FROM chain ORDER BY cardinality(path) DESC, actor LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE TABLE actor_link_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_link_id  uuid NOT NULL REFERENCES actor_links(id),
  project_id     uuid NOT NULL REFERENCES projects(id),
  env            text NOT NULL,
  action         text NOT NULL CHECK (action IN ('created', 'revoked')),
  actor          text NOT NULL,
  snapshot       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actor_link_audit_project_idx
  ON actor_link_audit (project_id, env, created_at DESC);

CREATE TABLE source_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id),
  provider             text NOT NULL CHECK (provider = 'posthog'),
  name                 text NOT NULL,
  host                 text NOT NULL,
  external_project_id  text NOT NULL,
  secret_ciphertext    bytea NOT NULL,
  secret_iv            bytea NOT NULL,
  secret_tag           bytea NOT NULL,
  status               text NOT NULL DEFAULT 'configured'
                         CHECK (status IN ('configured', 'verified', 'error', 'disabled')),
  capabilities         jsonb NOT NULL DEFAULT '{}',
  last_error           text,
  verified_at          timestamptz,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider, name)
);
CREATE INDEX source_connections_project_idx
  ON source_connections (project_id, provider, status);

CREATE TABLE property_definitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id),
  key                   text NOT NULL,
  scope                 text NOT NULL CHECK (scope IN ('event', 'actor', 'entity')),
  value_type            text NOT NULL
                          CHECK (value_type IN ('string', 'number', 'boolean', 'datetime', 'enum')),
  purpose               text NOT NULL CHECK (length(trim(purpose)) >= 10),
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'trusted', 'untrusted')),
  source                text NOT NULL DEFAULT 'native'
                          CHECK (source IN ('native', 'posthog')),
  source_connection_id  uuid REFERENCES source_connections(id),
  enum_values           jsonb,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (value_type = 'enum' AND jsonb_typeof(enum_values) = 'array')
    OR
    (value_type <> 'enum' AND enum_values IS NULL)
  ),
  CHECK (
    (source = 'native' AND source_connection_id IS NULL)
    OR
    (source = 'posthog' AND source_connection_id IS NOT NULL)
  ),
  UNIQUE (project_id, scope, key)
);
CREATE INDEX property_definitions_project_idx
  ON property_definitions (project_id, status, scope, key);

CREATE TABLE query_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  env             text NOT NULL,
  source          text NOT NULL CHECK (source IN ('native', 'posthog')),
  query           jsonb NOT NULL,
  result_summary  jsonb NOT NULL,
  operator        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX query_runs_project_idx
  ON query_runs (project_id, env, created_at DESC);

CREATE TABLE onboarding_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  env              text NOT NULL,
  gate_key         text NOT NULL,
  reason           text NOT NULL CHECK (length(trim(reason)) >= 10),
  acknowledged_by  text NOT NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, env, gate_key)
);
CREATE INDEX onboarding_acknowledgements_project_idx
  ON onboarding_acknowledgements (project_id, env, acknowledged_at DESC);

CREATE TABLE agent_observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  env          text NOT NULL,
  client       text NOT NULL,
  observed_by  text NOT NULL,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, env, client)
);
CREATE INDEX agent_observations_project_idx
  ON agent_observations (project_id, env, observed_at DESC);
