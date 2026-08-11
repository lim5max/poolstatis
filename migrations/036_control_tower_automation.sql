-- Configurable monitors, scheduled semantic insight feeds and truthful built-in notifications.
-- Operational job rows are mutable; revisions, findings, result snapshots and audit are immutable.

CREATE TABLE notification_destinations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('in_product', 'outbox')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  UNIQUE (project_id, id)
);

CREATE TABLE notification_destination_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL,
  destination_id  uuid NOT NULL,
  event           text NOT NULL CHECK (event IN ('created', 'enabled', 'disabled')),
  actor           text NOT NULL,
  snapshot        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, destination_id)
    REFERENCES notification_destinations(project_id, id) ON DELETE CASCADE
);

CREATE TABLE monitor_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  policy_key          text NOT NULL,
  name                text NOT NULL,
  current_version     integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  next_evaluation_at  timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, policy_key),
  UNIQUE (project_id, id)
);

CREATE TABLE monitor_policy_revisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,
  policy_id             uuid NOT NULL,
  version               integer NOT NULL CHECK (version > 0),
  env                   text NOT NULL,
  target_kind           text NOT NULL CHECK (target_kind IN ('project', 'release', 'experiment')),
  target_id             uuid,
  metric_key            text NOT NULL,
  comparison_rule       text NOT NULL CHECK (comparison_rule IN ('above', 'below', 'change_up_percent', 'change_down_percent')),
  threshold             double precision NOT NULL CHECK (
    threshold > '-Infinity'::double precision AND threshold < 'Infinity'::double precision
  ),
  minimum_sample        integer NOT NULL CHECK (minimum_sample >= 0),
  window_minutes        integer NOT NULL CHECK (window_minutes BETWEEN 5 AND 525600),
  cadence_minutes       integer NOT NULL CHECK (cadence_minutes BETWEEN 1 AND 525600),
  cooldown_seconds      integer NOT NULL CHECK (cooldown_seconds BETWEEN 0 AND 31536000),
  owner                 text NOT NULL,
  destination_ids       uuid[] NOT NULL DEFAULT '{}',
  proposal_kind         text CHECK (proposal_kind IS NULL OR proposal_kind IN ('pause', 'rollback')),
  proposal_target       jsonb,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, policy_id) REFERENCES monitor_policies(project_id, id) ON DELETE CASCADE,
  UNIQUE (policy_id, version),
  CHECK ((target_kind = 'project' AND target_id IS NULL) OR (target_kind <> 'project' AND target_id IS NOT NULL)),
  CHECK ((proposal_kind IS NULL AND proposal_target IS NULL) OR (proposal_kind IS NOT NULL AND proposal_target IS NOT NULL))
);
CREATE INDEX monitor_policy_revisions_project_idx ON monitor_policy_revisions (project_id, policy_id, version DESC);

CREATE TABLE monitor_policy_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL,
  policy_id   uuid NOT NULL,
  event       text NOT NULL CHECK (event IN ('created', 'revised', 'paused', 'resumed', 'archived')),
  actor       text NOT NULL,
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, policy_id) REFERENCES monitor_policies(project_id, id) ON DELETE CASCADE
);

CREATE TABLE monitor_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL,
  policy_id           uuid NOT NULL,
  policy_version      integer NOT NULL,
  deduplication_key   text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_from         timestamptz NOT NULL,
  window_to           timestamptz NOT NULL,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  lease_until         timestamptz,
  error_code          text,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, policy_id) REFERENCES monitor_policies(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, deduplication_key),
  CHECK (window_to > window_from)
);
CREATE INDEX monitor_runs_due_idx ON monitor_runs (next_attempt_at, created_at) WHERE status IN ('pending', 'failed', 'running');

CREATE TABLE monitor_findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL,
  policy_id           uuid NOT NULL,
  run_id              uuid NOT NULL REFERENCES monitor_runs(id) ON DELETE CASCADE,
  policy_version      integer NOT NULL,
  severity            text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  snapshot            jsonb NOT NULL,
  evidence            jsonb NOT NULL,
  notification_state  text NOT NULL CHECK (notification_state IN ('queued', 'not_configured')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, policy_id) REFERENCES monitor_policies(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, run_id)
);

