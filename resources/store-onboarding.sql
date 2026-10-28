-- Bundle-only provisioning: run by the provision_store job (task create_onboarding_tables).
--
-- The onboarding area of the ADR-0007 data model (docs/data-model.md):
-- onboarding_requests, onboarding_intake_datasets, onboarding_intake_owners,
-- onboarding_request_actions, and audit.onboarding_branch.
SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'audit');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') (
  id STRING NOT NULL COMMENT 'UUID the server generated',
  display_number BIGINT COMMENT 'Shown as ONB-<n> on requests made before display codes; null on newer ones. Never a key',
  display_code STRING COMMENT 'Shown as is (ONB-7K3QFD); unique; null on requests made before display codes. Never a key',
  title STRING NOT NULL,
  initiative_id STRING NOT NULL COMMENT 'Reserved initiative UUID for standup',
  provider_principal_id STRING NOT NULL,
  provider_display STRING NOT NULL,
  submitted_at TIMESTAMP NOT NULL,
  stage STRING NOT NULL,
  stage_entered_at TIMESTAMP NOT NULL,
  sla_due_at TIMESTAMP,
  sla_due_soon_at TIMESTAMP,
  initiative_name STRING NOT NULL,
  business_case STRING NOT NULL,
  annual_benefit DECIMAL(18,2) NOT NULL,
  levers ARRAY<STRING> NOT NULL,
  workspace_isolation STRING NOT NULL,
  workspace_team_size INT NOT NULL,
  intake_answers STRING NOT NULL,
  open_send_back_from_stage STRING,
  open_send_back_action_id STRING,
  initiative_owner_kind STRING COMMENT 'How the provider named the initiative owner (#103): self (Myself, from the signed-in session) or someone-else; null on requests made before it was asked',
  initiative_owner_display STRING COMMENT 'The initiative owner\'s name: the session\'s for self, as typed for someone-else',
  initiative_owner_email STRING COMMENT 'The initiative owner\'s email, normalised. Display and matching data, never a key (ADR-0006)',
  initiative_owner_principal_id STRING COMMENT 'The signed-in session\'s principal for self; null for someone-else (not verified)',
  initiative_owner_match_source STRING COMMENT 'How the initiative owner principal was recorded (#103): self (Myself) or staff (entered by EDP staff, not verified); null while unmatched',
  initiative_owner_matched_by_principal_id STRING COMMENT 'The EDP staff member who entered a staff match; null otherwise',
  initiative_owner_matched_by_display STRING COMMENT 'Their display name when they matched',
  initiative_owner_matched_at TIMESTAMP COMMENT 'When staff entered the match',
  version BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL,
  CONSTRAINT onboarding_requests_pk PRIMARY KEY (id)
)
COMMENT 'One row per onboarding request, holding the current review state and intake package.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_intake_datasets') (
  id STRING NOT NULL COMMENT 'Reserved dataset UUID for standup',
  onboarding_request_id STRING NOT NULL,
  position INT NOT NULL,
  name STRING NOT NULL,
  source_system STRING COMMENT 'Provider-named source for this stable dataset ID',
  domain STRING NOT NULL,
  ingestion_method STRING COMMENT 'Ingest pattern for this stable dataset ID',
  ingestion_details STRING COMMENT 'Provider context for this dataset ingest pattern',
  dataset_tag STRING NOT NULL,
  CONSTRAINT onboarding_intake_datasets_pk PRIMARY KEY (id)
)
COMMENT 'One row per dataset named in onboarding intake; IDs are reserved at submit.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_intake_owners') (
  id STRING NOT NULL COMMENT 'Reserved owner UUID for standup',
  intake_dataset_id STRING NOT NULL,
  onboarding_request_id STRING NOT NULL,
  position INT NOT NULL,
  person_display STRING NOT NULL,
  person_email STRING NOT NULL,
  person_principal_id STRING,
  person_match_source STRING COMMENT 'How person_principal_id was recorded (#103): self (Myself) or staff (entered by EDP staff, not verified); null while unmatched, and on rows from before staff matching',
  person_matched_by_principal_id STRING COMMENT 'The EDP staff member who entered a staff match; null otherwise',
  person_matched_by_display STRING COMMENT 'Their display name when they matched',
  person_matched_at TIMESTAMP COMMENT 'When staff entered the match',
  CONSTRAINT onboarding_intake_owners_pk PRIMARY KEY (id)
)
COMMENT 'One row per owner contact named for an intake dataset; IDs are reserved at submit.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_request_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  onboarding_request_id STRING NOT NULL,
  action STRING NOT NULL,
  from_stage STRING,
  to_stage STRING,
  record_version BIGINT NOT NULL,
  actor_principal_id STRING NOT NULL,
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING,
  command STRING,
  command_hash STRING,
  expected_effects STRING,
  result STRING,
  CONSTRAINT onboarding_request_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on an onboarding request. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true');

