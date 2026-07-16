-- Fair, bounded retention sweeps remember which projects were checked least
-- recently. This prevents a large early project from starving later tenants.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS projects_retention_checked_idx
  ON projects (retention_checked_at ASC NULLS FIRST, id);

-- Metadata-only parent; child partitions are scanned with CREATE INDEX
-- CONCURRENTLY and attached by ensureRetentionIndexes outside this migration.
CREATE INDEX IF NOT EXISTS events_retention_idx ON ONLY events (project_id, "timestamp");
