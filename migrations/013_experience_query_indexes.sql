-- Browser Experience maps filter by surface before grouping clicks. Keeping
-- the expression in the index avoids scanning every experience event for a
-- busy tenant and retains time ordering for bounded date windows.
CREATE INDEX events_experience_click_surface_time_idx
  ON ONLY events (project_id, env, (properties->>'surface'), "timestamp" DESC)
  WHERE event_source = 'experience' AND event = 'experience.element_clicked';

-- Session timelines are read by tenant, environment, session and surface,
-- then ordered chronologically. This remains implementable behind EventStore
-- and does not expose SQL to clients.
CREATE INDEX events_experience_session_surface_time_idx
  ON ONLY events (project_id, env, session_id, (properties->>'surface'), "timestamp")
  WHERE event_source = 'experience';
