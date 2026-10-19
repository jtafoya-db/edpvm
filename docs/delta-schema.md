# Delta table shapes implied by the data seam

> **Legacy schema.** This describes the #72 store that exists today. [ADR-0007](adr/0007-mvp-delta-data-model.md) and [the data model](data-model.md) define the target. Do not add new application tables here.

The data-access seam (`src/data/store.ts`) models three state families —
**catalog**, **request** and **status**. This document describes the Delta
tables (in Unity Catalog) that the deferred Delta/UC adapter
(`src/data/adapters/delta.ts`) will read/write. P1 runs entirely on the
in-memory adapter seeded from the prototype data (`src/legacy/appData.js`), so
these tables do not exist yet — they are the target the seam is designed
against, so the swap is a one-adapter change (build-plan-p1.md §4; Lakebase
deferred — not in GovCloud).

Suggested UC layout: one catalog (e.g. `edp_vending`) with schemas `catalog`,
`requests`, `access`, `admin`.

## Catalog (reference / dimension)

### `catalog.source_systems`

| column | type   | notes           |
| ------ | ------ | --------------- |
| id     | STRING | PK (e.g. `mef`) |
| name   | STRING |                 |
| short  | STRING |                 |
| org    | STRING |                 |
| type   | STRING |                 |

### `catalog.domains`

| column      | type          | notes                    |
| ----------- | ------------- | ------------------------ |
| id          | STRING        | PK                       |
| name        | STRING        |                          |
| code        | STRING        |                          |
| color       | STRING        | UI accent token          |
| aliases     | ARRAY<STRING> |                          |
| description | STRING        |                          |
| use_cases   | ARRAY<STRING> |                          |
| systems     | ARRAY<STRING> | FK → `source_systems.id` |
| steward     | STRING        |                          |
| owner       | STRING        |                          |

### `catalog.access_bundles` (+ `catalog.bundle_components`)

`access_bundles`: `id` (PK), `name`, `persona`, `color`, `description`, `sla`,
`bears_required` BOOLEAN, `approval_model`, `approvers` ARRAY<STRING>,
`prerequisites` ARRAY<STRING> (FK → bundle ids), `requestable` BOOLEAN,
`unlocks` ARRAY<STRING>.

`bundle_components` (one row per grant, FK `bundle_id` → `access_bundles.id`):
`component_type` STRING (`bears_role|sailpoint_group|dbx_workspace|dbx_entitlement|dbx_group|uc_grant`),
`label` STRING, `scope` STRING.

### `catalog.datasets` (+ `dataset_required_bundles`, `dataset_lineage`)

`datasets`: `id` (PK), `asset_type` (`table|view|dashboard|genie`), `name`,
`business_name`, `domain` (FK), `system` (FK), `classification`,
`certification`, `usage_type`, `freshness`, `popularity` INT, `owner`,
`steward`, `catalog`, `schema`, `object`, `workspace`, `tags` ARRAY<STRING>,
`description`.

`dataset_required_bundles` (FK `dataset_id`): `bundle` (FK → bundle id),
`requirement` (`required|alternative|optional`), `note`.

`dataset_lineage` (FK `dataset_id`): `step_order` INT, `node` STRING.

### `catalog.onboarding_personas`

`id` (PK), `label`, `desc`, `bundles` ARRAY<STRING> (FK → bundle ids).

## Request

### `requests.access_requests` (+ `request_items`, `request_steps`)

`access_requests`: `id` (PK, e.g. `REQ-2041`), `title`, `submitted_at`
TIMESTAMP, `status`, `overall`, `purpose`, `stage_index` INT.

`request_items` (FK `request_id`): `kind` (`Dataset|Bundle|Onboarding`),
`ref`, `dataset_id`, `bundle_id`, `label`, `sub`.

`request_steps` (FK `request_id`, ordered) — the approval/provisioning
timeline: `step_order` INT, `system` STRING, `status`
(`done|active|pending|blocked`), `detail`, `ticket`, `error`.

