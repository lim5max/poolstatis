-- Self-host entitlement changes need durable authorship and optimistic read-back.
-- Hosted billing/operator policy remains outside Core and does not use this API audit.

ALTER TABLE organization_entitlements
  ADD COLUMN configuration_revision integer NOT NULL DEFAULT 0
  CHECK (configuration_revision >= 0);

-- Existing configuration predates authored audit. Mark it as revision 1
-- without inventing an actor; the first API change will append revision 2.
-- Migration 026 deliberately rejects multiple entitlement scopes in one
-- transaction. Reset its transaction-local scope before each single-scope
-- backfill so existing multi-organization installations can upgrade without
-- weakening the runtime guard.
DO $usage_entitlement_backfill$
DECLARE
  entitlement record;
BEGIN
  FOR entitlement IN
    SELECT org_id, meter_key
    FROM organization_entitlements
    WHERE hard_limit IS NOT NULL OR cardinality(warning_thresholds) > 0
    ORDER BY org_id, meter_key
  LOOP
    PERFORM set_config('poolstatis.usage_entitlement_scope', '', true);
    UPDATE organization_entitlements
    SET configuration_revision = 1
    WHERE org_id = entitlement.org_id
      AND meter_key = entitlement.meter_key;
  END LOOP;
  PERFORM set_config('poolstatis.usage_entitlement_scope', '', true);
END
$usage_entitlement_backfill$;

CREATE OR REPLACE FUNCTION poolstatis_advance_usage_entitlement_revision()
RETURNS trigger AS $usage_entitlement_revision$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.configuration_revision := COALESCE((
      SELECT max(revision) FROM usage_entitlement_revisions
      WHERE org_id = NEW.org_id AND meter_key = NEW.meter_key
    ), 0) + 1;
  ELSIF NEW.hard_limit IS DISTINCT FROM OLD.hard_limit
     OR NEW.warning_thresholds IS DISTINCT FROM OLD.warning_thresholds THEN
    NEW.configuration_revision := OLD.configuration_revision + 1;
  ELSE
    NEW.configuration_revision := OLD.configuration_revision;
  END IF;
  RETURN NEW;
END
$usage_entitlement_revision$
LANGUAGE plpgsql;

CREATE TRIGGER organization_entitlements_advance_revision
  BEFORE INSERT OR UPDATE ON organization_entitlements
  FOR EACH ROW EXECUTE FUNCTION poolstatis_advance_usage_entitlement_revision();

CREATE TABLE usage_entitlement_revisions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key                   text NOT NULL CHECK (meter_key = 'events_stored'),
  revision                    integer NOT NULL CHECK (revision > 0),
  actor                       text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  reason                      text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  previous_hard_limit         bigint CHECK (previous_hard_limit IS NULL OR previous_hard_limit >= 0),
  hard_limit                  bigint CHECK (hard_limit IS NULL OR hard_limit >= 0),
  previous_warning_thresholds bigint[] NOT NULL,
  warning_thresholds          bigint[] NOT NULL,
  current_usage               bigint NOT NULL CHECK (current_usage >= 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, meter_key, revision),
  CHECK (poolstatis_valid_warning_thresholds(previous_warning_thresholds)),
  CHECK (poolstatis_valid_warning_thresholds(warning_thresholds))
);

CREATE INDEX usage_entitlement_revisions_scope_idx
  ON usage_entitlement_revisions (org_id, meter_key, revision DESC);

CREATE OR REPLACE FUNCTION poolstatis_reject_usage_entitlement_revision_mutation()
RETURNS trigger AS $usage_entitlement_revision_immutable$
BEGIN
  -- Allow only the parent organization FK cascade. Direct deletes and every
  -- update remain forbidden so configuration read-back is attributable.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'usage_entitlement_revisions rows are append-only' USING ERRCODE = '55000';
END
$usage_entitlement_revision_immutable$
LANGUAGE plpgsql;

CREATE TRIGGER usage_entitlement_revisions_immutable
  BEFORE UPDATE OR DELETE ON usage_entitlement_revisions
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_usage_entitlement_revision_mutation();

CREATE OR REPLACE FUNCTION poolstatis_reject_usage_entitlement_delete()
RETURNS trigger AS $usage_entitlement_delete_guard$
BEGIN
  -- A parent-organization cascade is the only valid physical deletion. Direct
  -- deletes would erase the current configuration without advancing revision.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'organization_entitlements rows cannot be deleted directly' USING ERRCODE = '55000';
END
$usage_entitlement_delete_guard$
LANGUAGE plpgsql;

CREATE TRIGGER organization_entitlements_reject_direct_delete
  BEFORE DELETE ON organization_entitlements
  FOR EACH ROW EXECUTE FUNCTION poolstatis_reject_usage_entitlement_delete();

-- The hosted Core runtime never receives INSERT/UPDATE on the audit table: its
-- customer endpoint is fail-closed. SELECT is still required by the entitlement
-- revision trigger when the hosted control plane creates a previously absent row.
CREATE FUNCTION poolstatis_prepare_usage_entitlement_role_grants()
RETURNS void AS $usage_entitlement_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'poolstatis_core_runtime'
      AND NOT rolcanlogin
      AND NOT rolinherit
  ) THEN
    RAISE EXCEPTION
      'hosted policy role poolstatis_core_runtime is missing or not NOLOGIN NOINHERIT; run the privileged role bootstrap'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE 'GRANT SELECT ON TABLE public.usage_entitlement_revisions TO poolstatis_core_runtime';
END
$usage_entitlement_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_usage_entitlement_role_grants()
  FROM PUBLIC;

-- Rollback is operator-driven and forward-only: deploy a binary that no longer
-- reads this contract, then drop both triggers/functions, the audit index/table
-- and the configuration_revision column.
