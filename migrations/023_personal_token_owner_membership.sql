-- Cloud cutover: a hosted personal token must belong to a current member of
-- its organization.  Remove stale owner-bound credentials before installing
-- the FK; they were already unusable at the application layer.

DELETE FROM api_keys k
WHERE k.issued_by_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.org_id = k.org_id AND om.user_id = k.issued_by_user_id
  );

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_personal_owner_membership_fk
    FOREIGN KEY (org_id, issued_by_user_id)
    REFERENCES organization_members (org_id, user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT api_keys_issued_owner_personal_check
    CHECK (issued_by_user_id IS NULL OR kind = 'personal');
