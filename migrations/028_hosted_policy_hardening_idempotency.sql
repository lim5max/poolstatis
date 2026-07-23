-- Re-running hosted preparation must recognize the exact hardened state left
-- by migration 027. The offline migrator has SET membership in the NOLOGIN
-- policy owner, but deliberately does not inherit owner privileges.

CREATE OR REPLACE FUNCTION poolstatis_prepare_hosted_policy_role_hardening()
RETURNS void AS $hosted_prepare$
DECLARE
  policy_owned_count integer;
  deploy_owned_count integer;
  marker_owner text;
BEGIN
  SELECT
    count(*) FILTER (
      WHERE pg_get_userbyid(proowner) = 'poolstatis_policy_owner'
    ),
    count(*) FILTER (
      WHERE pg_get_userbyid(proowner) = current_user
    )
  INTO policy_owned_count, deploy_owned_count
  FROM pg_proc
  WHERE oid IN (
    'poolstatis_protect_organization_policy_state()'::regprocedure,
    'poolstatis_require_organization_policy(uuid)'::regprocedure,
    'poolstatis_activate_organization_policy(uuid)'::regprocedure,
    'poolstatis_backfill_organization_policy_state()'::regprocedure,
    'poolstatis_enforce_organization_policy_ready()'::regprocedure,
    'poolstatis_organization_policy_allows_writes(uuid)'::regprocedure
  );

  SELECT pg_get_userbyid(relowner)
  INTO marker_owner
  FROM pg_class
  WHERE oid = 'organization_policy_state'::regclass;

  IF deploy_owned_count = 6 AND marker_owner = current_user THEN
    PERFORM poolstatis_apply_hosted_policy_role_hardening();
    RETURN;
  END IF;

  IF policy_owned_count <> 6
     OR marker_owner <> 'poolstatis_policy_owner'
     OR has_schema_privilege(
       'poolstatis_policy_owner',
       'public',
       'CREATE'
     )
     OR NOT has_function_privilege(
       'poolstatis_core_runtime',
       'poolstatis_require_organization_policy(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'poolstatis_core_runtime',
       'poolstatis_backfill_organization_policy_state()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'poolstatis_core_runtime',
       'poolstatis_organization_policy_allows_writes(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'poolstatis_policy_activator',
       'poolstatis_activate_organization_policy(uuid)',
       'EXECUTE'
     )
     OR NOT has_table_privilege(
       'poolstatis_core_runtime',
       'projects',
       'INSERT'
     )
     OR NOT has_table_privilege(
       'poolstatis_core_runtime',
       'events',
       'INSERT'
     )
     OR has_table_privilege(
       'poolstatis_core_runtime',
       'organization_policy_state',
       'SELECT'
     ) THEN
    RAISE EXCEPTION
      'hosted policy hardening topology is unsafe'
      USING ERRCODE = '55000';
  END IF;
END
$hosted_prepare$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_hosted_policy_role_hardening()
  FROM PUBLIC;
