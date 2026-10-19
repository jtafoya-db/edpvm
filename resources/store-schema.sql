-- Bundle-only provisioning: this file is executed only by an explicit bundle job run.
-- :schema_prefix is '' in production; a preview passes its own (see store-admin.sql).
-- Refuse unsafe names before anything else runs. These two parameters name
-- the catalog and schemas, and some statements splice them into dynamic SQL,
-- so they must be plain identifiers, with the same rule the server applies
-- (src/server/delta/sql-builder.ts). A failed assert fails the job.
SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'access');
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.source_systems') (id STRING, name STRING, short STRING, org STRING, type STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.domains') (id STRING, name STRING, code STRING, color STRING, aliases ARRAY<STRING>, description STRING, use_cases ARRAY<STRING>, systems ARRAY<STRING>, steward STRING, owner STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.access_bundles') (id STRING, name STRING, persona STRING, color STRING, description STRING, sla STRING, bears_required BOOLEAN, approval_model STRING, approvers ARRAY<STRING>, prerequisites ARRAY<STRING>, requestable BOOLEAN, unlocks ARRAY<STRING>) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.bundle_components') (bundle_id STRING, component_type STRING, label STRING, scope STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.datasets') (id STRING, asset_type STRING, name STRING, business_name STRING, domain STRING, system STRING, classification STRING, certification STRING, usage_type STRING, freshness STRING, popularity INT, owner STRING, steward STRING, catalog STRING, schema STRING, object STRING, workspace STRING, tags ARRAY<STRING>, description STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.dataset_required_bundles') (dataset_id STRING, bundle STRING, requirement STRING, note STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.dataset_lineage') (dataset_id STRING, step_order INT, node STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'catalog.onboarding_personas') (id STRING, label STRING, desc STRING, bundles ARRAY<STRING>) USING DELTA;

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests.access_requests') (id STRING NOT NULL, title STRING, submitted_at TIMESTAMP, status STRING, overall STRING, purpose STRING, stage_index INT, requester_principal_id STRING NOT NULL, requester_username STRING NOT NULL) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests.request_items') (request_id STRING, item_order INT, kind STRING, ref STRING, dataset_id STRING, bundle_id STRING, label STRING, sub STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests.request_steps') (request_id STRING, step_order INT, system STRING, status STRING, detail STRING, ticket STRING, error STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests.pipeline') (id STRING, kind STRING, title STRING, tenant STRING, requester STRING, submitted_at TIMESTAMP, state STRING, stage STRING, next_action STRING, owner STRING, age_days INT, jira STRING, jira_status STRING, monthly_cost DECIMAL(18,2), roi DOUBLE, sensitivity STRING, pattern STRING, delivery STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests.pipeline_decisions') (pipeline_id STRING, at TIMESTAMP, actor_principal_id STRING, actor_username STRING, decision STRING, note STRING, jira STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'requests.waiver_attestations') (id STRING NOT NULL, request_id STRING NOT NULL, checklist_item_id STRING NOT NULL, attestor_principal_id STRING NOT NULL, attestor_username STRING NOT NULL, attested BOOLEAN, attested_at TIMESTAMP, note STRING, source STRING, created_at TIMESTAMP, superseded_at TIMESTAMP) USING DELTA;

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'access.my_access_workspaces') (principal_id STRING, username STRING, name STRING, entitlement STRING, since TIMESTAMP) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'access.my_access_bundles') (principal_id STRING, username STRING, bundle STRING, since TIMESTAMP, status STRING, expires TIMESTAMP, domain STRING) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'access.my_access') (principal_id STRING, username STRING, domains ARRAY<STRING>, recent_assets ARRAY<STRING>) USING DELTA;
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'admin.tenants') (id STRING, name STRING, lead STRING, fy_budget DECIMAL(18,2), fytd_spend DECIMAL(18,2), mtd_spend DECIMAL(18,2), forecast_fy DECIMAL(18,2), dbus_month DECIMAL(18,2), storage_tb DOUBLE, users INT, datasets INT, open_items INT) USING DELTA;
