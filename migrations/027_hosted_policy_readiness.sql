-- Hosted organizations must not accept writes before the external Cloud policy
-- has been provisioned. Self-host organizations have no row and remain
-- unrestricted. The external control plane activates the marker only after its
-- policy rows exist, in the same database transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poolstatis_policy_owner') THEN
    CREATE ROLE poolstatis_policy_owner NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poolstatis_core_runtime') THEN
    CREATE ROLE poolstatis_core_runtime NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poolstatis_policy_activator') THEN
    CREATE ROLE poolstatis_policy_activator NOLOGIN NOINHERIT;
  END IF;
  -- Make pre-created roles converge on the same cross-repository contract.
  ALTER ROLE poolstatis_policy_owner NOLOGIN NOINHERIT;
  ALTER ROLE poolstatis_core_runtime NOLOGIN NOINHERIT;
  ALTER ROLE poolstatis_policy_activator NOLOGIN NOINHERIT;
  EXECUTE format('GRANT poolstatis_policy_owner TO %I', current_user);
END
$$;

CREATE TABLE organization_policy_state (
  org_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  required_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  CHECK (activated_at IS NULL OR activated_at >= required_at)
);

REVOKE ALL ON organization_policy_state FROM PUBLIC;

CREATE OR REPLACE FUNCTION poolstatis_protect_organization_policy_state()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.org_id) THEN
      RAISE EXCEPTION 'organization policy markers cannot be deleted directly' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.required_at IS DISTINCT FROM OLD.required_at
     OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
     OR (OLD.activated_at IS NULL AND NEW.activated_at IS NULL) THEN
    RAISE EXCEPTION 'organization policy markers are one-way' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE TRIGGER organization_policy_state_one_way
  BEFORE UPDATE OR DELETE ON organization_policy_state
  FOR EACH ROW EXECUTE FUNCTION poolstatis_protect_organization_policy_state();

CREATE OR REPLACE FUNCTION poolstatis_require_organization_policy(target_org_id uuid)
RETURNS boolean AS $$
BEGIN
  INSERT INTO public.organization_policy_state (org_id)
  VALUES (target_org_id)
  ON CONFLICT (org_id) DO NOTHING;
  RETURN true;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION poolstatis_activate_organization_policy(target_org_id uuid)
RETURNS boolean AS $$
BEGIN
  UPDATE public.organization_policy_state
  SET activated_at = COALESCE(activated_at, clock_timestamp())
  WHERE org_id = target_org_id;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION poolstatis_backfill_organization_policy_state()
RETURNS bigint AS $$
DECLARE inserted_count bigint;
BEGIN
  INSERT INTO public.organization_policy_state (org_id)
  SELECT DISTINCT om.org_id
  FROM public.organization_members om
  JOIN public.auth_users au ON au.id = om.user_id
  WHERE au.identity_issuer IS NOT NULL
  ON CONFLICT (org_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION poolstatis_enforce_organization_policy_ready()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.organization_policy_state
    WHERE org_id = NEW.org_id AND activated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'organization policy is not ready' USING ERRCODE = 'PSO01';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

ALTER FUNCTION poolstatis_protect_organization_policy_state() OWNER TO poolstatis_policy_owner;
ALTER FUNCTION poolstatis_require_organization_policy(uuid) OWNER TO poolstatis_policy_owner;
ALTER FUNCTION poolstatis_activate_organization_policy(uuid) OWNER TO poolstatis_policy_owner;
ALTER FUNCTION poolstatis_backfill_organization_policy_state() OWNER TO poolstatis_policy_owner;
ALTER FUNCTION poolstatis_enforce_organization_policy_ready() OWNER TO poolstatis_policy_owner;
ALTER TABLE organization_policy_state OWNER TO poolstatis_policy_owner;

GRANT USAGE ON SCHEMA public TO poolstatis_policy_owner;
GRANT SELECT ON public.organizations, public.organization_members, public.auth_users
  TO poolstatis_policy_owner;

REVOKE ALL ON FUNCTION poolstatis_protect_organization_policy_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_require_organization_policy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_activate_organization_policy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_backfill_organization_policy_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_enforce_organization_policy_ready() FROM PUBLIC;

-- The Core runtime role may require and backfill markers. The separate stable
-- activator group owns no data and can only execute the one-way activation
-- function. A private deploy migrator uses ADMIN OPTION to grant that group to
-- its restricted Cloud runtime without needing function ownership or raw table
-- privileges.
GRANT USAGE ON SCHEMA public TO poolstatis_core_runtime;
GRANT EXECUTE ON FUNCTION poolstatis_require_organization_policy(uuid)
  TO poolstatis_core_runtime;
GRANT EXECUTE ON FUNCTION poolstatis_backfill_organization_policy_state()
  TO poolstatis_core_runtime;
GRANT USAGE ON SCHEMA public TO poolstatis_policy_activator;
GRANT EXECUTE ON FUNCTION poolstatis_activate_organization_policy(uuid)
  TO poolstatis_policy_activator;

DO $$
BEGIN
  -- Single-user/self-host installs run migrations and serve with one role.
  -- Split production installs grant this stable runtime role to the restricted
  -- Core login instead.
  EXECUTE format('GRANT poolstatis_core_runtime TO %I', current_user);
  -- The same non-superuser deploy migrator can later grant only activator
  -- membership to the private Cloud runtime.
  EXECUTE format(
    'GRANT poolstatis_policy_activator TO %I WITH ADMIN OPTION',
    current_user
  );
  EXECUTE format('REVOKE poolstatis_policy_owner FROM %I', current_user);
END
$$;

CREATE TRIGGER projects_policy_ready
  BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION poolstatis_enforce_organization_policy_ready();

CREATE TRIGGER api_keys_policy_ready
  BEFORE INSERT ON api_keys
  FOR EACH ROW EXECUTE FUNCTION poolstatis_enforce_organization_policy_ready();

CREATE TRIGGER usage_ledger_policy_ready
  BEFORE INSERT ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION poolstatis_enforce_organization_policy_ready();
