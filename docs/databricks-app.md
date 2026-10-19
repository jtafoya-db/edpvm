# Serving the EDP Vending Machine as a Databricks App

This is build order step 4 (build-plan-p1.md §4): re-home the standalone
TanStack Start app to a **Databricks App** with **Delta-backed state** fronted
by a **TanStack Query** cache. Lakebase is deferred (not in GovCloud).

> **Current scope.** The P1 seam remains intact. Memory is the default backend
> for previews and dev; the `prod` target builds on Delta. `bundle validate`
> and `bundle deploy` create no table. `scripts/deploy-turnkey.sh` runs the
> `provision_store` job after the deploy. What production still needs is in
> [`production-checklist.md`](production-checklist.md).

## The data-access seam (state layer)

State lives behind a typed seam so the backend is swappable — the same pattern
as the `loadSchema()` seam from issue #1.

- **Interfaces** — `src/data/store.ts`: `CatalogStore`, `RequestStore`,
  `StatusStore`, combined as `DataStore`. The app reads/writes state _only_
  through these.
- **P1 adapter (live)** — `src/data/adapters/memory.ts`: an in-memory store
  seeded from the existing prototype data (`window.AppData`, read via
  `src/data/seed.ts`). The app runs with no backend. Reads return copies and
  writes store copies, so callers can't mutate store/seed state out-of-band.
- **Delta/UC request adapter** — `src/data/adapters/delta.ts`: maps request,
  item, step, transition and waiver-attestation records to SQL statements. Its
  injected client boundary points at a server-side provisioner-SP/M2M proxy;
  tests inject a mock and make no network calls. Other state families fail
  explicitly until their own durable slices land.
- **The seam** — `src/data/loadStore.ts`: `loadStore()` fetches `/api/session`
  once, then returns the active adapter with the server-resolved identity and
  SLA settings. The backend is chosen at **build time** via `VITE_DATA_BACKEND`
  (unset/empty → `memory`; `delta` → the Delta adapter). Any other explicit
  value is a config error and throws — it never silently serves seed data.
  Switching backends is this one line — no caller changes.

### TanStack Query cache

The QueryClient + provider already live at the router root
(`src/routes/__root.tsx`). The hooks in `src/data/queries.ts` sit in front of
the seam — **all three families read through Query**:

- `useCatalog()` — domains/datasets/bundles/systems/personas/tenants
- `useUser()`, `useStages()`, `useMyAccess()`, `usePipeline()`
- `useRequests()` / `useRequest(id)` — the request read paths
- `useRequestStatus(id)` / `useStatuses()` — the status/timeline read paths,
  projected by the `StatusStore` (not re-derived from the request list)
- `useSubmitRequest()` — the write path; optimistically updates the cached list
  **and detail**, rolls **both** back on error, then invalidates the
  `["requests"]` and `["status"]` families so data is re-read through the seam.

`src/data/legacy-bridge.ts` (`useLegacyAppData`) composes these into the single
object the ported screens consume, and exposes one aggregated loading/error
state. `src/components/BrokerApp.tsx` renders explicit **loading** and **error**
states from it — there is **no `window.AppData` fallback**, so a failing backend
(or the Delta adapter) surfaces as an error instead of masking itself
with prototype data. The ported screens read this seam-derived object via
`src/legacy/appDataBridge.js` (`getData()`); `window.AppData` is now referenced
**only** inside `seed.ts` (to seed the in-memory adapter). Submits go through
the `useSubmitRequest` mutation, never local component state.

## Build target

Local dev and the existing production build are unchanged — Vite + the Nitro
Cloudflare worker target remain the default (`npm run build` →
`.output/server/index.mjs` worker). We add a **Node-server** target alongside
it for Databricks Apps (which run a process and route HTTP to it):

```bash
npm run build:databricks   # NITRO_PRESET=node-server vite build
```

This emits a Nitro node-server bundle at `.output/server/index.mjs` that
listens on `PORT` / `NITRO_PORT`.

