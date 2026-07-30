-- One lock protocol covers ingest and direct entitlement writers. The key is
-- deliberately shared with PostgresEventStore: org + meter + UTC month.
CREATE OR REPLACE FUNCTION poolstatis_validate_entitlement() RETURNS trigger AS $$
DECLARE
  period date := date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')::date;
  current_usage bigint;
  previous_threshold bigint := -1;
  threshold bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id <> OLD.org_id OR NEW.meter_key <> OLD.meter_key) THEN
    RAISE EXCEPTION 'entitlement scope cannot be changed in place' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('poolstatis:usage:%s:%s:%s',
      CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END,
      CASE WHEN TG_OP = 'DELETE' THEN OLD.meter_key ELSE NEW.meter_key END,
      period
    ), 0
  ));
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
  IF array_position(NEW.warning_thresholds, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'warning_thresholds cannot contain NULL' USING ERRCODE = '23514';
  END IF;
  FOREACH threshold IN ARRAY NEW.warning_thresholds LOOP
    IF threshold < 0 OR threshold > 9007199254740991 OR threshold <= previous_threshold THEN
      RAISE EXCEPTION 'warning_thresholds must be unique, ascending safe integers' USING ERRCODE = '23514';
    END IF;
    previous_threshold := threshold;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organization_entitlements_validate
  BEFORE INSERT OR UPDATE OR DELETE ON organization_entitlements
  FOR EACH ROW EXECUTE FUNCTION poolstatis_validate_entitlement();

ALTER TABLE organization_entitlements
  ADD CONSTRAINT organization_entitlements_hard_limit_safe
    CHECK (hard_limit IS NULL OR hard_limit <= 9007199254740991);
ALTER TABLE usage_ledger
  ADD CONSTRAINT usage_ledger_period_month_start
    CHECK (period_start = date_trunc('month', period_start)::date),
  ADD CONSTRAINT usage_ledger_quantity_safe CHECK (quantity <= 9007199254740991);
ALTER TABLE organization_usage
  ADD CONSTRAINT organization_usage_period_month_start
    CHECK (period_start = date_trunc('month', period_start)::date),
  ADD CONSTRAINT organization_usage_quantity_safe CHECK (quantity <= 9007199254740991);
ALTER TABLE usage_warnings
  ADD CONSTRAINT usage_warnings_period_month_start
    CHECK (period_start = date_trunc('month', period_start)::date),
  ADD CONSTRAINT usage_warnings_threshold_safe CHECK (threshold <= 9007199254740991),
  ADD CONSTRAINT usage_warnings_quantity_safe CHECK (quantity <= 9007199254740991);
