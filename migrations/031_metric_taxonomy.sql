-- Project-scoped metric taxonomy. Category is the stable "why" axis;
-- namespaced tags remain the flexible where/what axis and funnels the journey.

CREATE TABLE metric_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name        text NOT NULL CHECK (length(trim(name)) >= 1),
  description text NOT NULL CHECK (length(trim(description)) >= 10),
  domain      text NOT NULL CHECK (domain IN ('product','business','technical','custom')),
  color       text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  CHECK (
    (is_system AND domain IN ('product','business','technical'))
    OR (NOT is_system AND domain = 'custom')
  )
);

CREATE INDEX metric_categories_project_domain_idx
  ON metric_categories (project_id, domain, key);

CREATE OR REPLACE FUNCTION poolstatis_seed_system_metric_categories(target_project_id uuid)
RETURNS void AS $seed_metric_categories$
BEGIN
  INSERT INTO metric_categories (
    project_id, key, name, description, domain, color, is_system
  )
  SELECT target_project_id, seed.key, seed.name, seed.description, seed.domain, seed.color, true
  FROM (VALUES
    ('acquisition', 'Acquisition', 'Measures how people discover and enter the product.', 'product', '#2563EB'),
    ('activation', 'Activation', 'Measures the first moment a user receives meaningful product value.', 'product', '#7C3AED'),
    ('adoption', 'Adoption', 'Measures whether users begin using a capability as intended.', 'product', '#8B5CF6'),
    ('engagement', 'Engagement', 'Measures the depth and frequency of valuable product usage.', 'product', '#0D9488'),
    ('retention', 'Retention', 'Measures whether users continue receiving value over time.', 'product', '#059669'),
    ('referral', 'Referral', 'Measures users bringing other users or organizations into the product.', 'product', '#0891B2'),
    ('satisfaction', 'Satisfaction', 'Measures perceived value, usability, and user sentiment.', 'product', '#DB2777'),
    ('revenue', 'Revenue', 'Measures money earned from customers and product usage.', 'business', '#16A34A'),
    ('cost', 'Cost', 'Measures money or compute spent to deliver product outcomes.', 'business', '#EA580C'),
    ('efficiency', 'Efficiency', 'Measures business output relative to time, money, or capacity.', 'business', '#CA8A04'),
    ('quality', 'Quality', 'Measures whether product behavior meets its intended standard.', 'technical', '#4F46E5'),
    ('reliability', 'Reliability', 'Measures availability, errors, and continuity of service.', 'technical', '#DC2626'),
    ('performance', 'Performance', 'Measures latency, throughput, and resource saturation.', 'technical', '#D97706'),
    ('delivery', 'Delivery', 'Measures the speed and stability of software delivery.', 'technical', '#9333EA'),
    ('security', 'Security', 'Measures protection from unauthorized access, abuse, and exposure.', 'technical', '#B91C1C'),
    ('data_quality', 'Data quality', 'Measures completeness, validity, consistency, and freshness of data.', 'technical', '#475569')
  ) AS seed(key, name, description, domain, color)
  ON CONFLICT (project_id, key) DO NOTHING;
END
$seed_metric_categories$
LANGUAGE plpgsql;

SELECT poolstatis_seed_system_metric_categories(id)
FROM projects;

CREATE OR REPLACE FUNCTION poolstatis_seed_metric_categories_after_project_insert()
RETURNS trigger AS $seed_new_project_metric_categories$
BEGIN
  PERFORM poolstatis_seed_system_metric_categories(NEW.id);
  RETURN NEW;
END
$seed_new_project_metric_categories$
LANGUAGE plpgsql;

CREATE TRIGGER projects_seed_metric_categories
  AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION poolstatis_seed_metric_categories_after_project_insert();

CREATE OR REPLACE FUNCTION poolstatis_protect_metric_category_semantics()
RETURNS trigger AS $protect_metric_category_semantics$
DECLARE
  parent_project_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A parent project is already invisible when PostgreSQL runs its child
    -- ON DELETE CASCADE. Direct category deletion still sees the project.
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.projects WHERE id = $1)',
      TG_TABLE_SCHEMA
    ) INTO parent_project_exists USING OLD.project_id;
    IF OLD.is_system AND parent_project_exists THEN
      RAISE EXCEPTION 'system metric category semantics are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_system THEN
    RAISE EXCEPTION 'system metric category semantics are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'metric category identity is immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$protect_metric_category_semantics$
LANGUAGE plpgsql;

CREATE TRIGGER metric_categories_semantics_immutable
  BEFORE UPDATE OR DELETE ON metric_categories
  FOR EACH ROW EXECUTE FUNCTION poolstatis_protect_metric_category_semantics();

ALTER TABLE metrics DROP CONSTRAINT metrics_category_check;
ALTER TABLE metrics
  ADD CONSTRAINT metrics_category_project_fk
  FOREIGN KEY (project_id, category)
  REFERENCES metric_categories(project_id, key)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

-- Hosted runtime roles are deliberately curated instead of inheriting future
-- tables. prepare-hosted invokes this after the NOLOGIN role exists.
CREATE FUNCTION poolstatis_prepare_metric_taxonomy_role_grants()
RETURNS void AS $metric_taxonomy_grants$
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
  EXECUTE $grant$
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.metric_categories
    TO poolstatis_core_runtime
  $grant$;
END
$metric_taxonomy_grants$
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION poolstatis_prepare_metric_taxonomy_role_grants() FROM PUBLIC;

-- Rollback is operator-driven because migrations are forward-only: remove the
-- FK/trigger/functions/table only after proving no metric uses a newly valid key
-- and after restoring the legacy category CHECK.
