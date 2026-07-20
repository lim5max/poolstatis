-- Encrypted webhook destinations and a restart-safe delivery outbox.

CREATE TABLE webhook_destinations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  name              text NOT NULL,
  destination_ciphertext bytea NOT NULL,
  destination_iv    bytea NOT NULL,
  destination_tag   bytea NOT NULL,
  masked_url        text NOT NULL,
  status            text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'verified', 'error', 'disabled')),
  last_error        text,
  verified_at       timestamptz,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX webhook_destinations_project_idx
  ON webhook_destinations (project_id, created_at);

CREATE TABLE webhook_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  destination_id    uuid NOT NULL REFERENCES webhook_destinations(id),
  action_id         uuid REFERENCES decision_actions(id),
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  idempotency_key   text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX webhook_outbox_due_idx
  ON webhook_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE webhook_delivery_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  outbox_id       uuid NOT NULL REFERENCES webhook_outbox(id),
  attempt         integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('delivered', 'failed')),
  response_status integer,
  error_code      text,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, attempt)
);
CREATE INDEX webhook_delivery_attempts_project_idx
  ON webhook_delivery_attempts (project_id, outbox_id, attempt);

CREATE TRIGGER webhook_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON webhook_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_immutable_mutation();
