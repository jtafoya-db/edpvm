-- Bundle-only provisioning: run by the provision_store job (task create_teams_tables).
--
-- Build ticket 1 of the ADR-0007 migration order (#123), as catalogued in
-- docs/data-model.md, with the change list amended by ADR-0008:
--   * initiatives.initiatives, initiative_actions, datasets, dataset_actions
--   * teams.dataset_owners, dataset_owner_actions, dataset_members,
--     dataset_member_actions, email_bindings (add-only), email_binding_actions
--   * change_list.change_list_entries, change_list_entry_actions, and the
--     add-only change_list_approvals and change_list_applications an entry's
--     stage is derived from (ADR-0008 decision 3)
--   * audit.initiatives_branch, audit.teams_branch, audit.change_list_branch
--
-- A dataset role grants a fixed set of access (ADR-0007 decision 10): there
-- are no per-member access levels. Every statement is idempotent, so the job
-- can be re-run.
--
-- Parameters: :catalog_name, :schema_prefix (see store-admin.sql).
-- Refuse unsafe names before anything else runs. These two parameters name
-- the catalog and schemas, and some statements splice them into dynamic SQL,
-- so they must be plain identifiers, with the same rule the server applies
-- (src/server/delta/sql-builder.ts). A failed assert fails the job.
SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'audit');

-- Row tracking is set explicitly: reads order rows people added in the same
-- instant by _metadata.row_id, which grows with each commit.

-- ---- initiatives -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiatives') (
  id STRING NOT NULL COMMENT 'Equals onboarding_requests.initiative_id; the configured ID for an initiative from deployment configuration',
  onboarding_request_id STRING COMMENT 'The request that started it; null for one loaded from deployment configuration',
  name STRING NOT NULL,
  tenant STRING NOT NULL,
  stage STRING NOT NULL COMMENT 'standup or active',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every change',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT initiatives_pk PRIMARY KEY (id)
)
COMMENT 'One row per initiative (ADR-0005).'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiative_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  initiative_id STRING NOT NULL,
  action STRING NOT NULL COMMENT 'created or activated',
  from_stage STRING,
  to_stage STRING,
  record_version BIGINT NOT NULL COMMENT 'The initiative\'s version after this action',
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
  CONSTRAINT initiative_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on an initiative. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.datasets') (
  id STRING NOT NULL COMMENT 'Equals the intake dataset\'s ID; the configured ID for a dataset from deployment configuration',
  initiative_id STRING NOT NULL,
  name STRING NOT NULL,
  domain_tag STRING NOT NULL,
  dataset_tag STRING NOT NULL COMMENT 'Unique',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every change',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT datasets_pk PRIMARY KEY (id)
)
COMMENT 'One row per dataset onboarded in the app. Not #72\'s catalog.datasets.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.dataset_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  dataset_id STRING NOT NULL,
  action STRING NOT NULL COMMENT 'created or renamed',
  record_version BIGINT NOT NULL COMMENT 'The dataset\'s version after this action',
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
  CONSTRAINT dataset_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on a dataset. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