### `requests.pipeline` (+ `pipeline_decisions`)

Admin enterprise view. `pipeline`: `id` (PK), `kind` (`onboard|access`),
`title`, `tenant`, `requester`, `submitted_at`, `state`, `stage`,
`next_action`, `owner`, `age_days` INT, `jira`, `jira_status`, `monthly_cost`
DECIMAL, `roi` DOUBLE (nullable), `sensitivity`, `pattern`, `delivery`.

`pipeline_decisions` (FK `pipeline_id`): `at`, `actor`, `decision`, `note`,
`jira`.

## Status / access

Status is a **read projection** over `requests.access_requests` +
`requests.request_steps` (`getRequestStatus` joins them), plus:

### `access.my_access`

The current user's active access. `access.my_access_workspaces`
(`name`, `entitlement`, `since`), `access.my_access_bundles` (`bundle` FK,
`since`, `status`, `expires` nullable, `domain` nullable), and scalar arrays
for `domains` / `recent_assets`.

### `admin.tenants`

`id` (PK), `name`, `lead`, `fy_budget`, `fytd_spend`, `mtd_spend`,
`forecast_fy`, `dbus_month`, `storage_tb`, `users` INT, `datasets` INT,
`open_items` INT.

## Write path

Only `requests.*` is written by the app today (`RequestStore.createRequest`
when a tenant submits a cart). Catalog/status tables are read-only from the
app's perspective (populated by upstream governance/provisioning jobs). A live
Delta adapter would `INSERT` the new request + its items + initial steps,
likely via the Databricks SQL Statement Execution API (or a Model-Serving /
FMAPI-fronted path per build-plan-p1.md §3).

## Persistence & identity backbone (ADR-0004)

The tables above are the pre-existing design. This section adds the
**identity + attestation** model required to attribute actions (e.g. an LDW
attestation) to the real signed-in Databricks principal. See
[`adr/0004-persistence-identity-backbone.md`](./adr/0004-persistence-identity-backbone.md).

### Identity / principal convention

The signed-in user is resolved server-side from the Databricks App forwarded
identity (not the seed). Records store a **stable account principal id** plus a
display **username/email**:

- `requests.access_requests` gains `requester_principal_id` (stable SCIM id) and
  `requester_username`. `requester` free-text is retained for display only.
- `requests.pipeline_decisions.actor` is replaced by `actor_principal_id`
  (stable id) + `actor_username` (display) — no more free-string actor.

For MVP there is **no separate `users`/`principals` table**; the principal id +
username are denormalized onto each record. A synced profile table + SCIM sync
is deferred until profile attributes are needed.

### `requests.waiver_attestations`

One row per (request, checklist item, attestor) — the durable, auditable record
of a live-data-waiver attestation:

`id` (PK) · `request_id` (FK -> access_requests) · `checklist_item_id` (the
waiver checklist item key) · `attestor_principal_id` (stable SCIM id) ·
`attestor_username` (display) · `attested` BOOLEAN · `attested_at` TIMESTAMP ·
`note` (nullable) · `source` (e.g. `app`) · audit columns
(`created_at`, `superseded_at` nullable for re-attestation history).

Attestation is **append-oriented**: a re-attestation writes a new row and marks
the prior `superseded_at`, preserving the full audit trail rather than mutating
in place.

### Write path (updated)

Request + attestation writes are performed by the **app server backend
authenticating as the provisioner service principal (OAuth M2M)** behind an
**admin-gated endpoint that emits an audit record**. A Databricks Asset Bundle
creates `requests.waiver_attestations` (and the other `requests.*` /
`catalog.*` tables) in the target catalog. The user's OBO token is
workspace-scoped and used for identity resolution + per-user reads; account-plane
work stays on the SP. The `memory` adapter remains the local/dev + test backend
behind the same seam.
