-- Generic, self-host-compatible accepted-event metering. Billing policy lives
-- outside this source-available core; an absent entitlement means unlimited.
CREATE TABLE organization_entitlements (
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key          text NOT NULL CHECK (meter_key = 'events_stored'),
  hard_limit         bigint CHECK (hard_limit IS NULL OR hard_limit >= 0),
  warning_thresholds bigint[] NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter_key),
  CHECK (cardinality(warning_thresholds) IS NULL OR cardinality(warning_thresholds) <= 16)
);

CREATE TABLE usage_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  project_id    uuid NOT NULL,
  env           text NOT NULL,
  meter_key     text NOT NULL CHECK (meter_key = 'events_stored'),
  period_start  date NOT NULL,
  quantity      bigint NOT NULL CHECK (quantity > 0),
  source_batch  text NOT NULL,
  dedupe_key    text NOT NULL,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_ledger_org_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id)
);
CREATE INDEX usage_ledger_org_period_idx ON usage_ledger (org_id, meter_key, period_start, ingested_at);
CREATE INDEX usage_ledger_project_env_idx ON usage_ledger (project_id, env, meter_key, period_start);

CREATE TABLE organization_usage (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key     text NOT NULL CHECK (meter_key = 'events_stored'),
  period_start  date NOT NULL,
  quantity      bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter_key, period_start)
);

CREATE TABLE usage_warnings (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key     text NOT NULL CHECK (meter_key = 'events_stored'),
  period_start  date NOT NULL,
  threshold     bigint NOT NULL CHECK (threshold >= 0),
  quantity      bigint NOT NULL CHECK (quantity >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter_key, period_start, threshold)
);

CREATE OR REPLACE FUNCTION poolstatis_usage_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usage_ledger_append_only
  BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION poolstatis_usage_ledger_append_only();
