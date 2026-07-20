-- Durable, bounded release evaluation attempts. One row is retried for one
-- frozen release observation window; evidence itself remains append-only.

CREATE TABLE evaluation_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  release_id         uuid NOT NULL REFERENCES releases(id),
  window_key         text NOT NULL,
  status             text NOT NULL CHECK (status IN ('running', 'waiting', 'failed', 'succeeded')),
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  reason             text,
  error_code         text,
  evidence_window    jsonb NOT NULL,
  evidence_id        uuid REFERENCES evidence_sets(id),
  decision_id        uuid REFERENCES decisions(id),
  scheduled_at       timestamptz NOT NULL,
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, release_id, window_key)
);
CREATE INDEX evaluation_attempts_due_idx
  ON evaluation_attempts (status, scheduled_at)
  WHERE status IN ('waiting', 'failed');
CREATE INDEX evaluation_attempts_release_idx
  ON evaluation_attempts (project_id, release_id, created_at DESC);