CREATE TABLE automation_proposals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL,
  policy_id                 uuid NOT NULL,
  finding_id                uuid NOT NULL REFERENCES monitor_findings(id) ON DELETE CASCADE,
  kind                      text NOT NULL CHECK (kind IN ('pause', 'rollback')),
  status                    text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  target                    jsonb NOT NULL,
  payload                   jsonb NOT NULL,
  undo                      jsonb NOT NULL,
  confirmation_fingerprint  text NOT NULL CHECK (confirmation_fingerprint ~ '^[a-f0-9]{64}$'),
  proposed_by               text NOT NULL,
  reviewed_by               text,
  reviewed_at               timestamptz,
  review_rationale          text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, policy_id) REFERENCES monitor_policies(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, finding_id)
);

CREATE TABLE automation_proposal_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL,
  proposal_id uuid NOT NULL REFERENCES automation_proposals(id) ON DELETE CASCADE,
  event       text NOT NULL CHECK (event IN ('proposed', 'approved', 'rejected')),
  actor       text NOT NULL,
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE insight_feed_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  schedule_key      text NOT NULL,
  name              text NOT NULL,
  current_version   integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  next_run_at       timestamptz NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, schedule_key),
  UNIQUE (project_id, id)
);

CREATE TABLE insight_feed_schedule_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,
  schedule_id       uuid NOT NULL,
  version           integer NOT NULL CHECK (version > 0),
  env               text NOT NULL,
  metric_key        text NOT NULL,
  template_kind     text NOT NULL CHECK (template_kind = 'metric_trend'),
  window_days       integer NOT NULL CHECK (window_days BETWEEN 1 AND 365),
  timezone          text NOT NULL,
  frequency         text NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  local_time        time NOT NULL,
  weekday           integer CHECK (weekday BETWEEN 0 AND 6),
  destination_ids   uuid[] NOT NULL DEFAULT '{}',
  owner             text NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, schedule_id) REFERENCES insight_feed_schedules(project_id, id) ON DELETE CASCADE,
  UNIQUE (schedule_id, version),
  CHECK ((frequency = 'daily' AND weekday IS NULL) OR (frequency = 'weekly' AND weekday IS NOT NULL))
);
CREATE INDEX insight_feed_schedule_revisions_project_idx ON insight_feed_schedule_revisions (project_id, schedule_id, version DESC);

CREATE TABLE insight_feed_schedule_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL,
  schedule_id uuid NOT NULL,
  event       text NOT NULL CHECK (event IN ('created', 'revised', 'paused', 'resumed', 'archived')),
  actor       text NOT NULL,
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, schedule_id) REFERENCES insight_feed_schedules(project_id, id) ON DELETE CASCADE
);

CREATE TABLE insight_feed_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL,
  schedule_id         uuid NOT NULL,
  schedule_version    integer NOT NULL,
  local_run_key       text NOT NULL,
  deduplication_key   text NOT NULL,
  scheduled_for       timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     timestamptz NOT NULL,
  lease_until         timestamptz,
  error_code          text,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, schedule_id) REFERENCES insight_feed_schedules(project_id, id) ON DELETE CASCADE,
  UNIQUE (schedule_id, local_run_key),
  UNIQUE (project_id, deduplication_key)
);
CREATE INDEX insight_feed_runs_due_idx ON insight_feed_runs (next_attempt_at, created_at) WHERE status IN ('pending', 'failed', 'running');

CREATE TABLE insight_feed_snapshots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL,
  schedule_id             uuid NOT NULL,
  run_id                  uuid NOT NULL REFERENCES insight_feed_runs(id) ON DELETE CASCADE,
  resolved_window         jsonb NOT NULL,
  definition_fingerprint  text NOT NULL,
  answer                  jsonb NOT NULL,
  evidence                jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, schedule_id) REFERENCES insight_feed_schedules(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, run_id)
);

