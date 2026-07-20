-- Immutable evaluation evidence and human-reviewed decision revisions.

CREATE TABLE evidence_sets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  release_id       uuid NOT NULL REFERENCES releases(id),
  contract_id      uuid NOT NULL REFERENCES measurement_contracts(id),
  evaluated_at     timestamptz NOT NULL,
  source           text NOT NULL CHECK (source IN ('native', 'posthog')),
  baseline_window  jsonb NOT NULL,
  observed_window  jsonb NOT NULL,
  primary_evidence jsonb NOT NULL,
  guardrail_evidence jsonb NOT NULL DEFAULT '[]',
  trust            jsonb NOT NULL,
  query_specs      jsonb NOT NULL,
  facts            jsonb NOT NULL,
  sample_size      integer NOT NULL CHECK (sample_size >= 0),
  ready            boolean NOT NULL,
  blockers         jsonb NOT NULL DEFAULT '[]',
  evidence_key     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, release_id, evidence_key)
);
CREATE INDEX evidence_sets_release_idx
  ON evidence_sets (project_id, release_id, evaluated_at DESC);

CREATE TABLE decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id),
  release_id          uuid NOT NULL REFERENCES releases(id),
  contract_id         uuid NOT NULL REFERENCES measurement_contracts(id),
  evidence_id         uuid NOT NULL REFERENCES evidence_sets(id),
  status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_outcome    text NOT NULL
                        CHECK (proposed_outcome IN ('keep', 'fix', 'rollback', 'inconclusive')),
  proposed_rationale  text NOT NULL,
  accepted_outcome    text
                        CHECK (accepted_outcome IS NULL OR accepted_outcome IN ('keep', 'fix', 'rollback', 'inconclusive')),
  accepted_rationale  text,
  current_revision    integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'proposed' AND accepted_outcome IS NULL AND accepted_rationale IS NULL)
    OR (status = 'approved' AND accepted_outcome IS NOT NULL AND accepted_rationale IS NOT NULL)
    OR (status = 'rejected' AND accepted_outcome IS NULL AND accepted_rationale IS NOT NULL)
  )
);
CREATE INDEX decisions_project_status_idx
  ON decisions (project_id, status, created_at DESC);
CREATE INDEX decisions_release_idx
  ON decisions (project_id, release_id, created_at DESC);

ALTER TABLE releases
  ADD COLUMN originating_decision_id uuid REFERENCES decisions(id);
CREATE INDEX releases_originating_decision_idx
  ON releases (project_id, originating_decision_id, created_at DESC)
  WHERE originating_decision_id IS NOT NULL;

CREATE TABLE decision_revisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id        uuid NOT NULL REFERENCES decisions(id),
  project_id         uuid NOT NULL REFERENCES projects(id),
  revision           integer NOT NULL CHECK (revision > 0),
  action             text NOT NULL CHECK (action IN ('proposed', 'approved', 'edited', 'rejected')),
  actor              text NOT NULL,
  previous_snapshot  jsonb,
  snapshot           jsonb NOT NULL,
  rationale          text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, revision)
);
CREATE INDEX decision_revisions_project_idx
  ON decision_revisions (project_id, decision_id, revision);

CREATE OR REPLACE FUNCTION poolstatis_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER actor_link_audit_append_only
  BEFORE UPDATE OR DELETE ON actor_link_audit
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();

CREATE TRIGGER measurement_contract_revisions_append_only
  BEFORE UPDATE OR DELETE ON measurement_contract_revisions
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();

CREATE TRIGGER release_revisions_append_only
  BEFORE UPDATE OR DELETE ON release_revisions
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();

CREATE TRIGGER evidence_sets_append_only
  BEFORE UPDATE OR DELETE ON evidence_sets
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();

CREATE TRIGGER decision_revisions_append_only
  BEFORE UPDATE OR DELETE ON decision_revisions
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
