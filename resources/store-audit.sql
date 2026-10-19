-- Bundle-only provisioning: run by the provision_store job (task
-- create_audit_view), after every area's DDL task.
--
-- Rebuilds audit.actions (docs/data-model.md, "The audit view") as one
-- UNION ALL of every audit.<area>_branch view that the area DDL files
-- created. An area adds its branch in its own file; nothing here changes.
-- With no branches yet, it's an empty view with the right columns.
--
-- Then rebuilds monitoring.invariant_violations (docs/data-model.md,
-- "Monitoring views") the same way, from the tables that exist. Today it has
-- the display rules only: a display code or a display number on two rows of
-- one table (ADR-0007 decision 2, amended 2026-10-10). The other rules come
-- with the rest of the monitoring views (build step 5).
--
-- Parameters: :catalog_name, :schema_prefix (see store-admin.sql).
-- Refuse unsafe names before anything else runs. These two parameters name
-- the catalog and schemas, and some statements splice them into dynamic SQL,
-- so they must be plain identifiers, with the same rule the server applies
-- (src/server/delta/sql-builder.ts). A failed assert fails the job.
SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'audit');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'monitoring');

-- SQL file tasks run one statement at a time (no BEGIN … END), so the
-- branch list goes through a session variable.
DECLARE OR REPLACE VARIABLE edp_audit_branches STRING;
SET VAR edp_audit_branches = (
  SELECT nullif(array_join(array_sort(collect_list(
    'SELECT * FROM `' || replace(table_catalog, '`', '``') || '`.`' || replace(table_schema, '`', '``')
    || '`.`' || replace(table_name, '`', '``') || '`'
  )), ' UNION ALL '), '')
  FROM IDENTIFIER(:catalog_name || '.information_schema.views')
  -- Only this store's audit schema, and only views named like an area branch.
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'audit'
    AND table_name RLIKE '^[a-z][a-z0-9_]*_branch$'
);
EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`'
  || replace(:schema_prefix, '`', '``') || 'audit`.`actions` '
  || 'COMMENT \'Every action in the app: one UNION ALL of every area branch (ADR-0007).\' AS '
  || coalesce(edp_audit_branches,
    'SELECT CAST(NULL AS STRING) AS area, CAST(NULL AS STRING) AS record_type, '
    || 'CAST(NULL AS STRING) AS record_id, CAST(NULL AS STRING) AS action_id, '
    || 'CAST(NULL AS STRING) AS action, CAST(NULL AS STRING) AS changed, '
    || 'CAST(NULL AS STRING) AS from_value, CAST(NULL AS STRING) AS to_value, '
    || 'CAST(NULL AS BIGINT) AS record_version, CAST(NULL AS STRING) AS actor_principal_id, '
    || 'CAST(NULL AS STRING) AS actor_display, CAST(NULL AS STRING) AS actor_app, '
    || 'CAST(NULL AS TIMESTAMP) AS occurred_at, CAST(NULL AS STRING) AS idempotency_key, '
    || 'CAST(NULL AS STRING) AS caused_by_action_id, CAST(NULL AS STRING) AS note, '
    || 'CAST(NULL AS BOOLEAN) AS self_decision_test_mode WHERE FALSE');

-- One arm per display column of a current-state table in this store's area
-- schemas: every row whose value another row of the table also has. A new
-- area's table (access requests, #124) is covered once it exists. Names come
-- from information_schema, restricted to plain identifiers, so they can go
-- into the view's text; back-quotes are doubled anyway.
DECLARE OR REPLACE VARIABLE edp_invariant_rules STRING;
SET VAR edp_invariant_rules = (
  SELECT nullif(array_join(array_sort(collect_list(
    'SELECT \'duplicate-' || CASE column_name WHEN 'display_code' THEN 'display-code' ELSE 'display-number' END
    || '\' AS rule, \'' || replace(table_name, '`', '``') || '\' AS record_table, id AS record_id, '
    || CASE column_name WHEN 'display_code' THEN 'display_code' ELSE 'CAST(display_number AS STRING)' END
    || ' AS detail FROM (SELECT id, ' || CASE column_name WHEN 'display_code' THEN 'display_code' ELSE 'display_number' END
    || ', count(*) OVER (PARTITION BY ' || CASE column_name WHEN 'display_code' THEN 'display_code' ELSE 'display_number' END
    || ') AS copies FROM `' || replace(table_catalog, '`', '``') || '`.`' || replace(table_schema, '`', '``')
    || '`.`' || replace(table_name, '`', '``') || '` WHERE ' || CASE column_name WHEN 'display_code' THEN 'display_code' ELSE 'display_number' END
    || ' IS NOT NULL) WHERE copies > 1'
  )), ' UNION ALL '), '')
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema IN (
      :schema_prefix || 'admin', :schema_prefix || 'eir', :schema_prefix || 'onboarding',
      :schema_prefix || 'change_list', :schema_prefix || 'access_requests'
    )
    AND column_name IN ('display_code', 'display_number')
    AND table_schema RLIKE '^[A-Za-z0-9_]+$'
    AND table_name RLIKE '^[A-Za-z0-9_]+$'
);
EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`'
  || replace(:schema_prefix, '`', '``') || 'monitoring`.`invariant_violations` '
  || 'COMMENT \'One row per broken rule: the rule, the table and the record (ADR-0007). Should always be empty.\' AS '
  || coalesce(edp_invariant_rules,
    'SELECT CAST(NULL AS STRING) AS rule, CAST(NULL AS STRING) AS record_table, '
    || 'CAST(NULL AS STRING) AS record_id, CAST(NULL AS STRING) AS detail WHERE FALSE');