-- ---- teams -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owners') (
  id STRING NOT NULL COMMENT 'UUID; for intake owners, equals the intake owner\'s ID',
  dataset_id STRING NOT NULL,
  source STRING NOT NULL COMMENT 'intake, configuration or app',
  person_display STRING NOT NULL,
  person_email STRING COMMENT 'Normalised email; null for an owner known only by Databricks account ID',
  person_principal_id STRING COMMENT 'Databricks account ID: given for intake and configuration owners, copied from email_bindings once bound',
  bound_at TIMESTAMP COMMENT 'When the email binding was copied here; null until bound',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every change',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT dataset_owners_pk PRIMARY KEY (id)
)
COMMENT 'One row per dataset owner of a dataset (ADR-0005, ADR-0006). Every owner also holds the manager role.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owner_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  dataset_owner_id STRING NOT NULL,
  action STRING NOT NULL COMMENT 'added, bound, access-refused or removed',
  record_version BIGINT NOT NULL COMMENT 'The owner record\'s version after this action',
  actor_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session, or system',
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL COMMENT 'tenant, staff, job or system (ADR-0008)',
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING COMMENT 'JSON: the dataset and the person as recorded (the row is deleted on removal); on access-refused, the refused account ID',
  command STRING COMMENT 'Lead actions: the validated command as JSON',
  command_hash STRING COMMENT 'Lead actions: SHA-256 of command',
  expected_effects STRING COMMENT 'Lead actions: JSON list of the rows the write produced',
  result STRING COMMENT 'Lead actions: the response row as JSON, returned again on a replay of the key',
  CONSTRAINT dataset_owner_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on a dataset owner record. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') (
  id STRING NOT NULL COMMENT 'UUID',
  dataset_id STRING NOT NULL,
  role STRING NOT NULL COMMENT 'tester, developer or manager',
  source STRING NOT NULL COMMENT 'intake, configuration or app',
  person_display STRING NOT NULL,
  person_email STRING COMMENT 'Normalised email; null for an intake owner with none',
  person_principal_id STRING COMMENT 'Databricks account ID once known',
  version BIGINT NOT NULL COMMENT '1 when created, plus one on every change',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT dataset_members_pk PRIMARY KEY (id)
)
COMMENT 'One row per person holding a dataset role on a dataset. A role grants a fixed set of access (ADR-0007 decision 10).'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_member_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  dataset_member_id STRING NOT NULL,
  action STRING NOT NULL COMMENT 'added, role-changed or removed',
  from_role STRING,
  to_role STRING,
  record_version BIGINT NOT NULL COMMENT 'The member record\'s version after this action',
  actor_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session, or system',
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL COMMENT 'tenant, staff, job or system (ADR-0008)',
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING COMMENT 'JSON: the dataset and the person as recorded (the row is deleted on removal)',
  command STRING COMMENT 'Lead actions: the validated command as JSON',
  command_hash STRING COMMENT 'Lead actions: SHA-256 of command',
  expected_effects STRING COMMENT 'Lead actions: JSON list of the rows the write produced',
  result STRING COMMENT 'Lead actions: the response row as JSON, returned again on a replay of the key',
  CONSTRAINT dataset_member_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on a dataset member record. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

-- Add-only: a binding is inserted once and never updated or deleted (ADR-0006).
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.email_bindings') (
  id STRING NOT NULL COMMENT 'UUID',
  email STRING NOT NULL COMMENT 'Normalised email; unique',
  principal_id STRING NOT NULL COMMENT 'The Databricks account ID it is bound to',
  created_at TIMESTAMP NOT NULL COMMENT 'When it was bound',
  created_by_principal_id STRING NOT NULL COMMENT 'The session that bound it',
  CONSTRAINT email_bindings_pk PRIMARY KEY (id)
)
COMMENT 'One row per email bound to a Databricks account ID (ADR-0006 decisions 3 and 4). Add-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.email_binding_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  email_binding_id STRING NOT NULL,
  action STRING NOT NULL COMMENT 'bound',
  record_version BIGINT NOT NULL COMMENT 'Always 1: a binding never changes',
  actor_principal_id STRING NOT NULL COMMENT 'Databricks account ID from the session, or system',
  actor_display STRING NOT NULL,
  actor_app STRING NOT NULL COMMENT 'tenant, staff, job or system (ADR-0008)',
  occurred_at TIMESTAMP NOT NULL,
  idempotency_key STRING NOT NULL,
  caused_by_action_id STRING,
  note STRING,
  payload STRING COMMENT 'JSON: the dataset where the binding happened',
  command STRING COMMENT 'Lead actions: the validated command as JSON',
  command_hash STRING COMMENT 'Lead actions: SHA-256 of command',
  expected_effects STRING COMMENT 'Lead actions: JSON list of the rows the write produced',
  result STRING COMMENT 'Lead actions: the response row as JSON, returned again on a replay of the key',
  CONSTRAINT email_binding_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per email binding. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

-- ---- change_list -----------------------------------------------------------

