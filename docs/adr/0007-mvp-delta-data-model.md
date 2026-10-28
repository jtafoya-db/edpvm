# ADR-0007 — The MVP Delta data model

- **Status:** Accepted (human decisions recorded 2026-10-04). Decision 2 amended 2026-10-10 (display codes, #177). Refines ADR-0004 (column names, history tables) and ADR-0005 decisions 6 and 8 (how the change list and every action are stored).
- **Related:** [`docs/data-model.md`](../data-model.md) (the table catalogue this ADR decides), ADR-0004 (identity), ADR-0005 (domain access model), ADR-0006 (email-matched dataset owners), [`GLOSSARY.md`](../../GLOSSARY.md), `resources/store-schema.sql`, `src/data/adapters/delta.ts`

## Context

The MVP has to save onboarding requests, dataset teams, access requests, the change list and EIRs durably in Delta, so that several people can work on the same records. Today these records live in a browser tab or an in-memory store:

- **Main** has #72's Delta store: 18 tables in the `catalog`, `requests`, `access` and `admin` schemas (`resources/store-schema.sql:8-27`). The adapter writes only the old cart-style access request and its waiver attestations (`src/data/adapters/delta.ts:281-355`). Datasets, dataset roles and the change list silently fall back to memory and are lost on reload (`delta.ts:376-386`).
- **The new model's records** exist only as TypeScript types and in-memory stores: dataset owners, members, access levels and team events (#110; per-member access levels were removed by #119, PR #120), onboarding requests (#99), dataset access requests (#108) and EIRs (#98). The group snapshot job (#109) is the only new area with Delta tables.

The current shape of those records makes them hard to store as they are:

- **IDs are counters local to one tab or process** (`ONB-1000…`, `AR-0001…`, `CL-0001…`), so two people get the same number.
- **No record has a version**, so two people editing the same record overwrite each other without knowing.
- **The same fact has six names.** The actor is `actorId`, `actorScimId`, `by`, `addedBy`, `setBy` or `createdBy`. The time is `at`, `submittedAt`, `requestedAt`, `addedAt`, `setAt` or `createdAt`.
- **History is kept in different ways, or not at all.** Onboarding keeps a `decisions[]` array on the request. EIRs keep `actions[]`. Team changes are `TeamEvent`s with no ID. An access request keeps only its final outcome.
- **Records are nested** (intake datasets and owners inside the request, owners inside the dataset, reasons inside change-list entries, submissions and renewals inside the EIR), and the nested parts have no IDs of their own. Records point at each other with ID arrays (`changeListEntryIds[]`, `entryIds[]`).
- **People are keyed several ways**: the Databricks account ID for onboarding and EIRs, the account ID plus email for access requests, email for members, and ADR-0006's email binding for owners.
- **There's no transaction.** Through the current `SqlClient`, separate statements are not atomic (`delta.ts:13-24`), yet one action can change a request, a member and several change-list entries.
- **Delta doesn't enforce uniqueness.** Primary key, foreign key and unique constraints are informational only. Only `NOT NULL` and `CHECK` are enforced ([constraints](https://docs.databricks.com/aws/en/tables/constraints)).

The human's requirements for the design are:

- one consistent pattern in every area, with no spaghetti tables
- a person reading any table can tell what it holds and what it's for
- every record's history can be followed in order: who, what, when and why
- room now for both fine-grained audit and broad monitoring by EDP staff
- the reason for every decision, written down

The full inventory, with file and line references, is in the orchestrator's research notes. Its findings are summarised above.

## Decisions

Each decision says what it solves, what was rejected, and what it costs.

### 1. Current-state tables plus append-only action tables

Each kind of record the app tracks has a **current-state table**, one row per record holding what's true now, and an **action table** (suffix `_actions`), one row per thing anyone did to it. Action rows are never updated or deleted. A record's parts (an intake dataset, an EIR submission) live in their own child tables, and their history goes on the parent record's action table.

Current-state tables are **real tables, not views over the actions**. Screens read them directly, and every write updates them in the same step that records the action (decision 6).

There are four kinds of exception, each named in the catalogue:

- child tables have no action table of their own
- the add-only email binding table needs no current-state history, because its rows never change
- the EIR draft has no actions, because a draft save decides nothing (decision 9)
- #109's group snapshot tables record what Databricks shows, not what anyone did in the app, so they keep the snapshot job's own shape

**Why:**

- Screens and inboxes need what's true now. A plain row per record answers that with an ordinary query.
- Audit needs what happened, in order. An append-only table answers that without guesswork.
- Keeping the two apart means neither has to be rebuilt from the other.
- Current-state tables are kept as tables because a view rebuilt from actions would have to replay every record's history on each read. It would also need logic for each kind of action, which has to be right forever.
- Child tables, one row per part, let two people edit different parts without rewriting the whole record. They also let the write check rules such as "one owner record per person" against rows, which it can't do inside a JSON blob.

**Rejected: one event log with projected tables** (one envelope table, with current-state tables rebuilt from it). It gives the strongest replay story, but:

- every screen reads a projection that can lag
- a rebuild job becomes part of the product
- the tables people can read are the projections, not the source

That's more machinery than the MVP's volume justifies.

**Rejected: one JSON document per record** (one row per onboarding request, dataset team or EIR, with the nested state as JSON). It fits today's TypeScript types most closely, but:

- two people editing one team rewrite the same document
- SQL can't enforce uniqueness inside it
- a person reading the table sees a blob, not what it holds

**Cost:**

- More tables, about two per area.
- Each write touches several rows, which is why decisions 5 and 6 exist.
- Current state is stored twice on purpose: the state row says what's true now, and the action rows say how it got there. A monitoring view checks that the two agree (`monitoring.invariant_violations`).

### 2. Server-generated UUIDs, plus a display number for people

Every row in a current-state, child or action table has a UUID the server generates. Records people talk about also get a `display_number`, shown as `ONB-1042`, `AR-1042` or `CL-1042`: onboarding requests, access requests and change-list entries. The display number is never used as a key, in a URL that changes data, or in a join.

Display numbers come from one counter row per prefix in `admin.display_counters`, which the creating write moves up by one. They do **not** come from a Delta identity column.

**Why:**

- UUIDs are unique without coordination, so the server can create an ID before anything is written. Decisions 6 and 8 rely on that.
- People can't read or say a UUID, so they get a short number.
- Keeping the number out of keys means a gap, a duplicate or a renumbering can never point a write at the wrong record.
- Identity columns are ruled out because Databricks says "concurrent transactions are not supported on tables with identity columns enabled" ([identity columns](https://docs.databricks.com/aws/en/delta/generated-columns)). That would make every table with a display number single-writer. The GovCloud test (decision 6) confirmed it: of ten simultaneous inserts into an identity table, one committed and nine failed with `DELTA_METADATA_CHANGED`. A single atomic transaction on such a table does work, so the problem is concurrency, not transactions as such.
- A counter row is updated, not inserted. Delta makes two concurrent updates of the same row conflict ([conflict matrix](https://docs.databricks.com/aws/en/optimizations/isolation/row-level-concurrency)), so two writes can't take the same number.

**Rejected: counters as keys** (today's `ONB-1000…`). They collide across tabs and processes.

**Rejected: an identity column.** It blocks concurrent writes to the whole table.

**Rejected: ULIDs or time-ordered IDs.** They sort by time, but `occurred_at` and `record_version` already order history, so the extra dependency buys nothing.

**Cost:**

- Every record creation in an area competes for that area's counter row. When two creations run at once, one conflicts and retries. At MVP volume, a handful of creations a minute, the retry is invisible. The retry must back off (see [Retries](#retries)): in the GovCloud test, five writers hammering one counter with six quick retries left five of thirty writes failed, and all five succeeded with exponential backoff.
- A failed or abandoned creation can leave a gap in the numbers. Nobody relies on numbers being contiguous.

#### Amendment (2026-10-10): counter-free display codes for EIRs, onboarding and access requests

Human decision 2026-10-10, built in #177. It replaces the counter for every prefix but `CL`:

| Prefix                     | Display label                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `EIR` (the **Record ID**)  | A display code, e.g. `EIR-7K3QFD`, also printed on the signed PDF                               |
| `ONB` (onboarding request) | A display code, e.g. `ONB-7K3QFD`                                                               |
| `AR` (access request)      | A display code, once access requests are on Delta (#124). The in-memory store already draws one |
| `CL` (change-list entry)   | Stays sequential on `admin.display_counters`: the number shows listing order                    |
| `WC` (write check)         | No display number: it's an internal test action nobody quotes                                   |

A **display code** is the prefix and 6 characters of Crockford's base32 alphabet (`0`–`9` and `A`–`Z` without `I`, `L`, `O` and `U`), drawn by the server from a CSPRNG (`src/data/display-codes.ts`). An all-digit draw is skipped, so `EIR-104211` can only be an old counter number. Codes are unique, not sequential. 32⁶ is about 1.07 billion codes per prefix, so at the expected 200,000 records a new code clashes about 0.02% of the time, roughly one retry per 5,000 creates.

- **Uniqueness, inside the write's one transaction.** The create block reads its table's `display_code` column for the code it drew. If another row has it, the block signals and rolls back, and the runner retries the whole command with a fresh code (bounded by the usual retry limit; see [Retries](#retries)). That read also works like the idempotency key-race guard: when two writers insert the same code at once, the predicate read makes one of them fail at commit with a Delta conflict, and the retry draws again. A replayed idempotency key returns the stored response, so it shows the original code.
- **Storage.** Each table gets a `display_code STRING` column, added by an information_schema-guarded upgrade step (`ddl-files.test.ts` checks it), and `display_number` becomes nullable. A new record has a code and no number. Records numbered by the counter keep their number (`EIR-1042`, `ONB-1000`): they still display and resolve by it, and nothing is migrated.
- **Monitoring.** `monitoring.invariant_violations` reports any display code or display number held by two rows of one table.
- **The counter table stays.** Only `CL` takes numbers from it now. Dropping the unused `EIR`, `ONB` and `WC` rows is later cleanup.

**Why:** a display number exists only so a person can quote it to EDP staff ("where's ONB-7K3QFD at?"). That needs it to be short, unique and unambiguous, not sequential. The shared counter row was the biggest single cost in a create, about 2.8 to 4 s, and because every create in an area updated the same row, simultaneous creates queued behind each other: ten at once took 55 to 88 s. A code drawn on the server needs no shared row, so creates no longer conflict with each other.

**Rejected: block-reserved ranges** (each server instance reserves, say, 100 numbers at a time). It still writes the counter row, only less often, and adds state to every instance: a restart leaves gaps, and the numbers no longer show creation order anyway.

**Rejected: keeping every prefix sequential.** It keeps the 2.8 to 4 s per create and the queue under concurrency, for an ordering nobody needs.

**Trade-off:** codes don't show order or count. `submitted_at` and `occurred_at` already order records, and a clash costs one retry about once in 5,000 creates. `CL` keeps its counter because the change list's numbers do show the order entries were listed in, at one counter update per action.

### 3. The same actor and time columns on every action row

Every action row has the same three columns, named the same in every table:

- `actor_principal_id`: the Databricks account ID of the person who acted, as the server resolved it from their session (ADR-0004). It's never taken from the request body. When the app itself acts with no person behind it, as in an automatic forward, standup or loading configuration, the value is the literal `system`. `system` can never be a real account ID, because real IDs are numeric strings.
- `actor_display`: the person's name as the app showed it when they acted, or `EDP Vending Machine` for `system`.
- `occurred_at`: when they acted, in UTC.

**Why:**

- The audit view (decision 1) is then a plain union, and "everything this person did" is one filter.
- ADR-0005 decision 8 already requires every action to record the Databricks account ID of the signed-in person.
- `actor_display` is kept as it was at the time, because names change and the audit should show what people saw.
- A fixed `system` value makes automatic actions easy to find, and impossible to confuse with a person.

**Rejected: keeping each area's names** (`by`, `addedBy`, `actorScimId`…). Every query would need a mapping for each area, and new areas would invent new names.

**Rejected: a people table, joined for names.** ADR-0004 decision 3 deferred it, and a join would show today's name on a years-old action.

**Rejected: a null actor for automatic actions.** Null reads as "unknown", which is exactly what an audit must never show.

**Cost:**

- Every adapter maps its TypeScript field names to these columns.
- The display name is copied onto every row.

### 4. People known only by email: email plus a nullable account ID, and a separate binding table

Some people may be known only by email: a dataset member, an owner added in the app, or an owner contact named at intake. For them the table stores two columns:

- `<role>_email`, trimmed and lower-cased
- `<role>_principal_id`, the Databricks account ID, which is null until the email is matched

ADR-0006's binding of an email to an account ID gets its own add-only table, `teams.email_bindings`, keyed by email. Wherever an account ID is known, it's the key.

**Why:**

- The app can't search for people in Databricks, so owners and members are added by name and email (ADR-0006). The record has to exist before an account ID is known.
- ADR-0006 also says a binding belongs to the email across every dataset, not to an owner record, and is never reset. A table of its own makes that rule visible: one row per email, inserted once, never updated.
- Owner rows copy the bound account ID so screens don't need the join, but the binding table is the source of truth.

**Rejected: refusing anyone without an account ID.** It would block the owner and member flows that #84, #87 and #103 deliver.

**Rejected: storing the binding only on owner rows** (as in memory today). Removing the owner would lose it, and re-adding the same email on another dataset couldn't find it.

**Cost:**

- A person can be the same person in two ways: by email, or by account ID. The uniqueness check (decision 6) tests both.
- A changed or aliased email won't match before the email is bound. ADR-0006 already accepts this.

### 5. A version on every current-state row, checked on every change

Every current-state row has a `version` that starts at 1 and goes up by one on every change. A write says which version it read. If the row has moved on, the write is refused, and the screen says "This changed since you opened it. Reload to see the latest." Rows that belong to a parent record (intake datasets, EIR submissions) are guarded by the parent's version. Every change to a child row bumps the parent's version in the same transaction.

**Why:**

- Several people work on the same records: two owners on one team, two reviewers in one inbox. Without a check, the second save silently undoes the first.
- A version number is the simplest check that works without locks.
- A refusal followed by a reload is a message people understand.

**Rejected: last write wins.** It loses work without anyone knowing.

**Rejected: locking a record while someone edits it.** Delta has no row locks, and an abandoned tab would hold the lock.

**Cost:**

- Every write carries the version it read.
- The screens need the conflict message and a reload path.

### 6. Every write is one atomic transaction, with the action row carrying the full command

**The human selected option (c), Delta multi-statement transactions, after the GovCloud validation below.**

#### The problem

A write has to do three things at once:

- **Change several tables together**: the action row, the state row, follow-on rows and change-list entries. If only some of the statements land, the record and its history disagree.
- **Keep some things unique**:
  - one action per record version
  - one action per idempotency key
  - one open access request per person and dataset
  - one owner and one member row per person per dataset
  - one binding per email
  - one display number per record
- **Survive a retry**: a retried click must finish the write or do nothing, never do it twice.

The first draft of this ADR relied on `MERGE … WHEN NOT MATCHED THEN INSERT` into `Serializable` tables for uniqueness. **That is not sound.** In the Databricks conflict matrix, two inserts never conflict, at either isolation level. With row-level concurrency, two `MERGE`s conflict only when they modify the same existing row ([conflict matrix](https://docs.databricks.com/aws/en/optimizations/isolation/row-level-concurrency)). So two writers can both see "no row yet" and both insert. Informational keys don't stop them.

`UPDATE … WHERE id = ? AND version = ?` _is_ a sound compare-and-set, because two updates of the same row conflict in every mode. But that only helps if the server can tell that zero rows changed. Today `SqlClient.execute` returns nothing (`delta.ts:20-23`).

#### The options

**(a) Delta, with every write serialised through one writer.** All writes go through a single serial lane. That's either one app-server process with an in-process queue, or a durable executor job with `max_concurrent_runs: 1`, as PR #118 proposes. Because nothing runs concurrently, check-then-insert is safe.

- Row-level concurrency is turned off on the action and current-state tables (`delta.enableRowTracking = false` or deletion vectors off). That makes more read-and-modify writes that slip past the lane fail with file-level conflicts, but it does not stop two blind `INSERT`s from both landing: Delta never conflicts two concurrent inserts. Uniqueness here comes only from the single-writer rule.
- `SqlClient.execute` returns affected-row counts, which the Statement Execution API reports for DML.
- **Why:** it works on any Delta runtime available today.
- **Cost:** atomicity across statements is still missing, so partial writes need the action-first recovery from the first draft.
  - An in-process queue is only correct while the app runs exactly one instance, so every scale-out breaks it silently.
  - A job executor adds seconds of latency to every click.
  - Either way, uniqueness rests on a deployment rule rather than on the database.

**(b) Lakebase (managed Postgres) for current-state and action tables.** Real `UNIQUE` constraints, real multi-statement transactions and row locks. The Delta copies for audit and monitoring would come through Lakehouse Sync.

- **Why:** it's the textbook fit for a transactional app, and the uniqueness rules become plain constraints.
- **Cost:**
  - Lakebase Postgres is listed as **unavailable in AWS GovCloud** ([GovCloud features](https://docs.databricks.com/aws/en/security/privacy/gov-cloud)), so it can't be the platform for the target workspaces today.
  - It would also add a second store, a sync to operate, and audit tables that lag the source.
  - It stays the best answer if Lakebase reaches GovCloud.

**(c) Delta multi-statement transactions (recommended).** Each write is one `BEGIN ATOMIC … END` block on Unity Catalog managed tables with catalog commits enabled ([transactions](https://docs.databricks.com/aws/en/transactions); verified in the IRS GovCloud demo workspace on 2026-10-04, see [Verified on GovCloud](#verified-on-govcloud-2026-10-04)). Inside the block, the write:

1. reads what it depends on: the record's version, the idempotency key, and any uniqueness rule
2. refuses if a check fails
3. writes the action, the state, the follow-on rows, the change-list entries and the display counter

Databricks commits the block all at once or not at all. It uses optimistic concurrency, and it fails a transaction at commit on two kinds of conflict:

- **write-write**: two transactions changed the same row
- **phantom read**: "another transaction added new rows matching a predicate your transaction read", at both isolation levels

The phantom-read rule is what makes check-then-insert sound. If two writers both read "no open request for this person and dataset" and both insert one, the second to commit fails, retries, and then sees the first one's row.

- **Why:**
  - It removes partial writes entirely, so no write can be half-done.
  - Uniqueness comes from the database's own conflict detection rather than a deployment rule.
  - Everything stays in Delta and Unity Catalog, where the audit and monitoring views already are.
- **Cost:**
  - **It was proven on a Preview-channel warehouse.** The GovCloud test warehouse runs the Preview channel. The production warehouse must be on that channel too, or the test must be re-run on a Current-channel warehouse before go-live.
  - It needs catalog-managed tables (`delta.feature.catalogManaged`). In the test, `DROP FEATURE catalogManaged` worked, but the table stayed on reader/writer protocol 3/7 with its other upgraded features. So turning transactions off is possible; returning the table to its original protocol is not.
  - Each write takes about 2.3 seconds (median; p95 2.6 s on the test warehouse). Screens must show the write as in progress and stop double clicks; the idempotency key makes a repeat harmless anyway.
  - A conflicting transaction must be retried by the server. Row-level concurrency for `MERGE` isn't supported on AWS GovCloud, so conflicts there are detected per file, not per row. That means more retries, all in the safe direction.
  - No DDL can run inside a transaction, and a transaction can touch at most 100 tables.

**Rejected: trusting `MERGE`, informational keys and `Serializable` alone** (the first draft). It's unsound, as shown above.

**Rejected: a separate unique-claims table.** Inserting a claim row has the same race as inserting the row it guards.

#### What every write does, whichever option is chosen

**The lead action row stores the whole command.** It holds:

- `command`: JSON with the requested change, exactly as the server validated it
- `command_hash`: SHA-256 of that JSON
- `expected_effects`: JSON listing every follow-on row the write must produce, by table and ID

If a request arrives with a known idempotency key, the server never trusts the resent body:

- if the hash matches, the server returns the stored result, or finishes from the stored command under option (a)
- if the hash differs, the request is refused as a reused key

**Why:** without a durable command, recovering a half-finished write means trusting whatever the client sent the second time, and that could be a different change.

**Follow-on row IDs are derived from the lead action's ID** (UUID v5 of the action ID and the effect's position). A retry therefore names the same rows, and `monitoring.incomplete_writes` can check `expected_effects` against what exists.

**The server knows when nothing changed.** `SqlClient.execute` returns the affected-row count of each statement (the Statement Execution API reports `num_affected_rows` for DML). A version-checked update that changes zero rows is a conflict, never a silent success.

**Invariants are checked after the fact as well.** `monitoring.invariant_violations` lists any uniqueness rule broken in the data, such as two open requests for one person and dataset, or a dataset with no owner. Under option (c) it should stay empty. Under option (a) it's the alarm for a lane that's been bypassed.

#### Verification before any area builds on this

The first build ticket runs a concurrency test against a real warehouse in the GovCloud workspace. Two writers race to:

1. insert the same idempotency key
2. create two open requests for one person and dataset
3. take the same display number
4. update the same version

In every race, exactly one writer must succeed and the other must get a conflict.

#### Verified on GovCloud (2026-10-04)

The human chose option (c), on condition it was proven in the IRS GovCloud demo workspace (`example-gov-workspace` profile). A throwaway-schema test on the Serverless Starter Warehouse (PRO, Preview channel, `version()` 4.2.0) found:

| Test                                           | Result                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `BEGIN ATOMIC … END` on catalog-managed tables | Works                                                                                  |
| Check-then-insert, 20 keys, 2–5 writers each   | 20 rows, no duplicates. Losers failed with `DELTA_CONCURRENT_APPEND.ROW_LEVEL_CHANGES` |
| Counter row, 30 writers                        | 30 distinct display numbers, no gaps, once retries backed off                          |
| Version-checked `UPDATE`                       | Affected rows `1`, then `0` when stale                                                 |
| A failing second statement                     | Rolled back the whole block                                                            |
| Change Data Feed on an add-only table          | Works                                                                                  |
| Identity column, 10 concurrent inserts         | 1 committed, 9 failed, as decision 2 assumes                                           |

**One correction to the first draft:** plain `MERGE … WHEN NOT MATCHED INSERT` did **not** produce duplicates here. On AWS GovCloud, `MERGE` uses table-level conflict detection, so competing merges failed instead. That still isn't a uniqueness guarantee: it depends on every writer using `MERGE`, and blind inserts never conflict. Transactions remain the design.

The test report and scripts are kept outside the repo; the first build ticket repeats the four races above through #76's real server route.

#### Retries

A conflict comes back to the server; Databricks doesn't retry it. The server retries **the whole atomic block, re-reading everything**, never a single statement. It uses jittered exponential backoff starting at 250 ms, for up to 10 attempts. After that it shows "Busy, try again" and the idempotency key makes the next click safe. Tight retry loops starved under contention in the test.

### 7. #72's tables stay until #96 retires them, with new names that don't clash

New tables go in new schemas, one per area, and none reuses a #72 table name. The new one-person, one-dataset access request is `access_requests.dataset_access_requests`, not `requests.access_requests`. #96 drops the #72 tables the new model replaces, including `requests.pipeline` and `requests.pipeline_decisions`. The migration path, table by table, is in [`docs/data-model.md`](../data-model.md#migration-from-72).

**Why:**

- The old tables still back screens until #96 moves those screens, so the tables can't be dropped first.
- Separate schemas mean a build ticket never has to change an old table.
- A reader never confuses the cart request (items and provisioning steps) with the new access request, where one person asks a dataset's owners for one role.

**Rejected: reusing `requests.access_requests`.** Two different models would share one name, and old rows would look like new ones.

**Rejected: converting old rows into the new tables.** The models don't line up: a cart of items versus one role on one dataset, and a waiver per request versus an EIR per person. A conversion would have to invent data.

**Cost:** two generations of tables exist side by side until #96 merges, and the old `requests` schema reads as if it were current. The migration table in the data-model doc says which is which.

### 8. Intake datasets and owners get their UUIDs at submit

When a data provider submits an onboarding request, the server gives a UUID to:

- the future initiative
- each intake dataset
- each intake owner

Standup (#89) then creates the initiative, its datasets and their owners with those same IDs.

**Why:**

- The same dataset is one ID from intake through standup to its team page, so its history can be followed across areas without matching names.
- Standup becomes safe to retry: it inserts by ID only if the row isn't already there, so a retry can't create a second initiative or a second copy of a dataset.

**Rejected: creating IDs at standup.** A retried standup could create duplicates. An intake dataset also couldn't be linked to the dataset it became except by name, which isn't unique.

**Cost:** IDs are reserved for datasets that may be rejected and never exist. That's harmless, because nothing points at an ID until the row is created.

### 9. EIR: each submission, renewal and action is its own row; one draft per person; PDFs by volume path

**Renewal.** Here an **EIR renewal** means a person signing and submitting a new EIR while their current one is valid or has expired, so that it doesn't lapse. The word comes from PR #98's code (`renew`, `renewed`) and from the EIR lifecycle in [`docs/mvp-access-model.md`](../mvp-access-model.md). It is not **recertification**, the glossary's term for re-reviewing whether active _access_ should continue. That's why the glossary tells readers to avoid "renewal" for access. Tables and actions say `renewal` only for EIRs.

The EIR tables are:

- `eir.eirs`: one row per person.
- `eir.eir_submissions`: one row per submission, whether it's a first submission, a resubmission or a renewal. Each row holds the volume path of the signed PDF, its SHA-256 and its size.
- `eir.eir_actions`: one row per action.
- `eir.eir_drafts`: at most one unsigned draft per person.

The PDFs stay in the Unity Catalog volume. The tables hold only the path and integrity details, never a link or a token.

**Why:**

- A renewal runs alongside a valid EIR, so it needs its own stage, questions and answer without disturbing the current one. Today's nested `renewal` object holds only one at a time, and a new one overwrites the old.
- One row per submission makes "which PDF was valid when" a query.
- The hash proves the file in the volume is the one that was signed.
- A draft is unsigned work in progress that changes on every save, so it has its own row and version. Otherwise a draft save would conflict with a validator's decision on the EIR. Saving a draft isn't an action.
- Storing PDFs in a table would bloat it and duplicate what the volume already stores (ADR-0005 decision 6).

**Rejected: one EIR row with nested arrays** (today's shape). It can't enforce one row per volume path, and a renewal overwrites its predecessor.

**Rejected: an action row per draft save.** It would fill the audit with keystrokes that decided nothing.

**Cost:**

- Draft history isn't kept, only the last save.
- Expiry is worked out from `expires_at` when read, not written as an action. The audit shows when an EIR became valid and the date it expires, but no separate "expired" row.

### 10. No per-member access levels: a role grants a fixed set

_The human's decision (2026-10-04, #119)._ A dataset role (tester, developer or Maintainer) grants a fixed set of access, the set described on its role card. There is no `dataset_access_levels` table, and no action for setting levels. A member's access is fully described by their one role (decision 11).

**Why:**

- Owners add someone to a role and that's all they decide, which matches how the human expects the team page to work.
- The granularity (read, read/write, job management, folder management, folder reading per person) isn't needed yet. Building it into the schema would mean migrating it out later.
- The change list stays simple: adding, changing or removing a role lists the role's fixed grants.

**Rejected: one row per dataset, person and level** (the earlier draft of this decision). It modelled a choice owners don't need to make.

**Cost:** if per-person exceptions are needed later, they'll need a new table and a new decision. The role-to-privilege mapping (MVP open question 2) is unaffected.

**Direction, agreed with the human (2026-10-04); not part of this ADR's table catalogue yet:** the app still needs a record of everything a role gives on each dataset. Once open question 2 settles the concrete privileges, they move from `role-descriptions.json` into a `teams.dataset_role_grants` table: one row per dataset, role and concrete grant (a Unity Catalog privilege, a workspace or a folder). People get grants only through their role. The change list and the grant reconciler read this table to know exactly what to apply. Per-person toggles stay out. Per-person exceptions, if ever needed, would be a separate table layered on top, with its own decision. The table's columns (including which workspaces are **sensitive environments**, which the EIR gate in #90 needs) are designed when open question 2 is settled; until then the change list's `grants` text comes from configuration, as `docs/data-model.md` describes.

### 11. One role per person per dataset

`teams.dataset_members` has at most one row per dataset and person (#114). Changing a role updates that row. Owners always hold the Maintainer role, stored as `manager`.

**Why:**

- The roles nest: developer includes tester, and Maintainer includes developer. A second role on the same dataset adds nothing.
- One row per person is what #114's team page shows.

**Rejected: one row per dataset, person and role** (what #110 allows today). The team page would have to merge rows, and "change role" would be a remove plus an add.

**Cost:**

- #110's memory store allows several roles per person, so its adapter and tests change with #114.
- Removing an owner removes their only membership. Someone who stays on the team must be added back with another role.

### 12. History is kept indefinitely

_The human's decision._ Action tables, `eir_submissions` and the EIR PDFs in the volume are kept indefinitely for now:

- No job deletes history.
- No `VACUUM` runs with a retention window shorter than the default on action tables.
- `delta.logRetentionDuration` stays at least at its default.

This keeps every **row** of history. It does not keep every old **table version**: default `VACUUM` and log retention still remove old physical files and Change Data Feed files after their windows. Action tables are add-only, so their current contents are the full history; time travel and CDF are not part of the record.

This holds until a records schedule is set.

**Why:**

- The EIR is a person's signed attestation about handling FTI, and the action tables are the audit record.
- No retention period has been set yet. Deleting before one exists can't be undone.
- Keeping everything until a schedule exists is the only choice that can't break a future records rule.

**Cost:**

- Storage grows without limit. At MVP volume that's small: actions are short rows, and EIR PDFs are one per person per year or so.
- A records schedule will need its own ticket to put retention in place.

### 13. Change Data Feed on history tables only

_The human's decision._ Change Data Feed (CDF) is turned on for action tables and other add-only history tables (`email_bindings`, `eir_submissions`). It is not turned on for current-state tables.

**Why:**

- CDF on current-state tables would mostly duplicate the action tables, at a storage cost. Current state is what the actions produced, and the actions already record who, what, when and why, which CDF can't.
- On history tables, CDF gives a cheap, standard way for downstream jobs and monitoring to read new rows as they arrive.
- **CDF is not the audit record.** Databricks says a change data feed "is not intended to serve as a permanent record of all changes to a table". It only records changes made after it's turned on, and `VACUUM` and log retention remove its files ([change data feed](https://docs.databricks.com/aws/en/delta/delta-change-data-feed)). The action tables are the permanent record, whatever CDF does.

**Cost:**

- A change to a current-state table that somehow bypassed the write path wouldn't appear in any feed.
- `monitoring.invariant_violations` compares each record's version with its last action, which catches a change made outside the write path.

## Consequences

- **Every area follows the same pattern, with the exceptions in decision 1 named.** Every area uses the same column names and the same write steps, so a build ticket for one area reads like the others, and the audit view is a mechanical union.
- **History is complete and ordered.** For any record, its action rows in `record_version` order say who did what, when, why (`note`), and what it caused (`caused_by_action_id`). That one backward link replaces the ID arrays that linked records (`changeListEntryIds[]`, `entryIds[]`).
- **EDP staff get monitoring from day one.** `audit.actions` answers "who did what, when, to what". Views in `monitoring` show open work by stage and SLA, the change-list backlog, recent activity, incomplete writes and invariant violations. [How to trace what happened](../data-model.md#how-to-trace-what-happened) has example queries.
- **SLA due dates are written when a stage is entered** (`sla_due_at` and `sla_due_soon_at`, computed by `src/data/sla.ts` with its holiday calendar), so SQL views can show SLA state without reimplementing business days. Changing an SLA target affects stages entered after the change, not ones already running.
- **Enum values are enforced with `CHECK` constraints.** Keys are declared as informational `PRIMARY KEY` constraints so readers and tools can see them. Neither makes Delta enforce uniqueness: decision 6 does.
- **#76's server SQL route gains two things**: affected-row counts from `SqlClient.execute`, and, under option (c), one statement per `BEGIN ATOMIC` block with conflict retries.
- **Build tickets for each area follow this ADR** and write through #76's route. Each lands its area's DDL, its adapter methods and its branch of the audit view together.
- **Each adapter changes shape at the seam.** TypeScript types can stay nested for screens, and the adapter maps them to rows. Onboarding's imperative decision kinds (`approve`) map to past-tense action names (`approved`).

## Remaining open question

1. **The discovery catalogue.** There are two dataset tables:
   - `catalog.datasets` is #72's discovery catalogue: seeded rows describing data assets across the EDP, with free-text `owner` and `steward`, used by the search and catalog screens.
   - `initiatives.datasets` holds the datasets onboarded through the app, with real owners, teams and dataset tags.

   They describe overlapping things in different shapes, so in the end state a dataset onboarded in the app could appear in discovery twice, or not at all. **Recommendation:** keep them separate for the MVP, because discovery is reference data that isn't changed by app actions. Plan a follow-up in which discovery reads onboarded datasets from `initiatives.datasets` (joined to `teams.dataset_owners` for real owners), and `catalog.datasets` keeps only assets that weren't onboarded through the app. Decide that when #96 has retired the cart.

### Answered

- **Concurrency platform**: the human chose option (c), Delta multi-statement transactions, after it passed in the GovCloud workspace (decision 6). Option (a) stays the fallback if the production warehouse can't run them.

- **Retention**: see decision 12.
- **Change Data Feed**: see decision 13.
- **GovCloud runtime features.** The human states that GovCloud supports `CHECK` constraints, table isolation settings and the other Delta features used here. Transactions, conflict detection, uniqueness under concurrent writers and Change Data Feed were tested there on 2026-10-04 (decision 6). The first build ticket repeats the races through the real server route, and production needs a Preview-channel warehouse or a re-test on Current.
- **Old pipeline tables.** `requests.pipeline` and `requests.pipeline_decisions` are dropped in #96, with the rest of the old model. **Why:** they back the seven-stage pipeline screen that #96 retires, and `monitoring.open_work` replaces what that screen showed.

## Terminology amendment (#260)

_The human's decision (2026-10-18, #141)._ The dataset role this ADR first called `manager` is called **Maintainer** wherever people read it: everything a developer has, plus running the dataset's jobs and managing permissions on what the dataset publishes in prod. Only dataset owners, with EDP staff, decide who is on a dataset's team; a Maintainer who isn't an owner can't add or remove people. The stored value is still `manager` (`DatasetRoleName`, `teams.dataset_members.role`, action payloads, group-name suffixes), so no data or group was renamed. The `teams.dataset_members.role` `CHECK` constraint still allows `tester`, `developer` and `manager`. This ADR's prose now says Maintainer; where it quotes a stored value, it still says `manager`.
