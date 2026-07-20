-- Auditable correlation hypotheses and approval-gated prepared actions.

CREATE TABLE decision_explanations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  decision_id       uuid NOT NULL REFERENCES decisions(id),
  evidence_id       uuid NOT NULL REFERENCES evidence_sets(id),
  algorithm_version text NOT NULL,
  explanation_key   text NOT NULL,
  label             text NOT NULL DEFAULT 'hypothesis' CHECK (label = 'hypothesis'),
  candidates        jsonb NOT NULL DEFAULT '[]',
  omitted           jsonb NOT NULL DEFAULT '[]',
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, decision_id, explanation_key)
);
CREATE INDEX decision_explanations_decision_idx
  ON decision_explanations (project_id, decision_id, created_at DESC);

CREATE TABLE decision_actions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL REFERENCES projects(id),
  decision_id              uuid NOT NULL REFERENCES decisions(id),
  release_id               uuid NOT NULL REFERENCES releases(id),
  evidence_id              uuid NOT NULL REFERENCES evidence_sets(id),
  decision_revision        integer NOT NULL CHECK (decision_revision > 0),
  action_type              text NOT NULL CHECK (action_type IN (
                             'draft_implementation_prompt', 'prepare_flag_rollback',
                             'schedule_observation', 'request_more_data', 'generic_webhook',
                             'create_issue', 'open_draft_pr')),
  status                   text NOT NULL DEFAULT 'prepared' CHECK (status IN (
                             'prepared', 'approved', 'executed', 'rejected', 'failed')),
  target                   jsonb NOT NULL,
  payload                  jsonb NOT NULL,
  expected_effect          text NOT NULL,
  undo                     jsonb NOT NULL,
  confirmation_fingerprint text NOT NULL,
  idempotency_key          text NOT NULL,
  prepared_by              text NOT NULL,
  approved_by              text,
  approved_at              timestamptz,
  executed_at              timestamptz,
  result                   jsonb,
  error_code               text,
  error_message            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX decision_actions_decision_idx
  ON decision_actions (project_id, decision_id, created_at DESC);

CREATE TABLE decision_action_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  action_id   uuid NOT NULL REFERENCES decision_actions(id),
  event       text NOT NULL CHECK (event IN ('prepared', 'approved', 'executed', 'rejected', 'failed', 'retried')),
  actor       text NOT NULL,
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decision_action_audit_idx
  ON decision_action_audit (project_id, action_id, created_at, id);

CREATE TRIGGER decision_action_audit_append_only
  BEFORE UPDATE OR DELETE ON decision_action_audit
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
