CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_name);

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_name || '.group_members') (
  group_name STRING, group_id STRING, kind STRING, domain STRING, dataset_tag STRING,
  managed_by STRING, user_id STRING, email STRING, display_name STRING,
  first_seen TIMESTAMP, last_seen TIMESTAMP, removed_at TIMESTAMP
) USING DELTA TBLPROPERTIES (delta.enableChangeDataFeed = true);

CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_name || '.snapshot_runs') (
  run_id STRING, started_at TIMESTAMP, ended_at TIMESTAMP, status STRING,
  groups_expected ARRAY<STRING>, groups_read ARRAY<STRING>,
  unresolved_members ARRAY<STRING>, message STRING
) USING DELTA;

DECLARE OR REPLACE VARIABLE edp_migrate_snapshot_runs_groups_expected STRING;
SET VAR edp_migrate_snapshot_runs_groups_expected = (
  SELECT CASE WHEN count(*) = 0
    THEN 'ALTER TABLE `' || replace(:catalog_name, '`', '``') || '`.`'
      || replace(:schema_name, '`', '``') || '`.`snapshot_runs` '
      || 'ADD COLUMN groups_expected ARRAY<STRING>'
    ELSE 'SELECT 1' END
  FROM IDENTIFIER(:catalog_name || '.information_schema.columns')
  WHERE lower(table_catalog) = lower(:catalog_name)
    AND lower(table_schema) = lower(:schema_name)
    AND lower(table_name) = 'snapshot_runs'
    AND lower(column_name) = 'groups_expected'
);
EXECUTE IMMEDIATE edp_migrate_snapshot_runs_groups_expected;
