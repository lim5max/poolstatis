-- Cloud cutover: a hosted personal token must belong to a current member of
-- its organization. Any legacy rows must be reviewed and cleaned explicitly
-- with `pnpm preflight:migration-023` before generic migration execution.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM api_keys k
    WHERE (k.kind <> 'personal' AND k.issued_by_user_id IS NOT NULL)
       OR (k.kind = 'personal' AND k.issued_by_user_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM organization_members om
         WHERE om.org_id = k.org_id AND om.user_id = k.issued_by_user_id
       ))
  ) THEN
    RAISE EXCEPTION 'migration 023 preflight required: run pnpm preflight:migration-023 --report, verify backup, then acknowledged cleanup';
  END IF;
END $$;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_personal_owner_membership_fk
    FOREIGN KEY (org_id, issued_by_user_id)
    REFERENCES organization_members (org_id, user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT api_keys_issued_owner_personal_check
    CHECK (issued_by_user_id IS NULL OR kind = 'personal');
