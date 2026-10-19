-- Bundle-only provisioning: run by the provision_store job (task create_admin_tables).
--
-- The `admin` area of the ADR-0007 data model (docs/data-model.md):
--   * admin.display_counters  one row per display prefix (ADR-0007 decision 2)
--   * admin.write_checks      the write-check area, the trivial command that
--   * admin.write_check_actions  proves the Delta write path end to end (#76)
--   * audit.admin_branch      this area's branch of audit.actions
--
-- One file per area: an area ticket adds its own resources/store-<area>.sql
-- and its own job task, and never edits this file. Every statement is
-- idempotent, so the job can be re-run.
--
-- Parameters:
--   :catalog_name   the store catalog (bundle var store_catalog)
--   :schema_prefix  '' in production; a preview's own prefix (e.g.
--                   'edp_vm_pr130_') so it keeps its own schemas in a shared catalog
-- Refuse unsafe names before anything else runs. These two parameters name
-- the catalog and schemas, and some statements splice them into dynamic SQL,
-- so they must be plain identifiers, with the same rule the server applies
-- (src/server/delta/sql-builder.ts). A failed assert fails the job.
SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'audit');

-- Display counters: the creating write moves next_number up by one in the
-- same transaction. Not an identity column: those block concurrent writers.
-- Only change-list entries (CL) take numbers since display codes (#177); EIRs and
-- onboarding requests take display codes, and write checks nothing
-- (ADR-0007 decision 2, amended). Unused rows are later cleanup.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters') (
  prefix STRING NOT NULL COMMENT 'Display prefix without the dash: CL (EIR, ONB and WC rows are no longer taken from)',
  next_number BIGINT NOT NULL COMMENT 'The number the next record with this prefix gets',
  updated_at TIMESTAMP NOT NULL COMMENT 'When a number was last taken',
  CONSTRAINT display_counters_pk PRIMARY KEY (prefix)
)
COMMENT 'One row per display prefix; the next display number for records people talk about (ADR-0007 decision 2).'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

-- Write checks: a current-state table and its action table, in the shared
-- column patterns. EDP staff record a check and confirm it; nothing else
-- depends on them.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_checks') (
  id STRING NOT NULL COMMENT 'UUID the server generated',
  display_number BIGINT COMMENT 'WC-<n> on write checks made before display codes (#177); null on newer ones, which have no display number',
  label STRING NOT NULL COMMENT 'What the person typed to identify the check',
  stage STRING NOT NULL COMMENT 'recorded or confirmed',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every change',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT write_checks_pk PRIMARY KEY (id)
)
COMMENT 'One row per write check: proof that a command reached Delta through the server (#76).'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_check_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  write_check_id STRING NOT NULL COMMENT 'The write check acted on',
  action STRING NOT NULL COMMENT 'recorded or confirmed',
  from_stage STRING,
  to_stage STRING,
  record_version BIGINT NOT NULL COMMENT 'The write check\'s version after this action',
  actor_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session, or system',
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL COMMENT 'tenant, staff, job or system (ADR-0008)',
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING,
  command STRING COMMENT 'Lead actions: the validated command as JSON',
  command_hash STRING COMMENT 'Lead actions: SHA-256 of command',
  expected_effects STRING COMMENT 'Lead actions: JSON list of the rows the write produced',
  result STRING COMMENT 'Lead actions: the response row as JSON, returned again on a replay of the key',
  CONSTRAINT write_check_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on a write check. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true');

-- Migrations: columns added after a table was first provisioned. CREATE TABLE
-- IF NOT EXISTS leaves an existing table as it was, and Databricks SQL has no
-- ADD COLUMN IF NOT EXISTS, so each added column is added here only when
-- information_schema says it's missing; re-running is a no-op. Every column
-- missing from a table's first shape needs one of these
-- (src/server/delta/__tests__/ddl-files.test.ts checks).
DECLARE OR REPLACE VARIABLE edp_migrate_write_check_actions_result STRING;
SET VAR edp_migrate_write_check_actions_result = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'admin`.`write_check_actions` '
      || 'ADD COLUMN result STRING COMMENT \'Lead actions: the response row as JSON, returned again on a replay of the key\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'admin'
    AND table_name = 'write_check_actions'
    AND column_name = 'result'
);
EXECUTE IMMEDIATE edp_migrate_write_check_actions_result;

-- Write checks have no display number since display codes (#177; ADR-0007 decision
-- 2, amended). DROP NOT NULL on a nullable column is a no-op.
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_checks') ALTER COLUMN display_number DROP NOT NULL;

-- Enums are CHECK constraints. Delta has no ADD CONSTRAINT IF NOT EXISTS, so
-- each is dropped and re-added; re-adding validates the existing rows.
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_checks') DROP CONSTRAINT IF EXISTS write_checks_stage;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_checks') ADD CONSTRAINT write_checks_stage CHECK (stage IN ('recorded', 'confirmed'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_check_actions') DROP CONSTRAINT IF EXISTS write_check_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_check_actions') ADD CONSTRAINT write_check_actions_action CHECK (action IN ('recorded', 'confirmed'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_check_actions') DROP CONSTRAINT IF EXISTS write_check_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.write_check_actions') ADD CONSTRAINT write_check_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));

-- Each area seeds its own prefixes.
INSERT INTO IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters')
SELECT 'WC', 1001, current_timestamp()
WHERE NOT EXISTS (SELECT 1 FROM IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters') WHERE prefix = 'WC');

-- This area's branch of audit.actions. store-audit.sql unions every
-- audit.*_branch view, so the columns and their order are fixed:
-- area, record_type, record_id, action_id, action, changed, from_value,
-- to_value, record_version, actor_principal_id, actor_display, actor_app,
-- occurred_at, idempotency_key, caused_by_action_id, note,
-- self_decision_test_mode (true only for an EIR self-decision taken in a PR
-- preview's test mode, from the action's structured payload; false elsewhere).
-- View bodies can't hold parameters, so the names are spliced in from the
-- job's own parameters: validated above, and back-quotes doubled anyway.
EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`admin_branch` AS '
  || 'SELECT \'admin\' AS area, \'write_check\' AS record_type, write_check_id AS record_id, '
  || 'action_id, action, \'stage\' AS changed, from_stage AS from_value, to_stage AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'admin`.`write_check_actions`';
