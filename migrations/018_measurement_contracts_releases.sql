-- Repository-owned measurement contracts and immutable change provenance.

CREATE TABLE measurement_contracts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                 uuid NOT NULL REFERENCES projects(id),
  key                        text NOT NULL,
  name                       text NOT NULL,
  business_hypothesis        text NOT NULL CHECK (length(trim(business_hypothesis)) >= 10),
  decision_owner             text NOT NULL,
  primary_metric_key         text NOT NULL,
  guardrail_metric_keys      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(guardrail_metric_keys) = 'array'),
  target_filters             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(target_filters) = 'array'),
  baseline_window_days       integer NOT NULL CHECK (baseline_window_days > 0),
  observation_window_days    integer NOT NULL CHECK (observation_window_days > 0),
  minimum_sample_size        integer NOT NULL DEFAULT 100 CHECK (minimum_sample_size > 0),
  expected_direction         text NOT NULL CHECK (expected_direction IN ('increase', 'decrease', 'stay_within_range')),
  minimum_meaningful_effect  double precision CHECK (minimum_meaningful_effect IS NULL OR minimum_meaningful_effect >= 0),
  flag_key                   text,
  experiment_key             text,
  external_references        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(external_references) = 'object'),
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  revision                   integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  declaration_hash           text NOT NULL,
  created_by                 text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
CREATE INDEX measurement_contracts_project_status_idx
  ON measurement_contracts (project_id, status, key);

CREATE TABLE measurement_contract_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id       uuid NOT NULL REFERENCES measurement_contracts(id),
  project_id        uuid NOT NULL REFERENCES projects(id),
  revision          integer NOT NULL CHECK (revision > 0),
  action            text NOT NULL CHECK (action IN ('created', 'updated', 'archived')),
  declaration_hash  text NOT NULL,
  snapshot          jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  actor             text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, revision)
);
CREATE INDEX measurement_contract_revisions_project_idx
  ON measurement_contract_revisions (project_id, contract_id, revision DESC);

CREATE TABLE releases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id),
  contract_id          uuid NOT NULL REFERENCES measurement_contracts(id),
  contract_key         text NOT NULL,
  contract_revision    integer NOT NULL CHECK (contract_revision > 0),
  contract_snapshot    jsonb NOT NULL CHECK (jsonb_typeof(contract_snapshot) = 'object'),
  env                  text NOT NULL,
  repository           text NOT NULL,
  branch               text,
  commit_sha           text NOT NULL,
  pr_url                text,
  deployed_at          timestamptz,
  flag_key             text,
  experiment_key       text,
  variant              text,
  status               text NOT NULL CHECK (status IN ('planned', 'deployed', 'observing', 'decided', 'cancelled')),
  idempotency_key      text NOT NULL,
  evaluation_attempts  integer NOT NULL DEFAULT 0 CHECK (evaluation_attempts >= 0),
  next_evaluation_at   timestamptz,
  retry_state          jsonb NOT NULL DEFAULT '{}',
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'planned' AND deployed_at IS NULL) OR (status <> 'planned' AND deployed_at IS NOT NULL)),
  UNIQUE (project_id, env, idempotency_key)
);
CREATE INDEX releases_project_status_idx
  ON releases (project_id, env, status, created_at DESC);
CREATE INDEX releases_contract_idx
  ON releases (project_id, contract_id, created_at DESC);

CREATE TABLE release_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id  uuid NOT NULL REFERENCES releases(id),
  project_id  uuid NOT NULL REFERENCES projects(id),
  action      text NOT NULL CHECK (action IN ('registered', 'transitioned')),
  from_status text,
  to_status   text NOT NULL,
  snapshot    jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX release_revisions_project_idx
  ON release_revisions (project_id, release_id, created_at, id);
