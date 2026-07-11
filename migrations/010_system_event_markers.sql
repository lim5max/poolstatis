-- A trusted marker that cannot be set through the public ingest API. Some
-- platform-generated events (for example experiment exposures) must remain
-- distinguishable from lookalike user events with the same name/properties.
ALTER TABLE events ADD COLUMN is_system boolean NOT NULL DEFAULT false;

CREATE INDEX events_system_exposure_idx
  ON events (project_id, env, (properties->>'flag_key'), distinct_id, "timestamp")
  WHERE event = '$feature_flag_called' AND is_system;
