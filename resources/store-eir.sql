-- Bundle-only provisioning: run by the provision_store job (task create_eir_tables).
--
-- The `eir` area of the ADR-0007 data model (docs/data-model.md, "EIR"; decision 9):
--   * eir.eirs              one row per person with an EIR, with its Record ID (EIR-7K3QFD; EIR-<n> before display codes)
--   * eir.eir_submissions   one row per signed PDF submitted (the PDF stays in
--                           the Unity Catalog volume: path, SHA-256 and size here)
--   * eir.eir_actions       one row per action on an EIR. Append-only.
--   * eir.eir_drafts        at most one unsigned draft per person
--   * eir.eir_draft_saves   the runner's record of each draft save (idempotency
--                           key, command, result). Not an action: it isn't in
--                           audit.actions, because a draft save decides nothing.
--   * eir.eir_evaluations   append-only system evaluations of exact draft versions;
--                           excluded from audit.actions because they are computed evidence
--   * audit.eir_branch      this area's branch of audit.actions
--
-- History and PDFs are kept indefinitely (ADR-0007 decision 12). Every
-- statement is idempotent, so the job can be re-run.
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

-- One row per person, created when they start the form (eir/start) or, if
-- they didn't, by their first submission. Expired is never stored: readers
-- show it when stage = 'valid' and expires_at has passed.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eirs') (
  id STRING NOT NULL COMMENT 'UUID v5 of the person\'s Databricks account ID, so a person has one ID before and after their first submission',
  display_number BIGINT COMMENT 'The Record ID of an EIR started before display codes, shown as EIR-<n>; null on newer ones. Never a key',
  display_code STRING COMMENT 'The Record ID, shown as is (EIR-7K3QFD) on the form and the PDF; unique; null on EIRs started before display codes. Never a key',
  person_principal_id STRING NOT NULL COMMENT 'Whose EIR it is: their Databricks account ID',
  person_display STRING NOT NULL COMMENT 'Their name, as shown at their latest submission',
  stage STRING NOT NULL COMMENT 'not-started, submitted, questions, valid, rejected or revoked',
  stage_entered_at TIMESTAMP NOT NULL,
  sla_due_at TIMESTAMP COMMENT 'The safeguards validator\'s SLA, while a submission waits on them',
  sla_due_soon_at TIMESTAMP,
  expires_at TIMESTAMP COMMENT 'When the valid EIR expires; null unless it has been valid',
  valid_submission_id STRING COMMENT 'The submission that last made it valid',
  open_submission_id STRING COMMENT 'The submission in review (submitted or sent back), first, resubmission or renewal; or null',
  current_submission_id STRING COMMENT 'The submission the stage is about: the form as signed',
  renewal_submission_id STRING COMMENT 'A renewal running alongside the valid EIR (submitted, sent back or rejected), or null',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every action',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT eirs_pk PRIMARY KEY (id)
)
COMMENT 'One row per person with an Employee Identity Record (ADR-0007 decision 9). Unique: person_principal_id.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

-- A child of eirs: written only together with a version change on its EIR.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_submissions') (
  id STRING NOT NULL COMMENT 'UUID',
  eir_id STRING NOT NULL COMMENT 'The EIR',
  kind STRING NOT NULL COMMENT 'first, resubmission or renewal',
  volume_path STRING NOT NULL COMMENT 'Where the signed PDF is in the Unity Catalog volume. Never a link or token.',
  document_sha256 STRING COMMENT 'The PDF\'s SHA-256 as the server read it; null only on a migrated record that never had one',
  document_size_bytes BIGINT COMMENT 'The PDF\'s size; null only on a migrated record that never had one',
  form_values STRING COMMENT 'JSON: the form as signed, keyed by the field IDs of form_version (src/data/eir/config.ts); the PDF is the record.',
  form_version STRING NOT NULL COMMENT 'The EIR form version the answers were given under (see src/data/eir/config.ts; 0.1 = #98\'s interim checklist)',
  form_started_at TIMESTAMP NOT NULL COMMENT 'When the person started this form; the yearly training rule counts back from it',
  stage STRING NOT NULL COMMENT 'submitted, questions, valid, rejected, or closed (a renewal closed because the EIR was revoked)',
  submitted_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  CONSTRAINT eir_submissions_pk PRIMARY KEY (id)
)
COMMENT 'One row per signed EIR PDF submitted. Unique: volume_path. Kept indefinitely, with the PDFs.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  eir_id STRING NOT NULL COMMENT 'The EIR acted on',
  eir_submission_id STRING COMMENT 'The submission the action is about, if any',
  action STRING NOT NULL COMMENT 'Past-tense verb: see the CHECK constraint and docs/data-model.md',
  from_stage STRING COMMENT 'The EIR\'s stored stage before (not-started for a first submission)',
  to_stage STRING COMMENT 'Its stored stage after; equal to from_stage for an action on a renewal running alongside',
  record_version BIGINT NOT NULL COMMENT 'The EIR\'s version after this action',
  actor_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session, or system',
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL COMMENT 'tenant, staff, job or system (ADR-0008)',
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING COMMENT 'Send-back questions, a decision note, or the person\'s answer',
  payload STRING,
  command STRING COMMENT 'Lead actions: the validated command as JSON',
  command_hash STRING COMMENT 'Lead actions: SHA-256 of command',
  expected_effects STRING COMMENT 'Lead actions: JSON list of the rows the write produced',
  result STRING COMMENT 'Lead actions: the response row as JSON, returned again on a replay of the key',
  CONSTRAINT eir_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on an EIR. Append-only, kept indefinitely.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true');

