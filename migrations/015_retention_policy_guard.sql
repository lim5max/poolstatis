DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE retention_months < 1) THEN
    RAISE EXCEPTION 'retention_months must be at least 1 before applying the safety constraint';
  END IF;
END $$;

ALTER TABLE projects
  ADD CONSTRAINT projects_retention_months_positive CHECK (retention_months >= 1);
