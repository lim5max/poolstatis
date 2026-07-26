-- Surface recency is shown in the customer admin. Keep the aggregate bounded
-- by tenant, environment and surface without coupling the UI to event SQL.
CREATE INDEX events_experience_surface_time_idx
  ON ONLY events (project_id, env, (properties->>'surface'), "timestamp" DESC)
  WHERE event_source = 'experience';
