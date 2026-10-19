# Databricks notebook source
# MAGIC %md
# MAGIC # Group membership snapshot
# MAGIC Read allowlisted groups only. Write snapshot tables, never identity groups.

# COMMAND ----------
# DBTITLE 1,1. Load SDK and pure reconciliation rules
import json
import uuid
from datetime import datetime, timezone

from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import (
    DatabricksError, DeadlineExceeded, InternalError, TemporarilyUnavailable,
    TooManyRequests,
)
from pyspark.sql import Row
from pyspark.sql.types import StringType, StructField, StructType
from reconcile import (
    ExistingMembership, Member, classify_member_reference, finalize_snapshot_run,
    process_groups, reconcile_group, require_expected_principal, retry,
    validate_allowlist,
)
from monitor import validate_identifier


def sdk_retry(call):
    return retry(call, lambda error: isinstance(error, (
        TooManyRequests, InternalError, TemporarilyUnavailable, DeadlineExceeded,
    )))


def literal(value):
    return "'" + value.replace("'", "''") + "'"


# COMMAND ----------
# DBTITLE 1,2. Read task parameters and validate the allowlist
for name, default in (
    ("catalog", ""), ("schema", ""), ("allowlist_json", "[]"),
    ("max_removals", "10"), ("require_service_principal", "false"),
    ("expected_principal", ""),
):
    dbutils.widgets.text(name, default)

catalog = validate_identifier(dbutils.widgets.get("catalog"), kind="catalog")
schema = validate_identifier(dbutils.widgets.get("schema"), kind="schema")
target = f"`{catalog}`.`{schema}`"
allowlist = json.loads(dbutils.widgets.get("allowlist_json"))
validate_allowlist(allowlist)
groups_expected = [group["group_id"] for group in allowlist]
max_removals = int(dbutils.widgets.get("max_removals"))
required_value = dbutils.widgets.get("require_service_principal").lower()
if required_value not in {"true", "false"}:
    raise ValueError("require_service_principal must be true or false")
run_id, started = str(uuid.uuid4()), datetime.now(timezone.utc)
groups_read, unresolved, messages = [], [], []
original_error = None
client = WorkspaceClient()
print(f"Run {run_id}: {len(allowlist)} allowlisted groups -> {target}")

# COMMAND ----------
# DBTITLE 1,3. Enforce the configured execution identity
try:
    require_expected_principal(
        required_value == "true", dbutils.widgets.get("expected_principal"), client,
    )
except Exception as error:
    original_error = error
    messages.append(str(error))

# COMMAND ----------
# DBTITLE 1,4. Read each roster with retries and classify non-user references
def fetch_roster(cfg):
    group = sdk_retry(lambda: client.groups.get(cfg["group_id"]))
    users, skipped, group_messages, complete = [], [], [], True
    for ref in group.members or []:
        reference = ref.ref or ""
        member_kind = classify_member_reference(reference)
        if member_kind == "known-non-user":
            skipped.append(f"{cfg['group_id']}:{reference or ref.value}")
            if cfg["kind"] == "dataset" and "Groups/" in reference:
                group_messages.append(f"{cfg['group_name']} contains a nested group")
            continue
        if member_kind == "unresolved":
            complete = False
            unresolved.append(f"{cfg['group_id']}:{reference or ref.value}:unknown-ref")
            continue
        try:
            user = sdk_retry(lambda member_id=ref.value: client.users.get(member_id))
            email = next(
                (item.value for item in (user.emails or []) if item.primary),
                user.user_name,
            )
            users.append(Member(
                str(user.id), email or "",
                user.display_name or email or str(user.id),
            ))
        except DatabricksError as error:
            complete = False
            unresolved.append(f"{cfg['group_id']}:Users/{ref.value}:{error}")
    return users, skipped, group_messages, complete

# COMMAND ----------
# DBTITLE 1,5. Reconcile and merge one group with fail-closed removals
member_schema = StructType([StructField(name, StringType(), True) for name in (
    "group_name", "group_id", "kind", "domain", "dataset_tag", "managed_by",
    "user_id", "email", "display_name",
)])


