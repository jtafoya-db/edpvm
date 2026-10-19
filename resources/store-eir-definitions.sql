-- Bundle-only provisioning: run by the provision_store job (task create_eir_definitions_tables).
--
-- Published EIR definitions (#201, docs/data-model.md, "EIR definitions"),
-- in the eir schema next to the EIRs they shape:
--   * eir.eir_definition_register  one row: which published version is active
--                                  (none: the bootstrap definition) and the
--                                  latest version number. Its version checks
--                                  every publish and activate.
--   * eir.eir_definition_versions  one row per published version: the number
--                                  the server gave it (#224), the YAML as
--                                  written, the normalized definition, its
--                                  SHA-256 and who published it. Append-only:
--                                  a version is never edited or deleted.
--   * eir.eir_definition_actions   one row per publish or activation. Append-only.
--   * audit.eir_definitions_branch this area's branch of audit.actions
--
-- Only the staff app writes these tables (ADR-0008). They hold no EIR answers.
-- Every statement is idempotent, so the job can be re-run.
--
-- Parameters: :catalog_name, :schema_prefix (see store-admin.sql).
-- Refuse unsafe names before anything else runs. These two parameters name
-- the catalog and schemas, and some statements splice them into dynamic SQL,
-- so they must be plain identifiers, with the same rule the server applies
-- (src/server/delta/sql-builder.ts). A failed assert fails the job.
SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'audit');

-- A current-state table with one row, created by the first publish.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_register') (
  id STRING NOT NULL COMMENT 'The one register row\'s fixed UUID (src/server/delta/areas/eir-definitions.ts)',
  active_version_number BIGINT COMMENT 'The published version new EIR drafts use; null: the bootstrap definition',
  latest_version_number BIGINT NOT NULL COMMENT 'The last version number published: the next publish takes this plus one (#224)',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every publish or activation',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT eir_definition_register_pk PRIMARY KEY (id)
)
COMMENT 'One row: the active published EIR definition and the latest version number (#201).'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_versions') (
  id STRING NOT NULL COMMENT 'UUID',
  version_number BIGINT NOT NULL COMMENT '1, 2, 3...: assigned by the server at publish (#224), the version\'s identity. Drafts and submissions record it as text (eir_drafts.form_version)',
  definition_version STRING NOT NULL COMMENT 'Since #224, version_number as text (before, the YAML\'s own definitionVersion, which it no longer has)',
  form_version STRING NOT NULL COMMENT 'Since #224, version_number as text: what drafts and submissions record (before, the YAML\'s form version)',
  source_yaml STRING NOT NULL COMMENT 'The YAML exactly as published',
  normalized_definition STRING NOT NULL COMMENT 'JSON: the validated definition the #200 service made of it',
  content_sha256 STRING NOT NULL COMMENT 'SHA-256 of source_yaml: the content identity',
  published_action_id STRING NOT NULL COMMENT 'The published action in eir_definition_actions',
  published_at TIMESTAMP NOT NULL,
  published_by_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session',
  published_by_display STRING NOT NULL,
  published_by_app STRING NOT NULL COMMENT 'staff (ADR-0008)',
  created_at TIMESTAMP NOT NULL,
  CONSTRAINT eir_definition_versions_pk PRIMARY KEY (id)
)
COMMENT 'One row per published EIR definition version (#201). Unique: version_number (checked inside the publish write, #224), content_sha256. Never edited or deleted.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.appendOnly' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  eir_definition_register_id STRING NOT NULL COMMENT 'The register row',
  action STRING NOT NULL COMMENT 'published or activated',
  from_active_version STRING COMMENT 'The active version before: a version number, or bootstrap',
  to_active_version STRING COMMENT 'The active version after',
  definition_version_number BIGINT NOT NULL COMMENT 'The version published or activated',
  record_version BIGINT NOT NULL COMMENT 'The register\'s version after this action',
  actor_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session',
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL COMMENT 'tenant, staff, job or system (ADR-0008)',
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING COMMENT 'JSON: activated: rollback (true when the version had been active before)',
  command STRING COMMENT 'Lead actions: the validated command as JSON',
  command_hash STRING COMMENT 'Lead actions: SHA-256 of command',
  expected_effects STRING COMMENT 'Lead actions: JSON list of the rows the write produced',
  result STRING COMMENT 'Lead actions: the response row as JSON, returned again on a replay of the key',
  CONSTRAINT eir_definition_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per publish or activation of an EIR definition (#201). Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.appendOnly' = 'true');

-- Enums are CHECK constraints. Delta has no ADD CONSTRAINT IF NOT EXISTS, so
-- each is dropped and re-added; re-adding validates the existing rows.
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_versions') DROP CONSTRAINT IF EXISTS eir_definition_versions_published_by_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_versions') ADD CONSTRAINT eir_definition_versions_published_by_app CHECK (published_by_app IN ('staff'));
-- Publish numbers from 1 (#224): 0 and below are never a published version,
-- so no publish can take a built-in definition's identity (bootstrap is 0).
-- Delta has no UNIQUE constraint: the publish write checks the number is
-- free inside its own atomic block (src/server/delta/areas/eir-definitions.ts).
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_versions') DROP CONSTRAINT IF EXISTS eir_definition_versions_version_number;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_versions') ADD CONSTRAINT eir_definition_versions_version_number CHECK (version_number >= 1);
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_actions') DROP CONSTRAINT IF EXISTS eir_definition_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_actions') ADD CONSTRAINT eir_definition_actions_action CHECK (action IN ('published', 'activated'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_actions') DROP CONSTRAINT IF EXISTS eir_definition_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_definition_actions') ADD CONSTRAINT eir_definition_actions_actor_app CHECK (actor_app IN ('staff'));

-- This area's branch of audit.actions, with the fixed columns listed in
-- store-admin.sql. View bodies can't hold parameters, so the names are
-- spliced in from the job's own parameters: validated above, and
-- back-quotes doubled anyway.
EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`eir_definitions_branch` AS '
  || 'SELECT \'eir-definitions\' AS area, \'eir_definition_register\' AS record_type, eir_definition_register_id AS record_id, '
  || 'action_id, action, \'active_version\' AS changed, from_active_version AS from_value, to_active_version AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'eir`.`eir_definition_actions`';