## Runtime config — `databricks-app/` (prebuilt, no install)

The app compute installs nothing and builds nothing. The deployer's machine
builds the app, and the deploy ships the result.

**What the platform does.** At deploy, Databricks Apps copy the app source
(`source_code_path`) into the container, then look for a dependencies file at
its root. With a `package.json` they run `npm install` against the FedRAMP npm
proxy (`registry.npmjs.org`) and then `npm run build`. With a
`requirements.txt` they run `pip install`. With neither, the deployment log
says `No dependencies file found. Skipping installation.` and goes straight to
the `command`.

Installing at deploy made every deploy depend on the proxy. A proxy that
stopped serving a tarball the lockfile pins (`js-yaml-4.3.2.tgz`, 404) failed
every preview, even though the same lockfile had deployed the day before.

So the app source is [`databricks-app/`](../databricks-app), not the repo root.
It holds no `package.json` and no `requirements.txt`:

```
databricks-app/
  app.yaml          command: node serve.mjs  (committed)
  serve.mjs         launcher                 (committed)
  server/           .output/server, the Nitro node-server bundle  (staged, gitignored)
  public/           .output/public, the static assets              (staged, gitignored)
  build-info.json   { dataBackend, commit, builtAt }               (staged, gitignored)
```

The Nitro node-server build is self-contained. Its server bundle imports only
`node:` built-ins and ships no `node_modules`, so nothing needs installing at
runtime. It is about 4.3 MB and 73 files; the largest file is about 860 KB.
Databricks Apps reject any source file over 10 MB, and `scripts/deploy.sh`
checks that before it deploys.

[`serve.mjs`](../databricks-app/serve.mjs) binds `DATABRICKS_APP_PORT` to
Nitro's `PORT`/`NITRO_PORT` and imports `server/index.mjs`. It refuses to start
in two cases:

- **Nothing is staged.** The error says to deploy with
  `scripts/deploy-turnkey.sh`.
- **The build's `VITE_DATA_BACKEND` differs from the target's.** The bundle
  passes `VITE_DATA_BACKEND=${var.data_backend}` at runtime. A build staged for
  another backend, for example by a bare `bundle deploy` after a different
  build, fails to start rather than serve the wrong store.

**Node version.** The app container runs Node `v22.16.0`, but `package.json`
declares `engines.node >=24`. The engines field covers building, which now
happens on the deployer's machine: `scripts/deploy.sh` refuses to build on a
Node older than 24. The container only runs the
prebuilt server, which needs no Node 24 API. The server has been checked on
22.16.0 in two ways: locally with Node 22.16.0, where `/`, the static assets
and `robots.txt` returned 200, and on a preview deploy, which reached
`RUNNING`. `serve.mjs` logs `node <version>` at start, so every deploy's log
shows the runtime version. If the server starts using a Node 24-only API, it
will fail on the container. Check `node --version` in the container before
relying on one, or wait until Databricks Apps ship Node 24.

**Build toolchain.** The build toolchain (`vite`, `nitro`,
`@lovable.dev/vite-tanstack-config`, `@vitejs/plugin-react`) is still declared
in `dependencies`, so a production install (`NODE_ENV=production npm install`)
can still build. The runtime no longer needs it, because nothing is installed
in the app compute. The deployer's machine still needs `npm ci`, from a
registry it can reach, and Node 24 or newer. The FedRAMP npm proxy is involved
only if a dependency manifest reaches `databricks-app/`, so
`scripts/deploy.sh` refuses to deploy when the app source root contains
anything except `app.yaml`, `serve.mjs`, `build-info.json`, `server/` and
`public/`.

`app.yaml` sets the default production env. When you deploy from the bundle,
the app `config` in `databricks.yml` supplies the command and env, and its
`command` must match `app.yaml`'s; a test checks this. That precedence has been
observed on preview and synthetic-demo deploys, not yet on production. Runtime-only settings
stay in that app config: `EIR_*`, `EDP_STORE_*`, `NODE_ENV` and the group ids.
`VITE_DATA_BACKEND` is the only build-time setting.

