-- Hosted organizations must not accept writes before the external Cloud policy
-- has been provisioned. Self-host organizations have no row and remain
-- unrestricted. The external control plane activates the marker only after its
-- policy rows exist, in the same database transaction.

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

CREATE OR REPLACE FUNCTION poolstatis_organization_policy_allows_writes(
  target_org_id uuid
)
RETURNS boolean AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.organization_policy_state
    WHERE org_id = target_org_id
      AND activated_at IS NULL
  )
$$ LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE TRIGGER projects_policy_ready
  BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION poolstatis_enforce_organization_policy_ready();

CREATE TRIGGER api_keys_policy_ready
  BEFORE INSERT ON api_keys
  FOR EACH ROW EXECUTE FUNCTION poolstatis_enforce_organization_policy_ready();

CREATE TRIGGER usage_ledger_policy_ready
  BEFORE INSERT ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION poolstatis_enforce_organization_policy_ready();

REVOKE ALL ON FUNCTION poolstatis_protect_organization_policy_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_require_organization_policy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_activate_organization_policy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_backfill_organization_policy_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_enforce_organization_policy_ready() FROM PUBLIC;
REVOKE ALL ON FUNCTION poolstatis_organization_policy_allows_writes(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION poolstatis_apply_hosted_policy_role_hardening()
RETURNS void AS $role_hardening$
DECLARE
  can_manage_roles boolean;
  missing_role text;
BEGIN
  SELECT current_setting('is_superuser')::boolean OR rolcreaterole
  INTO can_manage_roles
  FROM pg_roles
  WHERE rolname = current_user;
  IF NOT can_manage_roles THEN
    RAISE EXCEPTION
      'hosted policy role hardening requires CREATEROLE; self-host may continue with HOSTED_POLICY_REQUIRED=false'
      USING ERRCODE = '42501';
  END IF;
  SELECT expected.role_name INTO missing_role
  FROM (
    VALUES
      ('poolstatis_policy_owner'),
      ('poolstatis_core_runtime'),
      ('poolstatis_policy_activator')
  ) AS expected(role_name)
  LEFT JOIN pg_roles actual ON actual.rolname = expected.role_name
  WHERE actual.oid IS NULL OR actual.rolcanlogin OR actual.rolinherit
  ORDER BY expected.role_name
  LIMIT 1;
  IF missing_role IS NOT NULL THEN
    RAISE EXCEPTION
      'hosted policy role % is missing or not NOLOGIN NOINHERIT; run the privileged role bootstrap',
      missing_role
      USING ERRCODE = '55000';
  END IF;
  IF NOT current_setting('is_superuser')::boolean
     AND NOT pg_has_role(current_user, 'poolstatis_policy_owner', 'SET') THEN
    RAISE EXCEPTION
      'hosted policy hardening requires poolstatis_policy_owner SET membership'
      USING ERRCODE = '42501';
  END IF;
  IF NOT current_setting('is_superuser')::boolean
     AND NOT EXISTS (
       SELECT 1 FROM pg_auth_members am
       JOIN pg_roles granted_role ON granted_role.oid = am.roleid
       JOIN pg_roles member_role ON member_role.oid = am.member
       WHERE granted_role.rolname IN (
         'poolstatis_core_runtime',
         'poolstatis_policy_activator'
       )
         AND member_role.rolname = current_user
         AND am.admin_option
       GROUP BY member_role.oid
       HAVING count(DISTINCT granted_role.rolname) = 2
     ) THEN
    RAISE EXCEPTION
      'hosted policy hardening requires ADMIN OPTION on Core runtime and activator roles'
      USING ERRCODE = '42501';
  END IF;

  -- Curated ordinary application DML. Security/control tables are deliberately
  -- absent: schema_migrations and organization_policy_state. Future migrations
  -- must explicitly opt new application tables into this list.
  EXECUTE $grant$
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.actor_link_audit,
      public.actor_links,
      public.agent_observations,
      public.api_keys,
      public.auth_users,
      public.billing_meters,
      public.billing_plans,
      public.decision_action_audit,
      public.decision_actions,
      public.decision_explanations,
      public.decision_revisions,
      public.decisions,
      public.entities,
      public.entity_types,
      public.evaluation_attempts,
      public.events,
      public.events_default,
      public.evidence_sets,
      public.experience_batches,
      public.experience_surfaces,
      public.experiments,
      public.feature_flags,
      public.funnels,
      public.ingest_batches,
      public.ingest_warnings,
      public.insights,
      public.measurement_contract_revisions,
      public.measurement_contracts,
      public.metrics,
      public.onboarding_acknowledgements,
      public.organization_billing,
      public.organization_entitlements,
      public.organization_members,
      public.organization_usage,
      public.organizations,
      public.projects,
      public.property_definitions,
      public.query_runs,
      public.release_revisions,
      public.releases,
      public.source_connections,
      public.usage_counters,
      public.usage_ledger,
      public.usage_warnings,
      public.webhook_delivery_attempts,
      public.webhook_destinations,
      public.webhook_outbox
    TO poolstatis_core_runtime
  $grant$;

  -- The destination owner needs CREATE only during ownership transfer.
  EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO poolstatis_policy_owner';
  EXECUTE $grant$
    GRANT SELECT ON
      public.organizations,
      public.organization_members,
      public.auth_users
    TO poolstatis_policy_owner
  $grant$;
  EXECUTE 'GRANT USAGE ON SCHEMA public TO poolstatis_core_runtime';
  EXECUTE 'GRANT USAGE ON SCHEMA public TO poolstatis_policy_activator';
  EXECUTE 'GRANT EXECUTE ON FUNCTION poolstatis_require_organization_policy(uuid) TO poolstatis_core_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION poolstatis_backfill_organization_policy_state() TO poolstatis_core_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION poolstatis_organization_policy_allows_writes(uuid) TO poolstatis_core_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION poolstatis_activate_organization_policy(uuid) TO poolstatis_policy_activator';

  EXECUTE 'ALTER FUNCTION poolstatis_protect_organization_policy_state() OWNER TO poolstatis_policy_owner';
  EXECUTE 'ALTER FUNCTION poolstatis_require_organization_policy(uuid) OWNER TO poolstatis_policy_owner';
  EXECUTE 'ALTER FUNCTION poolstatis_activate_organization_policy(uuid) OWNER TO poolstatis_policy_owner';
  EXECUTE 'ALTER FUNCTION poolstatis_backfill_organization_policy_state() OWNER TO poolstatis_policy_owner';
  EXECUTE 'ALTER FUNCTION poolstatis_enforce_organization_policy_ready() OWNER TO poolstatis_policy_owner';
  EXECUTE 'ALTER FUNCTION poolstatis_organization_policy_allows_writes(uuid) OWNER TO poolstatis_policy_owner';
  EXECUTE 'ALTER TABLE organization_policy_state OWNER TO poolstatis_policy_owner';
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM poolstatis_policy_owner';
  RETURN;
END
$role_hardening$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_apply_hosted_policy_role_hardening()
  FROM PUBLIC;

-- The deploy credential is an offline trusted owner/migrator. It is never
-- supplied to the API process; the security boundary is the distinct,
-- least-privilege Core runtime role validated at hosted startup.
