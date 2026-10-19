SELECT assert_true(:catalog_name RLIKE '^[A-Za-z_][A-Za-z0-9_]*$', 'catalog_name must be a plain identifier');
SELECT assert_true(:schema_prefix RLIKE '^([A-Za-z_][A-Za-z0-9_]*)?$', 'schema_prefix must be empty or a plain identifier');
USE CATALOG IDENTIFIER(:catalog_name);
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'privacy');

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'privacy.acknowledgments') (
  action_id STRING NOT NULL,
  acknowledgment_id STRING NOT NULL,
  action STRING NOT NULL,
  notice_version STRING NOT NULL,
  content_hash STRING NOT NULL,
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
  CONSTRAINT privacy_acknowledgments_pk PRIMARY KEY (action_id)
)
COMMENT 'Immutable privacy-notice acknowledgments. Refusals are never recorded.'
TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported');

ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'privacy.acknowledgments') DROP CONSTRAINT IF EXISTS privacy_acknowledgments_action;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'privacy.acknowledgments') ADD CONSTRAINT privacy_acknowledgments_action CHECK (action = 'acknowledged');
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'privacy.acknowledgments') DROP CONSTRAINT IF EXISTS privacy_acknowledgments_actor_app;
ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'privacy.acknowledgments') ADD CONSTRAINT privacy_acknowledgments_actor_app CHECK (actor_app IN ('tenant', 'staff'));
