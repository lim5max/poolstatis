-- Immutable, reproducible evidence captured before a funnel finding can feed
-- a product decision. The saved funnel is retained as the semantic source;
-- callers cannot persist ad-hoc event names or client-supplied results.

ALTER TABLE funnels
  ADD CONSTRAINT funnels_project_id_id_unique UNIQUE (project_id, id);

CREATE TABLE funnel_investigations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env                  text NOT NULL CHECK (length(btrim(env)) BETWEEN 1 AND 100),
  funnel_id            uuid NOT NULL,
  funnel_key           text NOT NULL,
  from_step            integer NOT NULL CHECK (from_step >= 0),
  to_step              integer NOT NULL CHECK (to_step = from_step + 1),
  funnel_snapshot      jsonb NOT NULL,
  query_spec           jsonb NOT NULL,
  query_result         jsonb NOT NULL,
  evidence             jsonb NOT NULL,
  query_fingerprint    text NOT NULL CHECK (query_fingerprint ~ '^[a-f0-9]{64}$'),
  result_fingerprint   text NOT NULL CHECK (result_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key      text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  created_by           text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, funnel_id)
    REFERENCES funnels(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX funnel_investigations_scope_idx
  ON funnel_investigations (project_id, env, funnel_key, created_at DESC, id DESC);

CREATE TRIGGER funnel_investigations_append_only
  BEFORE UPDATE OR DELETE ON funnel_investigations
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