-- One unsigned draft per person, overwritten on each save, with its own
-- version so a draft save never conflicts with a validator's decision.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_drafts') (
  id STRING NOT NULL COMMENT 'UUID v5 of the EIR ID',
  eir_id STRING NOT NULL COMMENT 'The EIR (its row may not exist yet: the ID is derived from the person)',
  form_values STRING COMMENT 'JSON: the draft form; null once a submission has used it',
  form_version STRING COMMENT 'The EIR form version of form_values',
  form_started_at TIMESTAMP COMMENT 'When this draft was started: its first save since a submission last used one',
  version BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL,
  CONSTRAINT eir_drafts_pk PRIMARY KEY (id)
)
COMMENT 'At most one unsigned EIR draft per person. Unique: eir_id. Only the last save is kept.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

-- The transaction runner keeps every command's idempotency key, command and
-- result on a lead-action row. A draft save has no action (ADR-0007
-- decision 9), so its lead rows live here, outside audit.actions.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_draft_saves') (
  action_id STRING NOT NULL COMMENT 'UUID',
  eir_draft_id STRING NOT NULL COMMENT 'The draft saved',
  action STRING NOT NULL COMMENT 'saved',
  record_version BIGINT NOT NULL COMMENT 'The draft\'s version after this save',
  actor_principal_id STRING NOT NULL,
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING,
  command STRING COMMENT 'The validated command as JSON',
  command_hash STRING COMMENT 'SHA-256 of command',
  expected_effects STRING,
  result STRING COMMENT 'The response row as JSON, returned again on a replay of the key',
  CONSTRAINT eir_draft_saves_pk PRIMARY KEY (action_id)
)
COMMENT 'The runner\'s record of each EIR draft save (idempotency only). Not part of audit.actions.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') (
  action_id STRING NOT NULL COMMENT 'Immutable evaluation ID and command action ID',
  eir_draft_id STRING NOT NULL COMMENT 'The exact versioned draft evaluated',
  action STRING NOT NULL COMMENT 'evaluated',
  record_version BIGINT NOT NULL COMMENT 'The evaluated draft version',
  evaluation_sequence BIGINT COMMENT 'The evaluation\'s place among its draft\'s evaluations: 1, 2, 3 in the order written, even within one millisecond; null on rows written before #204',
  actor_principal_id STRING NOT NULL,
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING,
  definition_version STRING NOT NULL,
  form_version STRING NOT NULL,
  outcome STRING NOT NULL,
  rule_outcomes STRING NOT NULL COMMENT 'JSON array of stable reason codes, fields, guidance and dispositions',
  automatic_validity_eligible BOOLEAN NOT NULL,
  evaluator_principal_id STRING NOT NULL COMMENT 'Always system',
  evaluator_display STRING NOT NULL,
  evaluator_app STRING NOT NULL COMMENT 'Always system',
  command STRING,
  command_hash STRING,
  expected_effects STRING,
  result STRING,
  CONSTRAINT eir_evaluations_pk PRIMARY KEY (action_id)
)
COMMENT 'Append-only rule evaluations of exact EIR draft versions.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true');

-- Display codes (ADR-0007 decision 2, amended 2026-10-10): a record made
-- since then has a random display_code and no display_number; older ones
-- keep their number. Columns added after a table was first provisioned are
-- added here only when information_schema says they're missing (Databricks
-- SQL has no ADD COLUMN IF NOT EXISTS), so a re-run is a no-op; every column
-- missing from a table's first shape needs one of these
-- (src/server/delta/__tests__/ddl-files.test.ts checks). DROP NOT NULL on a
-- nullable column is a no-op too.
DECLARE OR REPLACE VARIABLE edp_migrate_eirs_display_code STRING;
SET VAR edp_migrate_eirs_display_code = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'eir`.`eirs` '
      || 'ADD COLUMN display_code STRING COMMENT \'The Record ID, shown as is (EIR-7K3QFD) on the form and the PDF; unique; null on EIRs started before display codes. Never a key\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'eir'
    AND table_name = 'eirs'
    AND column_name = 'display_code'
);
EXECUTE IMMEDIATE edp_migrate_eirs_display_code;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eirs') ALTER COLUMN display_number DROP NOT NULL;

