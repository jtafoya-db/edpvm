# Unity Catalog tenant provisioning notebook

A parameterized, **idempotent**, **re-runnable** Databricks notebook that
provisions one **tenant environment** on Unity Catalog under an **admin-owned**
governance model. It is a generic solution for regulated / public-sector
organizations that need repeatable, auditable per-tenant provisioning. Admins
run it **per environment / per tenant** (e.g. catalogs `dev` / `test` /
`preprod` / `prod`).

- **Dry-run by default.** With `apply=false` the notebook prints the full PLAN
  (every create / grant / tag / ownership transfer it *would* do) and makes
  **zero writes**. Set `apply=true` to execute. Plan and apply are the same code
  path.
- **Idempotent.** Re-running converges: existing resources are detected and
  re-used; grants and tags are re-applied; ownership transfers are skipped when
  already owned.
- **Testable.** All provisioning logic lives in `uc_tenant_provision.py` as pure
  functions with **injected** SDK clients, unit-tested with mocked clients.

## Files

| File | Purpose |
| --- | --- |
| `uc_tenant_provision.py` | Pure logic module (no notebook globals). Get-or-create + grants + tags + ownership, plan/dry-run aware. |
| `provision_notebook.py` | Databricks notebook source. Widgets → clients → module → print plan. Import this into your workspace. |
| `tests/test_uc_tenant_provision.py` | pytest unit tests with mocked `AccountClient` / `WorkspaceClient`. |
| `requirements-dev.txt` | Isolated Python dev deps (pytest + databricks-sdk). Does **not** touch the repo's Node build. |

## What it provisions

Per tenant, in a catalog you supply:

- a **tenant group** with workspace assignment and members (account plane),
- a **schema** in the catalog,
- **data grants** to the tenant group (catalog `USE CATALOG`; schema
  `USE SCHEMA, SELECT, MODIFY, CREATE TABLE` for readwrite, or
  `USE SCHEMA, SELECT` for read),
- a classic **PRO** (non-serverless) SQL **warehouse** with the tenant group
  `CAN_MANAGE`,
- two **cluster policies** (an all-purpose policy with `USER_ISOLATION`, and a
  job policy) with the tenant group `CAN_USE`,
- an **example tag set** on the schema and warehouse,
- and finally the **admin-owned** ownership transfers (below).

## Auth model

Provisioning spans two control planes with different identities:

- **Section A — workspace plane.** Uses `WorkspaceClient()`, which authenticates
  as the **admin's own notebook identity**. No secret required. Covers schema,
  grants, warehouse, cluster policies, schema tags, and ownership.
- **Section B — account plane.** Uses
  `AccountClient(host="https://accounts.cloud.databricks.com", account_id=..., client_id=..., client_secret=...)`
  authenticated by an **account-admin service principal**. Covers tenant group
  get-or-create, workspace assignment, and adding users to the group.

Section B is **skippable**: if `run_account_section=false` **or** the SP secret
is absent, the notebook prints a clear message and continues with Section A
only (it does not error). If Section B is skipped, the tenant group must already
exist in the workspace or Section A **fails loud**.

## Governance model (admin-owned)

The **admin group** owns the provisioned per-tenant assets; the **tenant group**
gets full data access but does not own or manage grants.

- **`admin_group` is required** (widget has no default). It must be an
  **account-level group** (see the preflight below). If blank, provisioning
  **fails loud** — including in dry-run.
- **Schema** — after create + tag + tenant grants, ownership is transferred:
  `ALTER SCHEMA <cat>.<sch> OWNER TO `<admin_group>``. **Idempotent**: the
  current owner is read first (via `schemas.get().owner`) and the transfer is
  **skipped** when it already equals `admin_group`, so an admin-group member can
  re-run cleanly.
- **Catalog** — ownership is **not** transferred: the per-environment catalog is
  shared across tenants. The tenant only gets `USE CATALOG`.
- **Warehouse** — after create + tag + tenant `CAN_MANAGE`, the admin group is
  set as **`IS_OWNER`** via additive `update_permissions`. Group `IS_OWNER` for
  warehouses is not universally supported; if the API rejects it the notebook
  **falls back to admin-group `CAN_MANAGE`** (matched precisely, not a broad
  catch) and logs which was applied. The tenant's `CAN_MANAGE` is preserved.
- **Cluster policies** — cluster policies have **no ownership concept**, so they
  are **governed by workspace admins**, not owned per-tenant. The tenant stays
  at `CAN_USE`; no admin-group ownership is attempted on policies.
- **Tenant schema access is data-only (no `MANAGE`)**: the admin-group owner
  governs grants. Transferring ownership does **not** strip the tenant's data
  grants.

**Ownership transfers run LAST** (after every create / grant / tag) so the
running principal keeps authority to finish. The running principal must be a
**metastore admin or a member of `admin_group`** for the schema transfer, and a
**workspace admin** for the warehouse owner step — otherwise those steps **fail
loud** with an actionable message.

### `admin_group` preflight (fails loud in the plan phase)