-- An entry's description never changes after it's listed. Its stage
-- (pending, approved, applied) isn't stored here: it's derived from the
-- add-only approval and application tables below (ADR-0008 decision 3).
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') (
  id STRING NOT NULL COMMENT 'UUID the server generated',
  display_number BIGINT NOT NULL COMMENT 'Shown as CL-<n>; never a key',
  kind STRING NOT NULL COMMENT 'add-member, remove-member or onboard-user',
  reason STRING NOT NULL COMMENT 'Why, as a kind: dataset-role-added, dataset-role-changed, dataset-role-removed, dataset-owner-added, dataset-owner-removed, owner-not-a-databricks-user',
  caused_by_action_id STRING NOT NULL COMMENT 'The action that listed it; who and when come from there',
  dataset_id STRING COMMENT 'The dataset, for membership entries; null for an initiative-wide kind (onboard-user)',
  group_name STRING COMMENT 'The dataset group, for membership entries',
  role STRING COMMENT 'The dataset role, for membership entries',
  person_display STRING NOT NULL,
  person_email STRING COMMENT 'For EDP staff to find the person in Databricks; null for an owner known only by account ID',
  person_principal_id STRING COMMENT 'Their Databricks account ID, once known',
  grants ARRAY<STRING> COMMENT 'What the role grants or the person loses, from configuration when listed; membership entries only',
  target_payload STRING COMMENT 'JSON: the versioned typed target of a kind that is not membership (onboard-user: the person and initiative); null for membership entries. Data, never instructions',
  version BIGINT NOT NULL COMMENT '1 when listed, plus one on every action',
  created_at TIMESTAMP NOT NULL,
  created_by_principal_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  updated_by_principal_id STRING NOT NULL,
  last_action_id STRING NOT NULL COMMENT 'The action that set this version',
  CONSTRAINT change_list_entries_pk PRIMARY KEY (id)
)
COMMENT 'One row per change-list entry: one change for EDP staff to make in Databricks (ADR-0005, ADR-0008).'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableRowTracking' = 'true');

-- Kinds that aren't dataset membership (onboard-user, #103) carry their
-- target as a versioned JSON payload (#263 generalises this), so the
-- membership-only columns are nullable; the change_list_entries_shape check
-- below still requires them on every membership entry. Databricks SQL has no
-- ADD COLUMN IF NOT EXISTS, so the column is added only when
-- information_schema says it's missing, and DROP NOT NULL on a nullable
-- column is a no-op: a re-run changes nothing. Forward-only: an older
-- store-teams.sql re-adds the two-kind check, which fails once an
-- onboard-user row exists (docs/delta-schema.md).
DECLARE OR REPLACE VARIABLE edp_migrate_change_list_entries_target_payload STRING;
SET VAR edp_migrate_change_list_entries_target_payload = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'change_list`.`change_list_entries` '
      || 'ADD COLUMN target_payload STRING COMMENT \'JSON: the versioned typed target of a kind that is not membership (onboard-user: the person and initiative); null for membership entries. Data, never instructions\''
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE table_catalog = :catalog_name
    AND table_schema = :schema_prefix || 'change_list'
    AND table_name = 'change_list_entries'
    AND column_name = 'target_payload'
);
EXECUTE IMMEDIATE edp_migrate_change_list_entries_target_payload;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ALTER COLUMN dataset_id DROP NOT NULL;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ALTER COLUMN group_name DROP NOT NULL;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ALTER COLUMN role DROP NOT NULL;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ALTER COLUMN grants DROP NOT NULL;

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entry_actions') (
  action_id STRING NOT NULL COMMENT 'UUID',
  change_list_entry_id STRING NOT NULL,
  action STRING NOT NULL COMMENT 'listed or applied',
  from_stage STRING,
  to_stage STRING,
  record_version BIGINT NOT NULL COMMENT 'The entry\'s version after this action',
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
  CONSTRAINT change_list_entry_actions_pk PRIMARY KEY (action_id)
)
COMMENT 'One row per action on a change-list entry. Append-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

-- Add-only, and granted to one identity each (ADR-0008 decision 3): only the
-- staff app's principal inserts approvals. Nothing approves entries until
-- the Apply job (ADR-0008 decision 4); the table exists so the stage rule
-- and the grants are in place from the start.
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_approvals') (
  id STRING NOT NULL COMMENT 'UUID',
  change_list_entry_id STRING NOT NULL COMMENT 'Unique',
  created_at TIMESTAMP NOT NULL COMMENT 'When it was approved',
  created_by_principal_id STRING NOT NULL COMMENT 'The EDP staff member who approved it',
  caused_by_action_id STRING NOT NULL COMMENT 'The action that approved it',
  CONSTRAINT change_list_approvals_pk PRIMARY KEY (id)
)
COMMENT 'One row per change-list entry approved for Apply. Add-only; staff app principal only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