CREATE TABLE notification_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  destination_id      uuid,
  finding_id          uuid REFERENCES monitor_findings(id) ON DELETE CASCADE,
  feed_run_id         uuid REFERENCES insight_feed_runs(id) ON DELETE CASCADE,
  payload             jsonb NOT NULL,
  idempotency_key     text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'ready_for_extension', 'failed', 'dead', 'not_configured')),
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  lease_until         timestamptz,
  last_error_code     text,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, destination_id) REFERENCES notification_destinations(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, idempotency_key),
  CHECK ((finding_id IS NOT NULL)::integer + (feed_run_id IS NOT NULL)::integer = 1)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at, created_at) WHERE status IN ('pending', 'failed', 'delivering');

CREATE TABLE notification_delivery_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id   uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  attempt       integer NOT NULL CHECK (attempt > 0),
  status        text NOT NULL CHECK (status IN ('delivered', 'ready_for_extension', 'failed')),
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt)
);

CREATE TABLE notification_inbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id     uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, delivery_id)
);

CREATE TRIGGER monitor_policy_revisions_append_only BEFORE UPDATE OR DELETE ON monitor_policy_revisions FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER notification_destination_audit_append_only BEFORE UPDATE OR DELETE ON notification_destination_audit FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER monitor_policy_audit_append_only BEFORE UPDATE OR DELETE ON monitor_policy_audit FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER monitor_findings_append_only BEFORE UPDATE OR DELETE ON monitor_findings FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE FUNCTION poolstatis_protect_frozen_automation_proposal()
RETURNS trigger AS $frozen_automation_proposal$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'automation proposals cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.finding_id IS DISTINCT FROM OLD.finding_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.undo IS DISTINCT FROM OLD.undo
     OR NEW.confirmation_fingerprint IS DISTINCT FROM OLD.confirmation_fingerprint
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status <> 'proposed'
     OR NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'automation proposal target, payload, undo and review are frozen'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$frozen_automation_proposal$ LANGUAGE plpgsql;
CREATE TRIGGER automation_proposals_frozen
  BEFORE UPDATE OR DELETE ON automation_proposals
  FOR EACH ROW EXECUTE FUNCTION poolstatis_protect_frozen_automation_proposal();
CREATE TRIGGER automation_proposal_audit_append_only BEFORE UPDATE OR DELETE ON automation_proposal_audit FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER insight_feed_schedule_revisions_append_only BEFORE UPDATE OR DELETE ON insight_feed_schedule_revisions FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER insight_feed_schedule_audit_append_only BEFORE UPDATE OR DELETE ON insight_feed_schedule_audit FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER insight_feed_snapshots_append_only BEFORE UPDATE OR DELETE ON insight_feed_snapshots FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER notification_delivery_attempts_append_only BEFORE UPDATE OR DELETE ON notification_delivery_attempts FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
CREATE TRIGGER notification_inbox_append_only BEFORE UPDATE OR DELETE ON notification_inbox FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();

-- Hosted Core runs through a curated NOLOGIN role. Self-host migrations remain
-- schema-only; prepare-hosted explicitly invokes this grant function.
CREATE FUNCTION poolstatis_prepare_control_tower_automation_role_grants()
RETURNS void AS $control_tower_automation_grants$
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
      public.notification_destinations,
      public.notification_destination_audit,
      public.monitor_policies,
      public.monitor_policy_revisions,
      public.monitor_policy_audit,
      public.monitor_runs,
      public.monitor_findings,
      public.automation_proposals,
      public.automation_proposal_audit,
      public.insight_feed_schedules,
      public.insight_feed_schedule_revisions,
      public.insight_feed_schedule_audit,
      public.insight_feed_runs,
      public.insight_feed_snapshots,
      public.notification_deliveries,
      public.notification_delivery_attempts,
      public.notification_inbox
    TO poolstatis_core_runtime
  $grant$;
END
$control_tower_automation_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_control_tower_automation_role_grants()
  FROM PUBLIC;
