# The Delta backend: commands, reads and DDL

How the app reads and writes its Delta tables (#76), and how an area ticket
(#123–#126) adds its own. The design comes from [ADR-0007](adr/0007-mvp-delta-data-model.md)
and [`data-model.md`](data-model.md) ("How a write works").

## The shape

```
browser (VITE_DATA_BACKEND=delta)
  src/data/adapters/delta.ts      fetch only: no SQL, no actor, no credentials
        │  GET  /api/reads/<area>/<read>?…
        │  POST /api/commands/<area>/<command>  { idempotencyKey, expectedVersion, payload }
        │  POST /api/legacy-writes/<area>/<write>  { payload }   (#72's cart requests only)
        ▼
server  src/server/delta/api.ts   routes, strict envelope, session → actor, error mapping
        │
        ├── registry.ts           what each area registers (commands, reads)
        ├── transaction.ts        the runner: idempotency, BEGIN ATOMIC, retries
        ├── write-helpers.ts      the two table patterns, actor columns, display codes and numbers
        ├── sql-builder.ts        bound parameters, quoted identifiers, the atomic block
        └── sql-client.ts         Statement Execution API as the app's service principal
        ▼
SQL warehouse → Unity Catalog managed tables (catalog commits on)
```

- **No SQL endpoint exists.** Unknown paths under `/api/commands`,
  `/api/legacy-writes` and `/api/reads` are 404. A command body with any key
  other than the three above is 400, a legacy write body with anything but
  `payload` is 400, and every payload schema is `.strict()`.
- **The actor comes from the session** (`resolveSessionIdentity`, ADR-0004).
  `actor_principal_id`, `actor_display` and `actor_app` are written by the
  helpers from it; no helper takes an actor from a payload.
- **The service principal's credentials stay on the server**
  (`DATABRICKS_CLIENT_ID`/`_SECRET`, injected by Databricks Apps). Nothing in
  `VITE_*` is secret; the browser doesn't even know the warehouse.
- **Every statement starts with `/* edp_action_id=<uuid> */`** (or
  `edp_read_id` for a read), written by the client from a validated UUID, so
  query history joins to the action row.

## How a command runs

`runner.runCommand(definition, input)`:

1. The command JSON is `{ area, command, actor, expectedVersion, payload }`,
   canonicalised; `command_hash` is its SHA-256.
2. Look up the lead action by `idempotency_key` in the command's
   `leadActionTable`. Same hash: return the stored result (`replayed: true`),
   built from the response row the original block stored (`result`), so it's
   exactly the original response even if the record has moved on since.
   Different hash: 409 `idempotency-key-reused`.
3. The handler's `plan(ctx)` adds statements and guards to one
   `BEGIN ATOMIC … END` block. Guards are `IF … THEN SIGNAL`, so a failed
   rule rolls the whole block back.
4. The runner reads the handler's `resultRow` query inside the block (after
   the plan's writes) as `to_json(struct(*))`, and adds the lead action (with
   `command`, `command_hash`, `expected_effects` and that `result`), a guard
   that the key is still unused, a guard that every expected row and the
   result row exist, and a final `SELECT … AS num_affected_rows, … AS result`.
   The response is built from that row, on the first call and on every replay.

   **A create skips the row counts, and usually the re-read (#173).** A
   command is a create when its record and every other expected effect are
   rows `insertRow` inserted (`insertCurrentState`, `insertAction`, or
   `insertRow` + `expectRow`), and no other statement in the block mentions
   any of those tables or the lead action table (by name, any case, however
   quoted) or names a table at run time (`IDENTIFIER(…)`, `EXECUTE
IMMEDIATE`). It fails closed: a raw `ctx.block.add` statement that might
   touch one of those tables keeps every guard and the re-read. A create gets
   no post-insert `count(*)` guards: an all-or-nothing block that commits has
   committed its inserts. Its final `SELECT` is just `… AS action_id, … AS
result`. If its `resultRow` is exactly `SELECT <columns> FROM <the created
table> WHERE id = <recordId>`, the response is built from the inserted
   values; any other shape (a join, a subquery, other rows of the table) is
   read inside the block as before. The key-race guard, the handler's own
   guards, a display code's uniqueness read and the lead action (with
   `expected_effects`) stay.

5. Delta conflicts (`DELTA_CONCURRENT_*`, the key-race guard) re-run steps
   2–4 with backoff of 250 ms × 2ⁿ (capped at 2 s) plus up to 50 % jitter, for
   at most 10 attempts; then 503 `busy` with "This changed since you opened
   it. Reload to see the latest."
6. Domain errors (a guard, or a `DomainError` thrown while planning) and
   version conflicts are never retried. A version conflict is 409
   `version-conflict` with the same message.
7. **Abandoned statements.** The client submits with a configurable
   `wait_timeout`, polls, and gives up at a 45 s deadline: it cancels the
   statement, looks once more (it may have finished), and otherwise throws
   `StatementAbandonedError`. A command treats that as a conflict and
   retries, so the idempotency lookup replays it if it committed after all,
   or writes it once if it didn't. A legacy write has no key and returns
   503 `outcome-unknown` instead of retrying.

## Server read snapshot (#192)

Each app instance keeps a rebuildable, full in-memory snapshot of the app
tables and views it reads: catalog/reference rows, initiatives, datasets,
teams, onboarding requests and intake children, change-list entries, legacy
access requests, EIR record/draft/submission metadata (not PDFs), admin reads
and audit rows. Adding a new area means adding its tables to `SNAPSHOT_TABLES`
and a `snapshot` implementation beside the area's existing SQL read.

Startup begins loading the snapshot in bulk and logs row counts, elapsed time
and approximate JSON size. Until that load succeeds, reads use the existing
Delta SQL path, so startup slowness does not make reads fail. Once warm, reads
call the area snapshot implementation and run the same authorization and
per-principal scoping in server code on every request; staff reads are refused
before the snapshot is consulted.

Freshness is read-derived, so the cache adds no write conflict surface. Each
instance starts one marker statement in the background when its last check is
older than the snapshot poll interval; the request itself uses stale-while-
revalidate and does not wait for that marker statement unless the snapshot is
past the hard max-age window, in which case it falls back to Delta. Background
polling runs only while the instance has served a recent request. The marker is
built from data writes already produced: append-only ADR-0007 action tables use
`(count(*), max(occurred_at), max(action_id))`; legacy requests, which predate
action rows, use digests over their mutable request tables. Catalog/reference,
access, tenant financials and pipeline rows are provisioned/static in this
slice; their snapshot markers use table digests, and there is no app write path
that changes them at runtime. A changed marker reloads only that area. If
marker checks fail past the hard max-age window, the read falls back to Delta
rather than serving a snapshot that may be stale indefinitely.

The cross-instance staleness bound is the configured poll interval plus two
marker round trips and one area reload: a change can land just after an
instance's marker check, the next request/tick starts a background marker
check after the poll interval, and a coalesced in-flight marker check may have
to finish before the changed marker can trigger the reload. Defaults are a 5 s
poll interval, a 15 minute active window, and a 30 s hard max age. Tune them
with `EDP_SNAPSHOT_POLL_INTERVAL_MS`, `EDP_SNAPSHOT_ACTIVE_WINDOW_MS`, and
`EDP_SNAPSHOT_MAX_STALE_MS`.

Databricks Apps may run multiple instances behind one URL, with no session
affinity. Delta remains the source of truth for writes: commands are ADR-0007
transactions, idempotency keys live in Delta action tables, and a retry that
lands on another instance replays the stored result from the action row. The
read snapshot is deliberately per-instance and rebuildable. A successful
command response includes per-area `watermarks` built from action rows the
transaction has already committed, so the save path does not run the all-area
marker query. The token is an opaque, expiring hash of the affected area's
action row. The server caps each token's usable lifetime at 60 seconds from
the token issue time, even if a client forges a farther-future expiry. This is
longer than the default cross-instance staleness bound (poll interval plus two
marker statements plus one area reload, about 15-25 seconds with the measured
4-5 second marker statement), but still bounded. A snapshot can serve a later
read only when that action row is already present in the snapshot; otherwise
the read uses Delta and triggers a throttled background refresh. Reads that
compose data from another area declare that dependency, so the same dirty-area
and watermark checks cover every area the snapshot result uses.

The browser keeps these watermarks in memory and `sessionStorage`, scoped by
the principal that received the write response, and sends the live tokens for
that principal on later reads as `X-EDP-Seen`. Expired tokens are dropped. The
header is only a freshness hint; authorization and per-principal scoping are
still applied server-side on that request, and a forged token can at most force
a normal Delta read plus a throttled background refresh.

Legacy writes for #72 access requests do not have ADR-0007 action rows, so they
return no watermark. Their cross-instance freshness relies on normal marker
polling and bounded Delta fallback rather than read-your-own-write tokens; with
the default cadence and measured marker cost, the expected worst case is about
20 seconds and the hard max-age fallback remains 30 seconds.

The marker statement load scales with active instances: each active instance
runs at most one marker query per poll interval, and idle instances stop
polling after the active window until their next request. With the measured
~5 s marker statement and the default 5 s cadence, two continuously active
instances can create two marker statements per cadence (~10 s aggregate
warehouse statement time per poll), and five instances can create five (~25 s
aggregate per poll). Poll timers include jitter so instances do not all ask
the warehouse at the same instant.

Identity is also per instance. `resolveSessionIdentity` reads the Databricks
forwarded identity on each request and uses the server identity cache described
in `architecture-data-seam.md`: `EDP_IDENTITY_CACHE_TTL_MS` defaults to 60 s,
is capped at 5 minutes, and can be set to `0` to disable reuse when revocation
latency matters more than SCIM call volume.

Server deployments can tune Statement Execution waiting without changing the
45 s client deadline:

| Variable                               | Meaning                                                           | Bounds                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS` | First POST wait for command/action SQL.                           | Positive whole seconds; API-supported range is 5-50 s, values 1-4 fall back to the 10 s default with a startup warning, and higher values are capped at the 45 s client deadline. |
| `EDP_SQL_READ_WAIT_TIMEOUT_SECONDS`    | First POST wait for read SQL.                                     | Positive whole seconds; API-supported range is 5-50 s, values 1-4 fall back to the 10 s default with a startup warning, and higher values are capped at the 45 s client deadline. |
| `EDP_SQL_COMMAND_POLL_INTERVAL_MS`     | Poll delay for command/action SQL after the first wait times out. | Positive whole milliseconds, bounded to 100-5000 ms.                                                                                                                              |
| `EDP_SQL_READ_POLL_INTERVAL_MS`        | Poll delay for read SQL after the first wait times out.           | Positive whole milliseconds, bounded to 100-5000 ms.                                                                                                                              |

The defaults remain `10s` wait and `500ms` polling for both paths unless these
server-only `EDP_SQL_*` variables are set. A requested command wait of `50s`,
for example, is sent as `45s` while the explicit statement deadline remains
45 s.

**Why the block counts its own rows:** the Statement Execution API reports
`num_affected_rows` for a standalone DML statement, but not for statements
inside a `BEGIN ATOMIC` block (checked on example-workspace). So
`updateCurrentState` follows its `UPDATE … WHERE id = ? AND version = ?` with a
count of rows now carrying this action's ID, and signals a version conflict
(`ED001`) when it's zero. The final SELECT's `num_affected_rows` must equal
the planned row count, or the runner refuses.

Guard SQLSTATEs: `ED001` version conflict, `ED002` key race (retried),
`ED003` incomplete write, `ED010` domain guard (`edp:guard:<n>` maps back to
the handler's `DomainError`).

## Accepted exception: #72's legacy request writes

`requests.access_requests`, `request_items`, `request_steps` and
`waiver_attestations` (`resources/store-schema.sql`) predate ADR-0007. They
have no versions, no action table to keep an idempotency key in, and aren't
catalog-managed, so a transaction can't write them: `BEGIN ATOMIC` on them is
refused with `TRANSACTION_NOT_SUPPORTED.WRITE_NON_CATALOG_MANAGED_TABLE`
(checked live on example-workspace; check 10 of the live script repeats it).
Making them catalog-managed would put tables #96 is about to drop on the
transactional path, so instead they're **legacy writes**, with their own
endpoint and an honest, weaker contract:

- `POST /api/legacy-writes/requests/<write>` with `{ payload }` only. An
  `idempotencyKey` or `expectedVersion` is refused (400), because nothing here
  could honour them, and the writes aren't reachable under `/api/commands`.
- Each statement commits on its own. A statement Delta refuses with a
  conflict didn't commit, so it's retried; one abandoned at the 45 s deadline
  is 503 `outcome-unknown` ("Reload to check before trying again").
- The statements are ordered and written so that re-running a write that
  failed part-way converges: items and steps are one `MERGE` each, keyed on
  the request and position (also deleting that request's rows the payload
  doesn't have); the request row is inserted last, only if missing; an
  attestation supersedes the person's earlier answer, then inserts itself
  only if its ID is new. A re-sent create or attestation is 409
  `already-exists`.
- No version check: the last transition wins. Two people creating the same
  request ID at the same moment can interleave their items; the cart picks IDs
  from a small range (`cart.jsx`), so a sequential collision is a 409.
- The requester and attestor come from the session, as everywhere else.

`registry.legacyWrite` exists only for these. A new area never uses it: its
tables are catalog-managed and its writes are commands. #96 removes it.

## Files: EIR PDFs

A signed EIR PDF can't travel in the JSON command envelope, so it's uploaded
first (`POST /api/eir/uploads`, multipart, to the caller's own folder of the
EIR volume) and the `eir/submit` command names the uploaded path. The command
reads the file back and hashes it on the server; the browser never supplies a
hash or size, and a path outside the caller's folder is refused. See
`docs/eir-volume.md`.

A lead action can carry its table's own columns (`leadAction.columns`, e.g.
`eir_submission_id`); the runner adds them to the lead row it writes.

## Display codes, and the one counter left

A record people quote (an EIR, an onboarding request, later an access
request) gets a **display code** (`ONB-7K3QFD`) from `allocateDisplayCode`
in `write-helpers.ts` (ADR-0007 decision 2, amended 2026-10-10). The code is
random, so concurrent creates don't share a row. The block reads its
table's `display_code` column for the code; if another row has it, the
block signals `ED004` and the runner retries the command with a fresh code,
and that read also makes a concurrent insert of the same code conflict at
commit. Tests script the codes with the runner's `newDisplayCode` option.

Only change-list entries (`CL`) still take a number from
`admin.display_counters` (`allocateDisplayNumber`), because the numbers show
listing order. Every creation with a number updates its prefix's row, so two
at once conflict and one retries. Before display codes, 10 creations racing
on one prefix all committed but took 55 to 88 s (103.9 s and 186.9 s in the
first #76 runs), with the unluckiest writer retrying up to 8 times.

Guidance for area tickets:

- **Give a record people quote a display code**, when the record is created,
  never on updates. Add `display_code STRING` to its table (with the guarded
  migration if the table already shipped). Don't add a counter prefix.
- **Show an explicit saving state** on every command, and say it may take a
  while; the screen must not look stuck.
- **Block double submit:** disable the action while it's in flight, and
  resend the same idempotency key if the person retries.

## How an area ticket adds itself

The worked example is the `admin` area: `src/server/delta/areas/admin.ts` and
`resources/store-admin.sql` (write checks: a create command, a
version-checked update, and reads). For a create with a display code, see
`src/server/delta/areas/onboarding.ts` (`submit`).

### 1. DDL: one file per area

Add `resources/store-<area>.sql`. Don't edit another area's file.

- Start with `USE CATALOG IDENTIFIER(:catalog_name);` and name every schema
  and table through the prefix: `IDENTIFIER(:catalog_name || '.' || :schema_prefix || '<schema>.<table>')`
  (fully qualified: on the 4.2.0 warehouse, `ALTER TABLE … ADD CONSTRAINT`
  doesn't resolve a two-part name against `USE CATALOG`).
  Production's prefix is `''`; a preview's is its own, so it gets its own
  schemas in a shared catalog.
- `CREATE … IF NOT EXISTS`, and every table
  `TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported')`. Action and
  other add-only history tables also get `'delta.enableChangeDataFeed' = 'true'`
  (ADR-0007 decision 13).
- Use the column patterns in `data-model.md` exactly. Action tables include
  `actor_app` (ADR-0008) and, for lead actions, `result`.
- Enums are `CHECK` constraints. Delta rejects them in `CREATE TABLE` and has
  no `ADD CONSTRAINT IF NOT EXISTS`, so `DROP CONSTRAINT IF EXISTS` then
  `ADD CONSTRAINT`.
- Start the file with the two `assert_true` statements from
  `store-admin.sql`, which refuse a `catalog_name` or `schema_prefix` that
  isn't a plain identifier, before anything else runs. In dynamic SQL, wrap
  every spliced name in `replace(…, '`', '``')`.
`src/server/delta/**tests**/ddl-files.test.ts`checks both for every`resources/store-*.sql`.
- Add your branch of `audit.actions` as a view named
  `audit.<area>_branch` with the fixed columns listed in `store-admin.sql`,
  using `EXECUTE IMMEDIATE` (view bodies can't take parameters).
  `store-audit.sql` rebuilds `audit.actions` from every `*_branch` view, so
  you never edit it.
- **Adding a column to a table that's already provisioned needs a migration.**
  `CREATE TABLE IF NOT EXISTS` never changes an existing table, and Databricks
  SQL has no `ADD COLUMN IF NOT EXISTS` (a parse error on 4.2.0). After the
  `CREATE`, build the `ALTER TABLE … ADD COLUMN` into a session variable only
  when `information_schema.columns` says the column is missing, then
  `EXECUTE IMMEDIATE` it (see `edp_migrate_write_check_actions_result` in
  `store-admin.sql`). Add the column to the `CREATE` too, so a new store gets it
  directly. A new table's columns go into
  `src/server/delta/__tests__/ddl-first-shapes.json` when it ships, and
  `ddl-files.test.ts` fails on any later column without a migration.
  **The EIR tables (`store-eir.sql`) first shipped in #126**, so their first
  shape is the one recorded in `ddl-first-shapes.json` by that PR (including
  `eirs.display_number` and `form_version`/`form_started_at` on submissions
  and drafts). Earlier EIR shapes only ever existed on PR #134's own
  previews, which were dropped and re-provisioned, not upgraded. From #126 on,
  an EIR column follows the same rule (`eir-ddl.test.ts` pins the first shape).
- Spark SQL doesn't escape `''` inside a string (it concatenates literals).
  Use `\'`.

Then add a task for your file to the `provision_store` job in `databricks.yml`
(same `catalog_name`/`schema_prefix` parameters), and add it to
`create_audit_view`'s `depends_on`.

### 2. Commands and reads

Create `src/server/delta/areas/<area>.ts` exporting `register<Area>Area(registry)`,
and add one line to `areas/index.ts`.

```ts
registry.command({
  area: "teams",
  name: "add-member",
  app: "tenant",                       // or "staff": which app surface mounts it
  payload: z.object({ … }).strict(),   // never an actor field
  leadActionTable: { schema: "teams", table: "dataset_member_actions", recordIdColumn: "dataset_member_id" },
  authorize: (user) => { … },          // throw DomainError(…, 403); required for app: "staff"
  async plan(ctx) {
    // Pre-reads are fine for early, friendly errors; the rule itself must
    // also be a guard inside the block.
    ctx.block.guard(`EXISTS (…)`, new DomainError("already-member", "…", 409));
    const id = await followOn(ctx, 0);                     // UUID v5 of the lead action ID
    const number = allocateDisplayNumber(ctx, "CL");       // if the record has one
    insertCurrentState(ctx, MEMBERS, id, { … }, { displayNumber: number });
    insertAction(ctx, ENTRY_ACTIONS, { actionId: await followOn(ctx, 1), … }); // follow-ons
    return { recordId: id, recordVersion: 1, leadAction: { action: "added", change: { role: [null, "tester"] } } };
  },
  // The row the response is built from, read inside the block and stored on
  // the lead action: a replay returns exactly this, never later state.
  resultRow: ({ recordId, names, block }) =>
    `SELECT ${MEMBER_COLUMNS} FROM ${names.table("teams", "dataset_members")} WHERE id = ${block.bind(recordId)}`,
  result: (row) => toMember(row),                          // pure: no reads
});

registry.read({ area: "teams", name: "members", app: "tenant", query: z.object({ datasetId: z.string().uuid() }).strict(), run: … });
```

- **Every `app: "staff"` command or read must declare `authorize`**
  (usually `requireEdpStaff`), or `createRegistry` throws at startup. While
  one app serves both surfaces, the surface keeps nobody out.
  `api.test.ts` checks that someone outside staff gets 403 on every staff endpoint.
- **A read is staff-only unless it's the shared catalogue or scoped to the
  caller by the session.** Hiding a screen isn't authorization. `api.test.ts`
  pins the list of reads open to any signed-in user, so adding one is a
  review decision.
- If every screen loads one of your staff reads, decide what non-staff should
  see. The adapter's `staffOnly` always sends the pipeline and tenant
  financials reads and lets the server decide from the caller's session
  (#168). The server answers 403 before any SQL for someone outside staff,
  and 404 when the app doesn't serve the staff surface. `staffOnly` turns
  either into an empty list, because the legacy host fails the whole app on
  any query error. There's no `/api/session` precheck.
- Updates go through `updateCurrentState(ctx, table, id, ctx.expectedVersion, set)`;
  it returns the new version and adds the zero-rows check.
- Child rows bump the parent's version in the same command (ADR-0007 decision 5).
- Bind every value (`ctx.block.bind`, or a column map); names go through
  `ctx.names.table(schema, table)`.

### 3. The browser

Replace the area's in-memory stub in `src/data/adapters/delta.ts` with calls to
`api.read(…)` and `api.command(…)`. The client creates one idempotency key per
intent and resends it on a retry, and sends the version it read. Flip the
area's `*-persistence` capability from `stub` when it's real.

### 4. Tests

Unit-test handlers through the runner with `fakeSqlClient` in
`src/server/delta/__tests__/fake-sql-client.ts` (see `transaction.test.ts`).
For races, add a check to `scripts/delta-live-check.ts`.

When an area replaces a memory store, run its existing contract tests on both
backends: `src/server/delta/__tests__/sqlite-warehouse.ts` is a stateful fake
warehouse built from the real `resources/store-*.sql` (SQLite through
`node:sqlite`), and `src/data/__tests__/team-backends.ts` puts the Delta
adapter, the API router and the runner on top of it. It plays atomic blocks,
guards and, with `hold()`, two writers racing from the same snapshot. It isn't
the warehouse: the live check is still the proof.

## The teams area (#123)

`src/server/delta/areas/teams.ts` (`resources/store-teams.sql`) backs the
dataset-team and change-list screens. What it adds to the patterns above:

- **Plan from a snapshot, re-check it in the block.** A command reads one
  dataset's owners, members, entries and the bindings involved, decides with
  the same pure rules as the memory store (`ownership.ts`, the reconcilers),
  and guards in the block that none of it moved (counts and summed versions).
  If it moved, the guard raises the retryable `ED002`, so the runner re-reads
  and re-plans, as after a Delta conflict. Rows the server picked (not the
  client) are updated the same way (`updateReadRow`); a version the client
  sent still gets `version-conflict`.
- **ADR-0006 binding and refusals are their own commands.** A refused block
  rolls back, so it can't keep its own `access-refused` row. Every protected
  command checks ownership itself and records a mismatch's `access-refused`
  row in its own commit, so the adapter sends team writes without reading
  `teams/ownership` first (#140: that read cost a round trip per write). An
  owner's first action gets `claim-required`; the adapter then runs
  `teams/bind-email` and resends the command once with the same key.
- **Order is `_metadata.row_id`.** Row tracking is on (set explicitly); IDs
  grow with each commit, but not with statement order inside one block
  (checked on example-workspace), so rows that must keep their order within a
  command go in one multi-row `INSERT` (`insertStateRows`).
- **Configured datasets load once**, as `system`, before the first request to
  these areas (`teams-seed.ts`, called from `config.ts`); the idempotency key
  derives from the initiative's ID, so two servers write it once. What loads
  is deploy-time configuration (see [The pilot configuration](#the-pilot-configuration)),
  and the initiative's `created` action records where it came from
  (`payload.source`: `pilot-config` or `preview-sample`).
- **The change list's stage is derived** from the add-only approval and
  application tables (ADR-0008); `change-list/mark-applied` is staff-only and
  records `method = by-hand`.

## The pilot configuration

The store keeps its history indefinitely (ADR-0007 decision 12), so it never
gets sample data in production. The pilot's initiative, tenant, datasets and
owners are deploy-time configuration (decided 2026-10-08 on #141/#146): the
bundle var `pilot_config_json`, which becomes the server env
`EDP_PILOT_CONFIG_JSON` (`src/server/pilot-config.ts`).

| `pilot_config_json` | Production (`store_schema_prefix` empty)  | Preview (`store_schema_prefix` set)                                                             |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| set and valid       | loads exactly it                          | loads exactly it                                                                                |
| set and invalid     | every API request gets 503, nothing loads | the same                                                                                        |
| `none` (default)    | loads **nothing**                         | loads the sample (`src/data/datasets/seed.ts`), first dataset owned by `seed_dataset_owner_ids` |

```json
{
  "initiative": { "id": "INI-0001", "name": "Refund Integrity Analytics", "tenant": "RAAS" },
  "datasets": [
    {
      "name": "Refund anomaly scores",
      "domainTag": "individual-filing",
      "datasetTag": "refund_anomaly_scores",
      "owners": [
        {
          "principalId": "1234567890123456",
          "displayName": "Dana Whitfield",
          "email": "dana.whitfield@example.gov"
        }
      ]
    }
  ]
}
```

- **Strict.** An unknown field, a missing one, or a value in the wrong shape
  refuses the whole configuration. The API answers every request with 503
  `backend-not-configured`, naming each problem (also logged), and nothing is
  loaded. It never loads part of a configuration.
- `initiative.id`: letters, digits, `-` and `_`. The pilot initiative is `active`.
- `datasets`: at least one. `domainTag` is lowercase letters, digits and `-`.
  `datasetTag` is lowercase letters, digits and `_`, and is unique: it's in
  the dataset's group names. `id` is optional and defaults to `ds-` plus the
  dataset tag with `_` as `-` (`ds-refund-anomaly-scores` above).
- `owners`: at least one per dataset. `principalId` is the owner's Databricks
  account (SCIM) ID, and `displayName` is required; `email` is optional. Every
  owner also gets the Maintainer (stored as `manager`) role (ADR-0005).
- **Loaded once.** After the first load, owners and members are managed in
  the app. Changing the configuration later doesn't change what's in Delta;
  an initiative with a new `id` is loaded as a new one.

The default is `none`, not empty: Databricks Apps refuses an env entry with
an empty value. Pass the configuration as one string at deploy, for example
`--var pilot_config_json="$(jq -c . pilot.json)"`. It holds account IDs and
names, not secrets.

## The dataset access matrix

The approved MVP role policy from [#145](https://github.com/jtafoya-db/edpvm/issues/145#issuecomment-6385978601)
is checked in at `src/data/datasets/access-matrix.json`. It is executable
server configuration, unlike the presentation copy in
`role-descriptions.json`. The default records its approval decision and date;
it does not need a draft opt-in.

Deployers may replace the matrix as a whole with
`--var access_matrix_json="$(jq -c . access-matrix.json)"`. There is no merge
with the default. An override must independently contain all three stored
roles, consumer and sensitive-workspace rules, approval provenance, and every
selector. `none` loads the repo default. A deliberately draft override also
requires `--var access_matrix_allow_draft=true`; `NODE_ENV` never permits it.

Before deploying an approved override, compute the exact normalized digest the
staff status read should report. The helper validates with the same loader and
reads either a file or standard input:

```bash
node scripts/access-matrix-digest.ts access-matrix.json
# or
jq -c . access-matrix.json | node scripts/access-matrix-digest.ts
```

The loader rejects malformed policy, unknown or mismatched targets, unsafe UC
privileges, owner ACLs, tester/consumer writes, consumer bronze access, and job
`CAN_MANAGE` anywhere except the labelled Maintainer (stored as `manager`) rule. A bad
matrix does not stop the app: only a request that loads it fails. EDP staff can
call `GET /api/reads/configuration/access-matrix-status` to see its source,
approval status and normalized SHA-256 digest. The response never includes
matrix values. Errors expose only a generic code; paths and rejected values go
to the server log.

## Configuration

| Where      | Variable                                                                  | Meaning                                                                                      |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| bundle     | `data_backend`                                                            | `memory` (default) or `delta`; becomes `VITE_DATA_BACKEND` at build                          |
| bundle     | `store_catalog`, `store_schema_prefix`                                    | Where the store lives; the prefix is `''` in production                                      |
| bundle     | `sql_warehouse_id`                                                        | The provisioning job's warehouse, and the app's `sql-warehouse` resource (`CAN_USE`)         |
| server env | `EDP_STORE_CATALOG`, `EDP_STORE_SCHEMA_PREFIX`, `DATABRICKS_WAREHOUSE_ID` | Set from the above                                                                           |
| server env | `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`     | Injected by Databricks Apps                                                                  |
| server env | `EDP_APP_SURFACES`                                                        | `tenant,staff` (default). After an ADR-0008 split each app sets its own                      |
| server env | `EDP_PILOT_CONFIG_JSON`                                                   | The pilot datasets and owners ([above](#the-pilot-configuration))                            |
| server env | `EDP_ACCESS_MATRIX_JSON`, `EDP_ACCESS_MATRIX_ALLOW_DRAFT`                 | Whole access-matrix override and explicit draft opt-in ([above](#the-dataset-access-matrix)) |
| server env | `DATABRICKS_TOKEN`                                                        | Local development only; ignored when `NODE_ENV=production`                                   |

The app's service principal needs `USE CATALOG` on the store catalog and
`USE SCHEMA`, `SELECT` and `MODIFY` on the store schemas. The provisioning job
doesn't grant them, because the principal differs per environment.

## Live check

`scripts/delta-live-check.ts` runs the real runner against a real warehouse in
throwaway schemas, repeats the ADR-0007 races, and drops what it made:

```bash
node scripts/delta-live-check.ts --profile example-workspace --warehouse 1111111111111111 --catalog example_catalog
# GovCloud (example-gov-demo), run by a human:
node scripts/delta-live-check.ts --profile example-gov-workspace --warehouse <warehouse id> --catalog <catalog you can create schemas in>
```

It exits non-zero if any check fails or a schema is left behind.