## Deploy — `scripts/deploy-turnkey.sh`

[`databricks.yml`](../databricks.yml) describes the app resource. Deploy is
**turnkey** (#138), and there is one operator entry point,
[`scripts/deploy-turnkey.sh`](../scripts/deploy-turnkey.sh), for every target.
A single `--var catalog=<name>` is the one input that configures the store
tables, the EIR tables, the EIR volume and the membership snapshot
(`store_catalog`, `eir_volume_catalog` and `membership_catalog` all default to
it). The wrapper runs the whole flow:

```
scripts/deploy-turnkey.sh -t <target> [-p <profile>] [--production] --var catalog=<catalog> --var sql_warehouse_id=<id> [--var …]
  1. preflight: every input well-formed, and `databricks catalogs get <catalog>` finds the catalog
  2. bundle validate -o json  → resolved-config gate (store/EIR catalog match, no value-less env, prod on Delta with real group ids)
  3. scripts/deploy.sh <args> → plan gate, build, stage into databricks-app/, bundle deploy --auto-approve, bundle run (below)
  4. bundle run provision_store            (store schemas + tables, idempotent)
  5. bundle run provision_membership_snapshot (membership tables, idempotent)
  6. CREATE SCHEMA/VOLUME IF NOT EXISTS    (the EIR schema + volume)
  7. GRANTs to the app service principal, including SELECT-only membership tables
     (EDP admin group, as validators, only with --grant-validator-volume-read)
  8. print the app URL
```

One wrapper command runs several bundle operations (`validate`, `plan`,
`deploy`, two `run`s) and the post-deploy SQL. A bare `bundle deploy` creates
or updates the app, its jobs, its bundle-managed permissions (such as the app's
`CAN_USE` on the warehouse) and, on prod, the EIR schema and volume. It doesn't
run the store DDL, or the wrapper's post-deploy SQL that creates the preview
EIR schema and volume and grants the app's service principal access to them
and to the store schemas.

**What the wrapper doesn't do.** These stay manual, or belong to the production
runbook (#139, open):

- create the catalog, the SQL warehouse, the account groups, their members or
  the governed tags (see [`production-checklist.md`](production-checklist.md));
- create the prod bundle root (see [Production bundle root](#production-bundle-root));
- get the membership jobs ready to run. The wrapper provisions the membership
  tables and grants the app `USE CATALOG`, `USE SCHEMA`, and table-level
  `SELECT` on `group_members` and `snapshot_runs`; it grants no snapshot write
  privilege. On `prod`, `bundle deploy` sets both
  membership schedules `UNPAUSED`. On a fresh target, scheduled runs can fire
  before the wrapper's provisioning step, allowlist and first runs are ready
  and verified. No variable pauses them. Don't treat a prod run as a zero-to-ready membership
  snapshot. Set the jobs up with their schedules paused, rehearse, and turn
  them on as a separate, deliberate step. That staging procedure doesn't exist
  yet and belongs in #139 (`production-checklist.md` section 6);
- check effective (inherited) grants.

The preview and prod commands are below, in
[Per-PR preview deployments](#per-pr-preview-deployments) and
[Production deploy inputs](#production-deploy-inputs). A dev deploy is the same
with `-t dev --var app_name=<your-app-name>`. Run `npm ci` first, because the
build uses this checkout's `node_modules`.

### GovCloud development deploy (Delta)

The `govdev` target is development-only, uses the CLI profile's workspace host,
and forces the Delta backend. Its app, store schemas, and EIR volume must use
isolated names containing `govdev`; preflight rejects production-like names or
a missing numeric EDP admin-group SCIM id before any workspace mutation.

```bash
npm ci

scripts/deploy-turnkey.sh \
  -t govdev \
  -p <govcloud-dev-profile> \
  --var app_name=edp-vm-govdev \
  --var catalog=<existing-catalog> \
  --var store_schema_prefix=edp_vm_govdev_ \
  --var sql_warehouse_id=<16-hex-id> \
  --var eir_volume_name=eir_govdev \
  --var edp_admin_group_id=<numeric-scim-group-id>
```

Create the catalog, warehouse, and account group first. Find the stable numeric
group id in the account SCIM group record (or with the Databricks CLI/API); do
not pass the display name. The profile supplies authentication and the GovCloud
workspace host, while the bundle emits `EDP_ADMIN_GROUP_ID` and the isolated
`EDP_STORE_SCHEMA_PREFIX` into the app runtime.

### The build-and-ship step — `scripts/deploy.sh`

The wrapper's step 3 is [`scripts/deploy.sh`](../scripts/deploy.sh), which
wraps the bundle commands so the build always matches the target. It is
**internal to the wrapper**, not a second entry point: it refuses to run unless
`EDP_DEPLOY_VIA_TURNKEY=1`, which the wrapper exports when it calls it. Run on
its own it would skip the preflight, the resolved-config gate, provisioning and
the grants. The wrapper calls it as:

```
scripts/deploy.sh -t <target> --var app_name=<name> [-p <profile>] [--var …]
scripts/deploy.sh -t prod --production [-p <profile>] [--var …]
  0. check the arguments, the env and Node >=24 (below)
  1. databricks bundle validate <args> -o json   → resolved target, mode, app name, data_backend
  2. check the resolved values (below)
  3. databricks bundle plan <args> -o json        → plan gate: refuse any schema/volume delete or recreate
  4. VITE_DATA_BACKEND=<data_backend> npm run build:databricks
  5. stage .output/server, .output/public and build-info.json into databricks-app/
  6. databricks bundle deploy <args> --auto-approve
  7. databricks bundle run edp_vending_machine <args>
```

`<args>` is the same list in steps 1, 3, 6 and 7: the caller's arguments with
`--production` taken out. The wrapper passes its own `-t`, `-p` and `--var`
arguments, plus `--production` on prod.

**What it enforces.** The script exits with usage text, before calling the CLI,
unless all of these hold:

- **Only supported arguments.** It accepts:
  - `-t`/`--target` as `-t X`, `-tX`, `-t=X`, `--target X` or `--target=X`;
  - `-p`/`--profile` in the same forms;
  - `--var X` or `--var=X`;
  - `--debug` and `--production`.

  Anything else is refused, including:
  - `--auto-approve`, which the script adds to the deploy step itself;
  - the CLI's hidden target aliases `-e`/`--environment`;
  - `--`, other flags, short-flag clusters such as `-qtprod`, and positional
    arguments;
  - a flag value that starts with `-`.

- **Exactly one target.** A second target in any form is refused, even one
  that agrees with the first.
- **No target from the env.** `DATABRICKS_BUNDLE_TARGET`,
  `DATABRICKS_BUNDLE_ENV` and `DATABRICKS_BUNDLE_ROOT` must be unset. The CLI
  reads the first two when `-t` is absent; the third selects another bundle.
- **Non-production targets name their app.** Every target but `prod` needs at
  least one `--var app_name=<name>`, and none may be `edp-vending-machine`.
  `BUNDLE_VAR_app_name` doesn't count as explicit.
- **`-t prod` is acknowledged** with `--production` or
  `EDP_DEPLOY_PRODUCTION=yes`. Only the exact value `yes` counts.
- **Node is 24 or newer**, as `package.json` engines asks.

The script then applies the same rules to what `bundle validate` resolved,
which is what deploy and run use:

- The resolved target must be the one the arguments name.
- If the resolved target is `prod`, or its mode is `production`, the
  acknowledgement is required.
- Otherwise the resolved app name may not be `edp-vending-machine`. This catches
  a target default or a `BUNDLE_VAR_app_name`.

It passes `--auto-approve` only to the deploy step, and only once these checks
and the plan gate pass. For production that means only with the
acknowledgement. Because the deploy is auto-approved, the CLI's own
destructive-action prompt never fires; the plan gate stands in for it (see
[Destroy and redeploy](./eir-volume.md#destroy-and-redeploy)).

`build-info.json` records the target's `dataBackend`, the commit and the build
time. The commit is marked `<sha>-dirty` when the checkout has uncommitted or
untracked changes, so the app's start log shows a build that isn't a commit.
`serve.mjs` refuses to start if any of the three fields is missing.

The script clears the previous staged build before it builds, so a failed build
leaves nothing to ship. After staging, and before `bundle deploy`, it validates
the app source root against the allowlist `app.yaml`, `serve.mjs`,
`build-info.json`, `server/` and `public/`. Any other root entry, including
`package.json` or `requirements.txt`, fails closed with the path to remove or
move; the deploy script does not delete unexpected user files. The unit test
`src/data/__tests__/deploy.test.ts` plants those manifests and another root
file in the deploy fixture and asserts no deploy call occurs. The bundle
`sync.include` uploads the gitignored staged build. Only `databricks-app/`
becomes the app's source, so `src/`, tests and docs are not part of the
deployed unit.

### Required inputs

`catalog` and `sql_warehouse_id` are **required** bundle variables (no default),
so a bare `bundle` command fails naming the missing one instead of deploying the
old placeholder — the invalid `sql_warehouse_id=0000000000000000` default (which
made `bundle deploy` fail with "0 is not a valid endpoint id") is gone.
[`scripts/deploy-preflight.ts`](../scripts/deploy-preflight.ts) (the pure,
unit-tested var-resolution seam in `src/deploy/preflight.ts`) names any
empty/invalid input before any bundle call. Divergence is enforced on
the **resolved** config: the wrapper parses `bundle validate -o json` and
aborts unless the rendered `EDP_STORE_CATALOG == EIR_VOLUME_CATALOG`, so an
override from any source (`--var`, `BUNDLE_VAR_*`, a profile) can't slip a split
catalog past it.

The preflight also asks the workspace whether the catalog exists
(`databricks catalogs get`) and refuses one it can't find, before any bundle
call. A bundle can't create a catalog, and nothing else fails early on a
missing one: the deploy succeeds and only `provision_store` and the app's first
query fail. (A preview once deployed against a default `edp_vending` catalog
that didn't exist, so no store table was ever created.)

Human prerequisites a DAB cannot create — the catalog, the SQL warehouse, and
the SCIM account groups — stay documented in
[`production-checklist.md`](production-checklist.md). The `prod` host comes from
the CLI profile you deploy with (`-p <prod-profile>`); it can't be a `--var`
because `workspace.host` is resolved during auth, before variable interpolation.

`--skip-grants` is a **recovery/debug option only**: it deploys, provisions and
creates the EIR volume without applying any Unity Catalog grant, so the app
can't read or write the store until a full run applies them. Don't use it for a
normal deploy, and never for a normal prod deploy.

### Production deploy inputs

A prod deploy must pass every one of these; the preflight refuses a missing or
placeholder value, and the wrapper's resolved-config gate refuses a prod config
that still renders a `configure-*` placeholder or isn't on Delta:

```bash
scripts/deploy-turnkey.sh -t prod --production -p <prod-profile> \
  --var catalog=<catalog> \
  --var sql_warehouse_id=<warehouse-id> \
  --var prod_root_path=/Workspace/edp-deploy/edp-vending-machine/prod \
  --var edp_admin_group_id=<scim id> \
  --var membership_job_sp=<service principal application id>
```

- `edp_admin_group_id` is the numeric stable SCIM id of an **account** group,
  the EDP admin group. In the MVP its members hold every staff role: EDP staff,
  Safeguards validator, EDP business office and CCB (#226, ADR-0008). Prod emits
  it as `EDP_ADMIN_GROUP_ID`; without a real id nobody holds a staff role in
  production.
- `safeguards_validator_group_id`, `business_office_group_id` and
  `ccb_group_id` are reserved for a later role split. The app ignores them, the
  bundle renders no env entry for them, and the preflight warns if one is
  supplied. Don't pass them.
- `membership_job_sp` is the application id (a UUID) of the service principal
  both prod membership snapshot jobs run as (`run_as`; see
  [`group-membership-snapshot.md`](group-membership-snapshot.md)). It has no
  default; the preflight refuses an omitted value or one that isn't a UUID.
- `data_backend` defaults to `delta` on prod; passing `memory` is refused.
- `--production` (or `EDP_DEPLOY_PRODUCTION=yes`) is the deliberate
  acknowledgement; the wrapper refuses `-t prod` without it and passes it on to
  `scripts/deploy.sh`.
- The host comes from `-p <prod-profile>`, not from `databricks.yml`. Check
  that profile's host before deploying.
- `prod_root_path` must be a folder the deployment group owns, never a
  personal folder or worktree.
- **SLA settings are deploy-time bundle variables** (#157, #156, now
  integrated into PR #150). Add `--var <name>=<value>` for the deploying
  human's agreed values; see "SLA configuration" for names, defaults and
  validation constraints. The command above omits these optional overrides,
  so it uses provisional defaults, not agreed production targets. Record any
  defaults intentionally retained (#146), and verify the effective settings
  through `/api/session` on the deployed build.
- **The pilot configuration is an optional deploy-time setting** (#123). Add
  `--var pilot_config_json='<json>'` to load the pilot initiative, tenant,
  datasets and owners; the shape is in
  [`delta-backend.md`](delta-backend.md#the-pilot-configuration). Left at
  `none` (the default), production loads no datasets, never the sample. A
  loaded configuration can't be unloaded, so review the JSON before the first
  deploy (see `docs/production-checklist.md`, section 3).

### Production bundle root

The prod bundle root (`prod_root_path`) holds the deployed app source and the
bundle state, so whoever can write to it can change what the app runs. It's a
required prod variable with no usable default (the committed default isn't a
path, so a prod bundle command without it fails). The preflight refuses
`/Workspace/Shared` and anything under it, which every workspace user can write
to, and anything that isn't an absolute folder under `/Workspace/`.

Use a folder owned by the EDP deployment group or the deploying service
principal, with `CAN_MANAGE` limited to that group. Create it once, as a
workspace admin, at the top level of `/Workspace` (not under `Shared` or a
person's `Users` folder, so the only inherited grant is workspace `admins`):

```bash
ROOT=/Workspace/edp-deploy/edp-vending-machine/prod
databricks workspace mkdirs "$ROOT" -p <prod-profile>
OBJ=$(databricks workspace get-status "$ROOT" -p <prod-profile> -o json | jq -r .object_id)
databricks workspace set-permissions directories "$OBJ" -p <prod-profile> --json '{
  "access_control_list": [
    {"group_name": "<edp-deployment-group>", "permission_level": "CAN_MANAGE"}
  ]
}'
# For a deploying service principal instead of a group, use
#   {"service_principal_name": "<sp-application-id>", "permission_level": "CAN_MANAGE"}
databricks workspace get-permissions directories "$OBJ" -p <prod-profile> -o json
```

`set-permissions` replaces the folder's direct grants. Check the
`get-permissions` output: it should list only the deployment group (direct) and
inherited `admins` (plus the creating admin if you made it under their folder),
and never `users`. The commands were tried on `example-workspace` with a scratch
folder: the result was the named group (direct) and inherited `admins` plus the
parent folder's owner. `bundle validate --strict -t prod` with
`prod_root_path=/Workspace/edp-deploy/edp-vending-machine/prod` passes with no
warning.

### SLA configuration

SLA settings are deploy-time bundle variables. The app reads and validates them
once at startup, then returns the effective values from `/api/session`. Invalid
integers, blank values, out-of-range values or invalid holiday dates log a clear
startup error and stop the app process instead of falling back per request.

| Bundle variable                             | Runtime env                                     | Default                                      | Range / format                                                 |
| ------------------------------------------- | ----------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `sla_edp_roi_review_business_days`          | `EDP_SLA_EDP_ROI_REVIEW_BUSINESS_DAYS`          | `5`                                          | integer, 1-60 business days                                    |
| `sla_ccb_business_days`                     | `EDP_SLA_CCB_BUSINESS_DAYS`                     | `5`                                          | integer, 1-60 business days                                    |
| `sla_eir_validation_business_days`          | `EDP_SLA_EIR_VALIDATION_BUSINESS_DAYS`          | `3`                                          | integer, 1-60 business days                                    |
| `sla_access_request_decision_business_days` | `EDP_SLA_ACCESS_REQUEST_DECISION_BUSINESS_DAYS` | `3`                                          | integer, 1-60 business days                                    |
| `sla_due_soon_business_days`                | `EDP_SLA_DUE_SOON_BUSINESS_DAYS`                | `1`                                          | integer, 0-60 business days                                    |
| `sla_holidays`                              | `EDP_SLA_HOLIDAYS`                              | `[]` (or comma-separated `YYYY-MM-DD` dates) | `[]` or comma-separated real ISO dates, for example 2026-10-14 |
| `eir_validity_days`                         | `EDP_EIR_VALIDITY_DAYS`                         | `365`                                        | integer, 1-3650 calendar days                                  |
| `access_request_sla_provisional`            | `EDP_ACCESS_REQUEST_SLA_PROVISIONAL`            | `true`                                       | `true` or `false`                                              |

### One-time Delta store setup

The bundle also defines `provision_store`, an explicit SQL job backed by
[`resources/store-schema.sql`](../resources/store-schema.sql). Deployment only
creates/updates the job; it does **not** run DDL. The wrapper runs it for you;
to run it standalone (idempotent — safe to rerun):

```bash
databricks bundle run provision_store -t dev \
  --var catalog=<catalog> \
  --var sql_warehouse_id=<warehouse-id>
```

All schemas and tables use `CREATE ... IF NOT EXISTS`. Request and waiver rows
carry the stable SCIM principal id required by ADR-0004. The app's server runs
its Delta statements as the app's own service principal, on the warehouse
named by the app's `sql-warehouse` resource, with OAuth credentials Databricks
injects. Those credentials are never passed to the browser.

**Bundle-managed UC objects (prod).** On the `prod` target the EIR volume and
its parent schema are declared as bundle resources (`resources.schemas`,
`resources.volumes`) with `lifecycle.prevent_destroy`, so `bundle deploy -t
prod` creates them and no bundle command can drop them (see
[Destroy and redeploy](./eir-volume.md#destroy-and-redeploy)). Grants aren't
declared in the bundle; the wrapper applies them. They're declared only on `prod`
because `mode: development` (preview/dev) rewrites a UC schema/volume name to
`dev_<user>_<name>`, which would no longer match the fixed `EIR_VOLUME_SCHEMA`
the server reads. The store schemas stay in the `provision_store` job (they're
created alongside their tables, which have no DAB resource). The app's own
service principal is granted `READ/WRITE VOLUME` and store-schema privileges by
the wrapper — its id isn't resolvable at bundle-config time. The wrapper never
grants to a broad group, and gives the EDP admin group (which holds the
Safeguards validator role in the MVP) direct volume access only with
`--grant-validator-volume-read`. It grants to the one app service principal
that exists today; per-principal rights for ADR-0008's tenant app, staff app and
Apply job are a known limitation until those principals exist.

### Per-PR preview deployments

EIR previews use an isolated Unity Catalog volume named with an explicit
`--var eir_volume_name=eir_pr<N>`. The wrapper **creates that volume (and its
parent schema) and applies the app service principal's grants automatically** via idempotent
`CREATE ... IF NOT EXISTS` / `GRANT` — there is no manual pre-step. See
[EIR Unity Catalog volume](./eir-volume.md#per-pr-preview-volume) for the exact
statements and the cleanup procedure; `bundle destroy` does not drop that volume.

Give each PR its own Databricks App name and isolated bundle state by supplying
`app_name` at deploy time. `-t preview` **must** be paired with
`--var app_name=edp-vm-pr<N>`; if the variable is omitted, the target resolves
to the non-production sentinel `edp-vm-preview-unset` instead of the production
app name. Replace `<N>` with the PR number, and pass your own SCIM user id
(`databricks current-user me -p example-workspace`) as `seed_dataset_owner_ids`
so you own the sample dataset. The preview defaults `edp_admin_group_id`, the
group that holds every staff role, to `edp-admins` (`11111111111111`); the
preflight refuses
an explicitly empty value, which would fail the deploy with "Must specify
environment variable source":

```bash
scripts/deploy-turnkey.sh -t preview -p example-workspace \
  --var app_name=edp-vm-pr<N> \
  --var catalog=example_catalog \
  --var store_schema_prefix=edp_vm_pr<N>_ \
  --var sql_warehouse_id=1111111111111111 \
  --var eir_volume_name=eir_pr<N> \
  --var edp_admin_group_id=11111111111111 \
  --var seed_dataset_owner_ids=<your SCIM user id>
```

Add `--var data_backend=delta` for a Delta preview. The build uses it, and the
app's log shows the baked value at start:
`[serve] prebuilt server: commit <sha>, VITE_DATA_BACKEND=delta, …`. The
wrapper prints the URL at the end; to get it again:

```bash
databricks apps get edp-vm-pr<N> -p example-workspace -o json | jq -r .url
```

The deploy log (`databricks apps logs edp-vm-pr<N> -p example-workspace`) should
show `No dependencies file found. Skipping installation.` and
`Starting app with command: [node serve.mjs]`, with no npm lines.

Stop an idle preview and destroy its bundle resources when the PR closes:

```bash
databricks apps stop edp-vm-pr<N> -p example-workspace
databricks bundle destroy -p example-workspace -t preview --var app_name=edp-vm-pr<N> --var catalog=example_catalog --var sql_warehouse_id=<warehouse-id> --auto-approve
```

`catalog` and `sql_warehouse_id` are required for every `bundle` command on a
target (they resolve into the app/job config), so `destroy` needs them too.

The per-PR procedure is verified through preview deployments. Production
workspace configuration remains environment-specific and must be verified at
release time.

## What is P1 vs. deferred

| Item                                                  | P1                     | Deferred                       |
| ----------------------------------------------------- | ---------------------- | ------------------------------ |
| Typed state seam (`DataStore` + repositories)         | ✅ live                |                                |
| In-memory adapter (seeded from prototype data)        | ✅ live                |                                |
| TanStack Query cache + hooks in front of the seam     | ✅ live                |                                |
| Catalog + request + status reads routed through Query | ✅ live                |                                |
| Submit routed through the seam mutation (no local)    | ✅ live                |                                |
| Loading/error surfaced (no seed fallback)             | ✅ live                |                                |
| Delta/UC request adapter                              | ✅ P4 SQL client seam  | catalog/access slices          |
| Delta tables in Unity Catalog                         | ✅ bundle provisioning | explicit UAT job run           |
| Databricks App configs (`databricks-app/`, bundle)    | ✅ preview-verified    | production deploy              |
| Node-server build target                              | ✅ `build:databricks`  |                                |
| Lakebase                                              | —                      | out of scope (not in GovCloud) |
| FMAPI / Model-Serving backend for the LLM challenger  | referenced (§3)        | later phase                    |
