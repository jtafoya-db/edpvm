# Databricks notebook source
# MAGIC %md
# MAGIC # Unity Catalog Tenant Provisioning
# MAGIC
# MAGIC Parameterized, **idempotent**, **re-runnable** provisioning for one tenant
# MAGIC environment on Unity Catalog. Ships to admins to run **per environment /
# MAGIC per tenant**. Generic solution for regulated / public-sector organizations.
# MAGIC
# MAGIC - **Dry-run by default** (`apply=false`): prints the full PLAN, makes ZERO writes.
# MAGIC - Set `apply=true` to execute. The plan and apply are the *same* code path.
# MAGIC - Logic lives in the importable, unit-tested `uc_tenant_provision` module; this
# MAGIC   notebook is only thin orchestration (widgets → clients → module → print).
# MAGIC
# MAGIC ## Auth model
# MAGIC - **Section A (workspace plane):** uses `WorkspaceClient()` = the admin's own
# MAGIC   notebook identity. No secret required.
# MAGIC - **Section B (account plane):** uses `AccountClient(...)` authenticated by an
# MAGIC   account-admin service principal whose OAuth `client-id` / `client-secret`
# MAGIC   live in a secret scope (example name `provisioner` — set your own). Section B
# MAGIC   is **skipped** (not an error) when `run_account_section=false` or the secret
# MAGIC   is absent.
# MAGIC
# MAGIC ## Governance (admin-owned)
# MAGIC - The **admin group** (`admin_group`, **required**) OWNS the provisioned
# MAGIC   per-tenant assets: it becomes the **schema owner** and the warehouse
# MAGIC   **IS_OWNER** (falls back to CAN_MANAGE if the API rejects group IS_OWNER).
# MAGIC - The **tenant group** gets full **data access** (USE_CATALOG on the catalog;
# MAGIC   USE_SCHEMA/SELECT/MODIFY/CREATE_TABLE on the schema for readwrite) but does
# MAGIC   **not** own the schema and is **not** granted MANAGE — the admin-group owner
# MAGIC   governs grants.
# MAGIC - The per-env **catalog is shared** across tenants, so its ownership is left
# MAGIC   untouched (tenant only gets USE_CATALOG).
# MAGIC - **Cluster policies are governed by workspace admins**, not owned per-tenant:
# MAGIC   policies have no ownership concept, so the tenant stays at CAN_USE and no
# MAGIC   admin-group ownership is attempted on them.
# MAGIC - Ownership transfers run **LAST** (after create + tag + tenant grants) so the
# MAGIC   running principal keeps authority to finish. The running principal must be a
# MAGIC   metastore admin or member of `admin_group` (schema owner transfer) and a
# MAGIC   workspace admin (warehouse owner) — otherwise the step FAILS LOUD.
# MAGIC
# MAGIC See `README.md` in this folder for one-time per-env setup.

# COMMAND ----------

# MAGIC %md ## 1. Widgets (inputs)

# COMMAND ----------

dbutils.widgets.text("environment", "test", "Environment")
# catalog is free text (manual), e.g. <env> such as dev / test / preprod / prod
dbutils.widgets.text("catalog", "test", "Catalog (manual)")
dbutils.widgets.text("group_name", "tenant-analysts", "Tenant group name")
# admin_group OWNS the provisioned assets. REQUIRED (no default) — blank fails
# loud. Set it to your account-level admin group, e.g. `platform-admins`.
dbutils.widgets.text("admin_group", "", "Admin group (owns assets, REQUIRED)")
dbutils.widgets.text("schema_name", "analytics", "Schema name")
dbutils.widgets.text("warehouse_name", "tenant-analysts-wh", "Warehouse name")
dbutils.widgets.text("allpurpose_policy_name", "tenant-analysts-allpurpose", "All-purpose policy name")
dbutils.widgets.text("job_policy_name", "tenant-analysts-job", "Job policy name")
dbutils.widgets.text("users", "", "Users (comma-separated)")
dbutils.widgets.dropdown("access_level", "readwrite", ["readwrite", "read"], "Access level")

# Tag values (example tag set — keys are fixed for this round)
dbutils.widgets.text("tenant", "", "Tag: tenant")
dbutils.widgets.text("domain", "", "Tag: domain")
dbutils.widgets.text("dataset", "", "Tag: dataset")
dbutils.widgets.text("pii", "false", "Tag: pii")
dbutils.widgets.text("project", "", "Tag: project")

# Warehouse sizing
dbutils.widgets.text("cluster_size", "Small", "Warehouse cluster size")
dbutils.widgets.text("auto_stop_mins", "10", "Warehouse auto-stop (mins)")
dbutils.widgets.text("min_num_clusters", "1", "Warehouse min clusters")
dbutils.widgets.text("max_num_clusters", "1", "Warehouse max clusters")

# Execution + Section B controls
dbutils.widgets.dropdown("apply", "false", ["false", "true"], "APPLY (false = dry-run)")
dbutils.widgets.dropdown("run_account_section", "false", ["false", "true"], "Run Section B (account)")
dbutils.widgets.text("account_id", "", "Account id (Section B)")
dbutils.widgets.text("workspace_id", "", "Workspace id (Section B)")
dbutils.widgets.text("secret_scope", "provisioner", "Secret scope (Section B)")

# COMMAND ----------

# MAGIC %md ## 2. Make the logic module importable

# COMMAND ----------

import os
import sys

