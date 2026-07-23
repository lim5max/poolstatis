-- This lock deliberately has no billing-period component. An entitlement is
-- global configuration, so a transaction that crosses UTC rollover must still
-- serialize with the next month's ingest before either side reads a quota.
CREATE OR REPLACE FUNCTION poolstatis_usage_config_lock_key(p_org uuid, p_meter text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT hashtextextended('poolstatis:usage-config:' || p_org::text || ':' || p_meter, 0)
$$;

CREATE OR REPLACE FUNCTION poolstatis_valid_warning_thresholds(p_thresholds bigint[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  previous_threshold bigint := -1;
  threshold bigint;
BEGIN
  IF p_thresholds IS NULL THEN
    RETURN FALSE;
  END IF;
  FOREACH threshold IN ARRAY p_thresholds LOOP
    IF threshold IS NULL
      OR threshold < 0
      OR threshold > 9007199254740991
      OR threshold <= previous_threshold THEN
      RETURN FALSE;
    END IF;
    previous_threshold := threshold;
  END LOOP;
  RETURN TRUE;
END;
$$;

-- Migration 024 allowed malformed arrays and a cap lower than current usage.
-- Fail before installing the permanent CHECK so operators get a deterministic,
-- recoverable diagnostic instead of a partially upgraded runtime.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM organization_entitlements
    WHERE NOT poolstatis_valid_warning_thresholds(warning_thresholds)
  ) THEN
    RAISE EXCEPTION 'invalid existing warning_thresholds; repair entitlement rows before migration'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM organization_entitlements entitlement
    LEFT JOIN organization_usage usage
      ON usage.org_id = entitlement.org_id
     AND usage.meter_key = entitlement.meter_key
     AND usage.period_start = date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date
    WHERE entitlement.hard_limit IS NOT NULL
      AND entitlement.hard_limit < COALESCE(usage.quantity, 0)
  ) THEN
    RAISE EXCEPTION 'existing hard_limit is below current UTC-month usage; repair entitlement rows before migration'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE organization_entitlements
  ADD CONSTRAINT organization_entitlements_warning_thresholds_valid
    CHECK (poolstatis_valid_warning_thresholds(warning_thresholds)) NOT VALID;
ALTER TABLE organization_entitlements
  VALIDATE CONSTRAINT organization_entitlements_warning_thresholds_valid;

CREATE OR REPLACE FUNCTION poolstatis_validate_entitlement() RETURNS trigger AS $$
DECLARE
  period date;
  scope_org uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  scope_meter text := CASE WHEN TG_OP = 'DELETE' THEN OLD.meter_key ELSE NEW.meter_key END;
  scope text := format('%s:%s', scope_org, scope_meter);
  previous_scope text := NULLIF(current_setting('poolstatis.usage_entitlement_scope', true), '');
  current_usage bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.meter_key IS DISTINCT FROM OLD.meter_key) THEN
    RAISE EXCEPTION 'entitlement scope cannot be changed in place' USING ERRCODE = '23514';
  END IF;
  -- A row trigger cannot sort future DML scopes. Enforce the hosted control
  -- contract instead, before waiting for any second config lock.
  IF previous_scope IS NOT NULL AND previous_scope <> scope THEN
    RAISE EXCEPTION 'an entitlement transaction may change only one organization and meter scope'
      USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('poolstatis.usage_entitlement_scope', scope, true);
  PERFORM pg_advisory_xact_lock(poolstatis_usage_config_lock_key(scope_org, scope_meter));
  period := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT quantity INTO current_usage
  FROM organization_usage
  WHERE org_id = NEW.org_id AND meter_key = NEW.meter_key AND period_start = period;
  IF NEW.hard_limit IS NOT NULL AND NEW.hard_limit < COALESCE(current_usage, 0) THEN
    RAISE EXCEPTION 'hard_limit cannot be below current UTC-month usage'
      USING ERRCODE = '23514';
  END IF;
  IF NOT poolstatis_valid_warning_thresholds(NEW.warning_thresholds) THEN
    RAISE EXCEPTION 'warning_thresholds must be unique, ascending safe integers' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
