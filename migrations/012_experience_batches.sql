-- Source classification distinguishes typed Browser Experience capture from
-- generic ingest. It is provenance, not a claim that a public ingest key is a
-- security boundary.
ALTER TABLE events ADD COLUMN event_source text NOT NULL DEFAULT 'ingest'
  CHECK (event_source IN ('ingest', 'experience', 'system'));
CREATE INDEX events_experience_source_idx
  ON events (project_id, env, session_id, "timestamp")
  WHERE event_source = 'experience';

-- A BrowserExperience batch keeps the same id across transport retries, so a
-- successful append followed by a lost response cannot double-count clicks.
CREATE TABLE experience_batches (
  project_id   uuid NOT NULL,
  env          text NOT NULL,
  batch_id     text NOT NULL,
  status       text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error   text,
  PRIMARY KEY (project_id, env, batch_id)
);