Before any write — including in dry-run — the notebook validates that
`admin_group` can actually own Unity Catalog objects. Only **account-level
groups** can own UC securables; **reserved / workspace-local groups** (such as
the built-in `admins` / `users` groups) **cannot**. The preflight reads the
group's SCIM `meta.resourceType` (`"Group"` = account-level and valid;
`"WorkspaceGroup"` = workspace-local and invalid) and **fails loud** with an
actionable message if the group is workspace-local or does not resolve — so an
admin learns the group is unusable without provisioning anything.

## Prerequisites

### Account-level admin group (one-time)

Create the group that will **own** the provisioned assets as an **account-level
group** in the account console (example name `platform-admins`). Workspace-local
groups cannot own UC objects, so the built-in `admins` group will not work — the
preflight above rejects it. Add the operators who will run the notebook to this
group (or run as a metastore admin) so the ownership transfer succeeds.

### Account service principal + secret scope (only for Section B)

Only needed if you want the notebook to create / manage the **tenant** group.

1. **Create an account-admin service principal** in the account console and
   generate an **OAuth secret** (`client-id` / `client-secret`). The SP must be
   an **account admin** (to manage groups + workspace assignments).
2. **Store the OAuth secret in a secret scope** (choose your own scope name;
   the widget default is the example `provisioner`), with keys `client-id` and
   `client-secret`:

   ```bash
   databricks secrets create-scope <your-scope>
   databricks secrets put-secret <your-scope> client-id     --string-value "<sp-client-id>"
   databricks secrets put-secret <your-scope> client-secret --string-value "<sp-oauth-secret>"
   ```

3. Grant the admins who will run the notebook `READ` on the scope.

### Workspace / UC prerequisites

- The admin running Section A is a **workspace admin** and has UC privileges to
  create schemas and grants in the target catalog.
- The target **catalog** already exists (the notebook manages the schema, not
  the catalog itself).
- The workspace is **Unity Catalog enabled** and has permission to create SQL
  warehouses and cluster policies.

## How to run

1. Import `provision_notebook.py` into your Databricks workspace (Repos or
   Workspace import — it is Databricks notebook *source* format).
2. Fill in the widgets (all are examples you replace):
   - `environment`, `catalog` (free text, e.g. an `<env>` such as `dev` /
     `test` / `preprod` / `prod`), `group_name` (tenant group), **`admin_group`**
     (account-level owner group — **required**), `schema_name`,
     `warehouse_name`, `allpurpose_policy_name`, `job_policy_name`, `users`
     (comma-separated), `access_level` (`readwrite` default, or `read`).
   - Example tags: `tenant`, `domain`, `dataset`, `pii`, `project`.
   - Warehouse sizing: `cluster_size` (default `Small`), `auto_stop_mins`,
     `min_num_clusters`, `max_num_clusters`.
   - Section B: `run_account_section` (default `false`), `account_id`,
     `workspace_id`, `secret_scope` (example `provisioner`).
3. **Dry-run first** (`apply=false`, the default): run all cells and read the
   printed PLAN.
4. When the plan looks right, set `apply=true` and re-run.

## Ordered steps

**Section B (account plane, skippable):**
1. Tenant group get-or-create.
2. Assign group to the workspace as `USER`.
3. Add `users` to the group (skips existing members).

**Section A (workspace plane):**
4. Schema get-or-create in `catalog`.
5. Classic **PRO** SQL warehouse (non-serverless) get-or-create; tenant group
   granted `CAN_MANAGE`. (Provisioned before the grants because the grants run
   as SQL through this warehouse.)
6. Grants applied via UC **SQL `GRANT`** run through the warehouse's
   statement-execution endpoint — catalog `USE CATALOG`; schema
   `USE SCHEMA, SELECT, MODIFY, CREATE TABLE` (readwrite) or
   `USE SCHEMA, SELECT` (read). SQL `GRANT` is version-independent and
   idempotent in UC.
7. Two cluster policies get-or-create — all-purpose (`cluster_type`=all-purpose,
   `data_security_mode`=USER_ISOLATION) and job (`cluster_type`=job) — tenant
   group granted `CAN_USE`.
8. Example tags — schema tagged via `ALTER SCHEMA ... SET TAGS`; warehouse
   tagged via `EndpointTags`.

**Ownership (runs LAST):**
9. Schema ownership transferred to `admin_group`
   (`ALTER SCHEMA ... OWNER TO`), idempotently (skipped if already owned).
10. Warehouse admin owner — admin group set `IS_OWNER` (additive), falling back
    to `CAN_MANAGE` if the API rejects group `IS_OWNER`. Tenant `CAN_MANAGE` is
    preserved. Cluster policies are left workspace-admin-governed (no transfer).

## Naming convention (`derive_names`)

`uc_tenant_provision.derive_names()` is currently a **stub** returning the
manual names unchanged. It is the single place to add a future naming convention
(e.g. derive names from environment + tenant) without changing the notebook or
steps.

## Running the tests

The tests mock all SDK clients — no Databricks credentials or network calls.

```bash
python3.12 -m venv .venv-provision
. .venv-provision/bin/activate
pip install -r notebooks/provisioning/requirements-dev.txt
python -m pytest notebooks/provisioning/tests
```
