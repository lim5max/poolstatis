-- Project deletion is an explicit owner/admin action. Every project-owned row
-- must follow the project so a successful delete cannot leave tenant data or
-- credentials behind.

SET LOCAL lock_timeout = '5s';

DO $project_cascades$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT
      conrelid::regclass AS table_name,
      conname AS constraint_name,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'projects'::regclass
      AND confdeltype <> 'c'
    ORDER BY conrelid::regclass::text, conname
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      constraint_row.table_name,
      constraint_row.constraint_name
    );
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I %s ON DELETE CASCADE',
      constraint_row.table_name,
      constraint_row.constraint_name,
      constraint_row.definition
    );
  END LOOP;
END
$project_cascades$;

-- These high-volume/idempotency tables predate project foreign keys. Add the
-- same ownership boundary so concurrent/in-flight writes cannot create orphan
-- rows after a project is deleted.
ALTER TABLE events
  ADD CONSTRAINT events_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ingest_batches
  ADD CONSTRAINT ingest_batches_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE experience_batches
  ADD CONSTRAINT experience_batches_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Audit rows remain append-only during ordinary use. Cascading removal is
-- allowed only after their owning project has been deleted by PostgreSQL.
CREATE OR REPLACE FUNCTION poolstatis_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (
       SELECT 1 FROM projects WHERE id = OLD.project_id
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION poolstatis_usage_ledger_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (
       SELECT 1 FROM projects WHERE id = OLD.project_id
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'usage_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