-- #204: each evaluation's place among its draft's evaluations, so the latest
-- is the one written last even when two share a millisecond. Rows written
-- before it keep a null and sort before every row that has one.
DECLARE OR REPLACE VARIABLE edp_migrate_eir_evaluations_sequence STRING;
SET VAR edp_migrate_eir_evaluations_sequence = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'eir`.`eir_evaluations` '
      || 'ADD COLUMN evaluation_sequence BIGINT COMMENT \'The evaluation\\\'s place among its draft\\\'s evaluations: 1, 2, 3 in the order written, even within one millisecond; null on rows written before #204\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'eir'
    AND table_name = 'eir_evaluations'
    AND column_name = 'evaluation_sequence'
);
EXECUTE IMMEDIATE edp_migrate_eir_evaluations_sequence;

-- Enums are CHECK constraints. Delta has no ADD CONSTRAINT IF NOT EXISTS, so
-- each is dropped and re-added; re-adding validates the existing rows.
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eirs') DROP CONSTRAINT IF EXISTS eirs_stage;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eirs') ADD CONSTRAINT eirs_stage CHECK (stage IN ('not-started', 'submitted', 'questions', 'valid', 'rejected', 'revoked'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_submissions') DROP CONSTRAINT IF EXISTS eir_submissions_kind;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_submissions') ADD CONSTRAINT eir_submissions_kind CHECK (kind IN ('first', 'resubmission', 'renewal'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_submissions') DROP CONSTRAINT IF EXISTS eir_submissions_stage;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_submissions') ADD CONSTRAINT eir_submissions_stage CHECK (stage IN ('submitted', 'questions', 'valid', 'rejected', 'closed'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') DROP CONSTRAINT IF EXISTS eir_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') ADD CONSTRAINT eir_actions_action CHECK (action IN ('started', 'submitted', 'sent-back', 'resubmitted', 'validated', 'rejected', 'revoked', 'renewal-submitted', 'renewal-closed', 'migrated'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') DROP CONSTRAINT IF EXISTS eir_actions_stages;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') ADD CONSTRAINT eir_actions_stages CHECK ((from_stage IS NULL OR from_stage IN ('not-started', 'submitted', 'questions', 'valid', 'rejected', 'revoked')) AND (to_stage IS NULL OR to_stage IN ('not-started', 'submitted', 'questions', 'valid', 'rejected', 'revoked')));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') DROP CONSTRAINT IF EXISTS eir_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_actions') ADD CONSTRAINT eir_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_draft_saves') DROP CONSTRAINT IF EXISTS eir_draft_saves_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_draft_saves') ADD CONSTRAINT eir_draft_saves_action CHECK (action IN ('saved'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_draft_saves') DROP CONSTRAINT IF EXISTS eir_draft_saves_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_draft_saves') ADD CONSTRAINT eir_draft_saves_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') DROP CONSTRAINT IF EXISTS eir_evaluations_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') ADD CONSTRAINT eir_evaluations_action CHECK (action IN ('evaluated'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') DROP CONSTRAINT IF EXISTS eir_evaluations_outcome;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') ADD CONSTRAINT eir_evaluations_outcome CHECK (outcome IN ('pass', 'blocking', 'warning', 'manual-review'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') DROP CONSTRAINT IF EXISTS eir_evaluations_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') ADD CONSTRAINT eir_evaluations_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') DROP CONSTRAINT IF EXISTS eir_evaluations_evaluator_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'eir.eir_evaluations') ADD CONSTRAINT eir_evaluations_evaluator_app CHECK (evaluator_app IN ('system'));

-- The old Record ID counter (admin.display_counters, from store-admin.sql,
-- which runs first: create_eir_tables depends on create_admin_tables).
-- Nothing takes numbers from it since display codes; dropping unused counter
-- rows is later cleanup.
INSERT INTO IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters')
SELECT 'EIR', 1001, current_timestamp()
WHERE NOT EXISTS (SELECT 1 FROM IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters') WHERE prefix = 'EIR');

-- This area's branch of audit.actions, with the fixed columns listed in
-- store-admin.sql. Draft saves aren't actions, so they aren't here.
-- self_decision_test_mode comes only from the action's structured payload,
-- which only the server writes (src/data/eir/self-decision.ts). No typed note
-- or response can start with the marker text; PR #134's own preview rows from
-- rounds 7 and 8 carried it in the note, so the view drops that prefix.
-- View bodies can't hold parameters, so the names are spliced in from the
-- job's own parameters: validated above, and back-quotes doubled anyway.
EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`eir_branch` AS '
  || 'SELECT \'eir\' AS area, \'eir\' AS record_type, eir_id AS record_id, '
  || 'action_id, action, \'stage\' AS changed, from_stage AS from_value, to_stage AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, '
  || 'CASE WHEN substr(note, 1, 39) = \'[Self-decision under preview test mode]\' '
  || 'THEN nullif(trim(substr(note, 40)), \'\') ELSE note END AS note, '
  || 'coalesce(payload = \'{"selfDecisionTestMode":true}\', false) AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'eir`.`eir_actions`';