# Notebook working dir contains this .py; add it so `uc_tenant_provision` imports.
_here = os.path.dirname(os.path.abspath("__file__")) if "__file__" not in dir() else os.path.dirname(os.path.abspath(__file__))
for _candidate in {os.getcwd(), _here}:
    if _candidate and _candidate not in sys.path:
        sys.path.insert(0, _candidate)

import uc_tenant_provision as prov

# COMMAND ----------

# MAGIC %md ## 3. Build the config from widgets

# COMMAND ----------


def _int(name, default):
    raw = dbutils.widgets.get(name).strip()
    return int(raw) if raw else default


def _users():
    raw = dbutils.widgets.get("users").strip()
    return [u.strip() for u in raw.split(",") if u.strip()]


config = prov.ProvisionConfig(
    environment=dbutils.widgets.get("environment").strip(),
    catalog=dbutils.widgets.get("catalog").strip(),
    group_name=dbutils.widgets.get("group_name").strip(),
    admin_group=dbutils.widgets.get("admin_group").strip(),
    schema_name=dbutils.widgets.get("schema_name").strip(),
    warehouse_name=dbutils.widgets.get("warehouse_name").strip(),
    allpurpose_policy_name=dbutils.widgets.get("allpurpose_policy_name").strip(),
    job_policy_name=dbutils.widgets.get("job_policy_name").strip(),
    users=_users(),
    access_level=dbutils.widgets.get("access_level").strip(),
    tenant=dbutils.widgets.get("tenant").strip(),
    domain=dbutils.widgets.get("domain").strip(),
    dataset=dbutils.widgets.get("dataset").strip(),
    pii=dbutils.widgets.get("pii").strip(),
    project=dbutils.widgets.get("project").strip(),
    cluster_size=dbutils.widgets.get("cluster_size").strip(),
    auto_stop_mins=_int("auto_stop_mins", 10),
    min_num_clusters=_int("min_num_clusters", 1),
    max_num_clusters=_int("max_num_clusters", 1),
    account_id=dbutils.widgets.get("account_id").strip(),
    workspace_id=_int("workspace_id", 0),
)

# derive_names() is currently a stub (identity). Future naming conventions
# plug in here without touching the rest of the notebook.
config = prov.derive_names(config)

APPLY = dbutils.widgets.get("apply").strip().lower() == "true"
DRY_RUN = not APPLY

print(f"Environment : {config.environment}")
print(f"Catalog     : {config.catalog}")
print(f"Tenant group: {config.group_name}")
print(f"Admin group : {config.admin_group or '(MISSING — required)'}")
print(f"Mode        : {'APPLY' if APPLY else 'DRY-RUN (no writes)'}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Build clients
# MAGIC
# MAGIC - Section A: `WorkspaceClient()` = the admin's notebook identity.
# MAGIC - Section B: `AccountClient(...)` via the SP OAuth secret. Skipped cleanly
# MAGIC   if `run_account_section=false` or the secret scope/keys are missing.

# COMMAND ----------

from databricks.sdk import AccountClient, WorkspaceClient

# Section A — always available (the admin's own identity).
workspace_client = WorkspaceClient()

# Section B — build only if requested AND the SP secret is present.
account_client = None
run_account = dbutils.widgets.get("run_account_section").strip().lower() == "true"
secret_scope = dbutils.widgets.get("secret_scope").strip()

if not run_account:
    print("Section B (account plane) SKIPPED: run_account_section=false.")
else:
    try:
        client_id = dbutils.secrets.get(scope=secret_scope, key="client-id")
        client_secret = dbutils.secrets.get(scope=secret_scope, key="client-secret")
        account_client = AccountClient(
            host="https://accounts.cloud.databricks.com",
            account_id=config.account_id,
            client_id=client_id,
            client_secret=client_secret,
        )
        print(f"Section B (account plane) ENABLED via secret scope '{secret_scope}'.")
    except Exception as exc:  # scope/keys absent → skip, do not error
        account_client = None
        print(
            "Section B (account plane) SKIPPED: could not read SP secret from "
            f"scope '{secret_scope}' (client-id / client-secret). Detail: {exc}"
        )

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Provision (Section B first, then Section A) and print the PLAN
# MAGIC
# MAGIC With `apply=false` this prints every intended action and writes nothing.
# MAGIC With `apply=true` the same steps execute. If Section B was skipped and the
# MAGIC group does not already exist in this workspace, this FAILS LOUD.
# MAGIC
# MAGIC UC grants are applied via SQL `GRANT` run through the provisioned
# MAGIC warehouse's statement-execution endpoint (version-independent, idempotent),
# MAGIC so the warehouse is created just before the grants.
# MAGIC
# MAGIC `admin_group` is **required**: if blank this FAILS LOUD (dry-run too). The
# MAGIC plan lists the planned ownership transfers (schema OWNER TO admin group;
# MAGIC warehouse admin IS_OWNER/CAN_MANAGE), which execute LAST on apply.

# COMMAND ----------

ctx = prov.provision(
    config=config,
    workspace_client=workspace_client,
    account_client=account_client,
    dry_run=DRY_RUN,
)

print(prov.format_plan(ctx))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Result
# MAGIC
# MAGIC - Dry-run: review the plan above, then re-run with `apply=true`.
# MAGIC - Apply: the actions above marked `APPLY` were executed. Re-running is safe
# MAGIC   (idempotent) — existing resources are detected and grants/tags converge.

# COMMAND ----------

if DRY_RUN:
    print("DRY-RUN complete. No changes were made. Set apply=true to execute.")
else:
    _writes = sum(1 for a in ctx.actions if a.write)
    print(f"APPLY complete. {_writes} write action(s) executed. Re-run is idempotent.")