-- In the MVP EDP staff apply entries by hand and the staff app records them
-- here with method = by-hand; once the Apply job is live, only its
-- principal inserts, with method = job (ADR-0008 decision 4).
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_applications') (
  id STRING NOT NULL COMMENT 'UUID',
  change_list_entry_id STRING NOT NULL COMMENT 'Unique',
  method STRING NOT NULL COMMENT 'by-hand or job',
  run_id STRING COMMENT 'The Apply job run; null when applied by hand',
  outcome STRING COMMENT 'What the Apply job reported; null when applied by hand',
  created_at TIMESTAMP NOT NULL COMMENT 'When it was applied',
  created_by_principal_id STRING NOT NULL COMMENT 'Who recorded it: the EDP staff member, or the job',
  caused_by_action_id STRING NOT NULL COMMENT 'The action that recorded it',
  CONSTRAINT change_list_applications_pk PRIMARY KEY (id)
)
COMMENT 'One row per change-list entry applied in Databricks. Add-only.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true', 'delta.enableRowTracking' = 'true');

-- Enums and the person rule are CHECK constraints. Delta has no ADD
-- CONSTRAINT IF NOT EXISTS, so each is dropped and re-added; re-adding
-- validates the existing rows.
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiatives') DROP CONSTRAINT IF EXISTS initiatives_stage;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiatives') ADD CONSTRAINT initiatives_stage CHECK (stage IN ('standup', 'active'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiative_actions') DROP CONSTRAINT IF EXISTS initiative_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiative_actions') ADD CONSTRAINT initiative_actions_action CHECK (action IN ('created', 'activated'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiative_actions') DROP CONSTRAINT IF EXISTS initiative_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.initiative_actions') ADD CONSTRAINT initiative_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.dataset_actions') DROP CONSTRAINT IF EXISTS dataset_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.dataset_actions') ADD CONSTRAINT dataset_actions_action CHECK (action IN ('created', 'renamed'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.dataset_actions') DROP CONSTRAINT IF EXISTS dataset_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'initiatives.dataset_actions') ADD CONSTRAINT dataset_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owners') DROP CONSTRAINT IF EXISTS dataset_owners_source;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owners') ADD CONSTRAINT dataset_owners_source CHECK (source IN ('intake', 'configuration', 'app'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owners') DROP CONSTRAINT IF EXISTS dataset_owners_person;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owners') ADD CONSTRAINT dataset_owners_person CHECK (person_email IS NOT NULL OR person_principal_id IS NOT NULL);
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owner_actions') DROP CONSTRAINT IF EXISTS dataset_owner_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owner_actions') ADD CONSTRAINT dataset_owner_actions_action CHECK (action IN ('added', 'bound', 'access-refused', 'removed'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owner_actions') DROP CONSTRAINT IF EXISTS dataset_owner_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_owner_actions') ADD CONSTRAINT dataset_owner_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') DROP CONSTRAINT IF EXISTS dataset_members_role;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') ADD CONSTRAINT dataset_members_role CHECK (role IN ('tester', 'developer', 'manager'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') DROP CONSTRAINT IF EXISTS dataset_members_source;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') ADD CONSTRAINT dataset_members_source CHECK (source IN ('intake', 'configuration', 'app'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') DROP CONSTRAINT IF EXISTS dataset_members_person;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_members') ADD CONSTRAINT dataset_members_person CHECK (person_email IS NOT NULL OR person_principal_id IS NOT NULL);
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_member_actions') DROP CONSTRAINT IF EXISTS dataset_member_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_member_actions') ADD CONSTRAINT dataset_member_actions_action CHECK (action IN ('added', 'role-changed', 'removed'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_member_actions') DROP CONSTRAINT IF EXISTS dataset_member_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.dataset_member_actions') ADD CONSTRAINT dataset_member_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.email_binding_actions') DROP CONSTRAINT IF EXISTS email_binding_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.email_binding_actions') ADD CONSTRAINT email_binding_actions_action CHECK (action IN ('bound'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.email_binding_actions') DROP CONSTRAINT IF EXISTS email_binding_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.email_binding_actions') ADD CONSTRAINT email_binding_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') DROP CONSTRAINT IF EXISTS change_list_entries_kind;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ADD CONSTRAINT change_list_entries_kind CHECK (kind IN ('add-member', 'remove-member', 'onboard-user'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') DROP CONSTRAINT IF EXISTS change_list_entries_reason;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ADD CONSTRAINT change_list_entries_reason CHECK (reason IN ('dataset-role-added', 'dataset-role-changed', 'dataset-role-removed', 'dataset-owner-added', 'dataset-owner-removed', 'owner-not-a-databricks-user'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') DROP CONSTRAINT IF EXISTS change_list_entries_role;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ADD CONSTRAINT change_list_entries_role CHECK (role IS NULL OR role IN ('tester', 'developer', 'manager'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') DROP CONSTRAINT IF EXISTS change_list_entries_shape;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ADD CONSTRAINT change_list_entries_shape CHECK ((kind IN ('add-member', 'remove-member') AND dataset_id IS NOT NULL AND group_name IS NOT NULL AND role IS NOT NULL AND grants IS NOT NULL) OR (kind = 'onboard-user' AND target_payload IS NOT NULL AND person_email IS NOT NULL AND dataset_id IS NULL));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') DROP CONSTRAINT IF EXISTS change_list_entries_person;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entries') ADD CONSTRAINT change_list_entries_person CHECK (person_email IS NOT NULL OR person_principal_id IS NOT NULL);
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entry_actions') DROP CONSTRAINT IF EXISTS change_list_entry_actions_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entry_actions') ADD CONSTRAINT change_list_entry_actions_action CHECK (action IN ('listed', 'applied'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entry_actions') DROP CONSTRAINT IF EXISTS change_list_entry_actions_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_entry_actions') ADD CONSTRAINT change_list_entry_actions_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'));
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_applications') DROP CONSTRAINT IF EXISTS change_list_applications_method;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'change_list.change_list_applications') ADD CONSTRAINT change_list_applications_method CHECK (method IN ('by-hand', 'job'));

-- The CL display prefix. The counter row is store-admin.sql's table.
INSERT INTO IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters')
SELECT 'CL', 1, current_timestamp()
WHERE NOT EXISTS (SELECT 1 FROM IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.display_counters') WHERE prefix = 'CL');

-- This area's branches of audit.actions, in the fixed column order (see
-- store-admin.sql). View bodies can't hold parameters, so the names are
-- spliced in from the job's own parameters: validated above, and back-quotes
-- doubled anyway.
EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`initiatives_branch` AS '
  || 'SELECT \'initiatives\' AS area, \'initiative\' AS record_type, initiative_id AS record_id, '
  || 'action_id, action, \'stage\' AS changed, from_stage AS from_value, to_stage AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'initiatives`.`initiative_actions` '
  || 'UNION ALL '
  || 'SELECT \'initiatives\', \'dataset\', dataset_id, '
  || 'action_id, action, CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'initiatives`.`dataset_actions`';

EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`teams_branch` AS '
  || 'SELECT \'teams\' AS area, \'dataset_owner\' AS record_type, dataset_owner_id AS record_id, '
  || 'action_id, action, CAST(NULL AS STRING) AS changed, CAST(NULL AS STRING) AS from_value, CAST(NULL AS STRING) AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'teams`.`dataset_owner_actions` '
  || 'UNION ALL '
  || 'SELECT \'teams\', \'dataset_member\', dataset_member_id, '
  || 'action_id, action, \'role\', from_role, to_role, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'teams`.`dataset_member_actions` '
  || 'UNION ALL '
  || 'SELECT \'teams\', \'email_binding\', email_binding_id, '
  || 'action_id, action, CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'teams`.`email_binding_actions`';

EXECUTE IMMEDIATE
  'CREATE OR REPLACE VIEW `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'audit`.`change_list_branch` AS '
  || 'SELECT \'change_list\' AS area, \'change_list_entry\' AS record_type, change_list_entry_id AS record_id, '
  || 'action_id, action, \'stage\' AS changed, from_stage AS from_value, to_stage AS to_value, '
  || 'record_version, actor_principal_id, actor_display, actor_app, occurred_at, '
  || 'idempotency_key, caused_by_action_id, note, false AS self_decision_test_mode '
  || 'FROM `' || replace(:catalog_name, '`', '``') || '`.`' || replace(:schema_prefix, '`', '``') || 'change_list`.`change_list_entry_actions`';