-- Display codes (ADR-0007 decision 2, amended 2026-10-10): a record made
-- since then has a random display_code and no display_number; older ones
-- keep their number. Columns added after a table was first provisioned are
-- added here only when information_schema says they're missing (Databricks
-- SQL has no ADD COLUMN IF NOT EXISTS), so a re-run is a no-op; every column
-- missing from a table's first shape needs one of these
-- (src/server/delta/__tests__/ddl-files.test.ts checks). DROP NOT NULL on a
-- nullable column is a no-op too.
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_display_code STRING;
SET VAR edp_migrate_onboarding_requests_display_code = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN display_code STRING COMMENT \'Shown as is (ONB-7K3QFD); unique; null on requests made before display codes. Never a key\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'display_code'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_display_code;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') ALTER COLUMN display_number DROP NOT NULL;

-- The initiative owner (#103): four nullable columns, null on requests made
-- before it was asked.
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_kind STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_kind = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_kind STRING COMMENT \'How the provider named the initiative owner (#103): self (Myself, from the signed-in session) or someone-else; null on requests made before it was asked\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_kind'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_kind;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_display STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_display = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_display STRING COMMENT \'The initiative owner\\\'s name: the session\\\'s for self, as typed for someone-else\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_display'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_display;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_email STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_email = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_email STRING COMMENT \'The initiative owner\\\'s email, normalised. Display and matching data, never a key (ADR-0006)\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_email'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_email;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_principal_id STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_principal_id = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_principal_id STRING COMMENT \'The signed-in session\\\'s principal for self; null for someone-else (not verified)\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_principal_id'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_principal_id;

-- Staff owner matching (#103, slice 103-B): how each owner's principal was
-- recorded and, for a staff match, who entered it and when. All nullable; a
-- row from before has none, and only Myself could have set its principal.
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_match_source STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_match_source = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_match_source STRING COMMENT \'How the initiative owner principal was recorded (#103): self (Myself) or staff (entered by EDP staff, not verified); null while unmatched\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_match_source'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_match_source;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_matched_by_principal_id STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_matched_by_principal_id = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_matched_by_principal_id STRING COMMENT \'The EDP staff member who entered a staff match; null otherwise\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_matched_by_principal_id'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_matched_by_principal_id;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_matched_by_display STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_matched_by_display = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_matched_by_display STRING COMMENT \'Their display name when they matched\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_matched_by_display'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_matched_by_display;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_requests_initiative_owner_matched_at STRING;
SET VAR edp_migrate_onboarding_requests_initiative_owner_matched_at = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_requests` '
      || 'ADD COLUMN initiative_owner_matched_at TIMESTAMP COMMENT \'When staff entered the match\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_requests'
    AND column_name = 'initiative_owner_matched_at'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_requests_initiative_owner_matched_at;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_owners_person_match_source STRING;
SET VAR edp_migrate_onboarding_intake_owners_person_match_source = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_owners` '
      || 'ADD COLUMN person_match_source STRING COMMENT \'How person_principal_id was recorded (#103): self (Myself) or staff (entered by EDP staff, not verified); null while unmatched, and on rows from before staff matching\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_owners'
    AND column_name = 'person_match_source'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_owners_person_match_source;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_owners_person_matched_by_principal_id STRING;
SET VAR edp_migrate_onboarding_intake_owners_person_matched_by_principal_id = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_owners` '
      || 'ADD COLUMN person_matched_by_principal_id STRING COMMENT \'The EDP staff member who entered a staff match; null otherwise\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_owners'
    AND column_name = 'person_matched_by_principal_id'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_owners_person_matched_by_principal_id;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_owners_person_matched_by_display STRING;
SET VAR edp_migrate_onboarding_intake_owners_person_matched_by_display = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_owners` '
      || 'ADD COLUMN person_matched_by_display STRING COMMENT \'Their display name when they matched\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_owners'
    AND column_name = 'person_matched_by_display'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_owners_person_matched_by_display;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_owners_person_matched_at STRING;
SET VAR edp_migrate_onboarding_intake_owners_person_matched_at = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_owners` '
      || 'ADD COLUMN person_matched_at TIMESTAMP COMMENT \'When staff entered the match\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_owners'
    AND column_name = 'person_matched_at'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_owners_person_matched_at;

-- Per-dataset ingestion (#279): nullable for requests provisioned before the
-- question moved onto each stable dataset row. Re-provisioning upgrades in place.
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_datasets_source_system STRING;
SET VAR edp_migrate_onboarding_intake_datasets_source_system = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_datasets` '
      || 'ADD COLUMN source_system STRING COMMENT \'Provider-named source for this stable dataset ID\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_datasets'
    AND column_name = 'source_system'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_datasets_source_system;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_datasets_ingestion_method STRING;
SET VAR edp_migrate_onboarding_intake_datasets_ingestion_method = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_datasets` '
      || 'ADD COLUMN ingestion_method STRING COMMENT \'Ingest pattern for this stable dataset ID\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_datasets'
    AND column_name = 'ingestion_method'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_datasets_ingestion_method;
DECLARE OR REPLACE VARIABLE edp_migrate_onboarding_intake_datasets_ingestion_details STRING;
SET VAR edp_migrate_onboarding_intake_datasets_ingestion_details = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_intake_datasets` '
      || 'ADD COLUMN ingestion_details STRING COMMENT \'Provider context for this dataset ingest pattern\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'onboarding'
    AND table_name = 'onboarding_intake_datasets'
    AND column_name = 'ingestion_details'
);
EXECUTE IMMEDIATE edp_migrate_onboarding_intake_datasets_ingestion_details;

ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') DROP CONSTRAINT IF EXISTS onboarding_requests_stage;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') ADD CONSTRAINT onboarding_requests_stage CHECK (stage IN ('submitted', 'business-roi-review', 'ccb', 'standup', 'rejected', 'withdrawn'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') DROP CONSTRAINT IF EXISTS onboarding_requests_initiative_owner_kind;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') ADD CONSTRAINT onboarding_requests_initiative_owner_kind CHECK (initiative_owner_kind IS NULL OR initiative_owner_kind IN ('self', 'someone-else'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') DROP CONSTRAINT IF EXISTS onboarding_requests_initiative_owner_match_source;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_requests') ADD CONSTRAINT onboarding_requests_initiative_owner_match_source CHECK (initiative_owner_match_source IS NULL OR initiative_owner_match_source IN ('self', 'staff'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_intake_owners') DROP CONSTRAINT IF EXISTS onboarding_intake_owners_match_source;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_intake_owners') ADD CONSTRAINT onboarding_intake_owners_match_source CHECK (person_match_source IS NULL OR person_match_source IN ('self', 'staff'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_request_actions') DROP CONSTRAINT IF EXISTS onboarding_request_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_request_actions') ADD CONSTRAINT onboarding_request_actions_action CHECK (action IN ('submitted', 'forwarded', 'approved', 'sent-back', 'resubmitted', 'rejected', 'withdrawn', 'activated', 'owner-matched', 'owner-onboarding-requested'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_request_actions') DROP CONSTRAINT IF EXISTS onboarding_request_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'onboarding.onboarding_request_actions') ADD CONSTRAINT onboarding_request_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));

-- The old ONB counter row. Nothing takes numbers from it since display codes;
-- dropping unused counter rows is later cleanup.
INSERT INTO IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters')
SELECT 'ONB', 1001, current_timestamp()
WHERE NOT EXISTS (SELECT 1 FROM IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters') WHERE prefix = 'ONB');

EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`onboarding_branch` AS '
  || 'SELECT \'onboarding\' AS area, \'onboarding_request\' AS record_type, onboarding_request_id AS record_id, '
  || 'action_id, action, \'stage\' AS changed, from_stage AS from_value, to_stage AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'onboarding`.`onboarding_request_actions`';