def process_group(cfg):
    users, skipped, group_messages, complete = fetch_roster(cfg)
    existing = spark.sql(
        f"SELECT user_id, removed_at IS NOT NULL removed "
        f"FROM {target}.group_members WHERE group_id={literal(cfg['group_id'])}"
    ).collect()
    default_limit = 100 if cfg["managed_by"] == "scim" else max_removals
    decision = reconcile_group(
        [ExistingMembership(row.user_id, row.removed) for row in existing],
        users, skipped, fetch_complete=complete,
        max_removals=cfg.get("max_removals", default_limit),
    )
    unresolved.extend(decision.skipped_non_users)
    if decision.removal_status != "applied":
        group_messages.append(
            f"{cfg['group_name']} removals skipped: {decision.removal_status}"
        )
    rows = [
        Row(
            group_name=cfg["group_name"], group_id=cfg["group_id"],
            kind=cfg["kind"], domain=cfg["domain"],
            dataset_tag=cfg.get("dataset_tag"), managed_by=cfg["managed_by"],
            user_id=user.user_id, email=user.email, display_name=user.display_name,
        ) for user in decision.upserts
    ]
    spark.createDataFrame(rows, member_schema).createOrReplaceTempView(
        "membership_snapshot_source"
    )
    spark.sql(f"""MERGE INTO {target}.group_members t USING membership_snapshot_source s
      ON t.group_id=s.group_id AND t.user_id=s.user_id
      WHEN MATCHED THEN UPDATE SET
        group_name=s.group_name, kind=s.kind, domain=s.domain,
        dataset_tag=s.dataset_tag, managed_by=s.managed_by, email=s.email,
        display_name=s.display_name, last_seen=current_timestamp(), removed_at=NULL
      WHEN NOT MATCHED THEN INSERT
        (group_name,group_id,kind,domain,dataset_tag,managed_by,user_id,email,
         display_name,first_seen,last_seen,removed_at)
      VALUES
        (s.group_name,s.group_id,s.kind,s.domain,s.dataset_tag,s.managed_by,
         s.user_id,s.email,s.display_name,current_timestamp(),
         current_timestamp(),NULL)""")
    if decision.removals:
        ids = ",".join(literal(value) for value in decision.removals)
        spark.sql(
            f"UPDATE {target}.group_members SET removed_at=current_timestamp() "
            f"WHERE group_id={literal(cfg['group_id'])} "
            f"AND user_id IN ({ids}) AND removed_at IS NULL"
        )
    groups_read.append(cfg["group_id"])
    messages.extend(group_messages)
    print(f"{cfg['group_name']}: {len(users)} users; removals {decision.removal_status}")
    return group_messages

# COMMAND ----------
# DBTITLE 1,6. Process all allowlisted groups before escalating warnings
if original_error is None:
    try:
        process_groups(allowlist, process_group)
    except Exception as error:
        original_error = error
        if not str(error).startswith("snapshot warnings:"):
            messages.append(str(error))

# COMMAND ----------
# DBTITLE 1,7. Append run audit and report final status
decision = finalize_snapshot_run(groups_expected, groups_read, original_error, messages)
status, original_error, messages = decision
try:
    spark.createDataFrame(
        [(run_id, started, datetime.now(timezone.utc), status, groups_expected, groups_read,
          unresolved, "; ".join(messages))],
        "run_id string, started_at timestamp, ended_at timestamp, status string, "
        "groups_expected array<string>, groups_read array<string>, "
        "unresolved_members array<string>, message string",
    ).write.mode("append").saveAsTable(f"{catalog}.{schema}.snapshot_runs")
except Exception as audit_error:
    if original_error is None:
        raise
    print(f"Audit append also failed: {audit_error}")
if original_error is not None:
    raise original_error
print(f"Snapshot {run_id} succeeded; tables retained in {target}")
