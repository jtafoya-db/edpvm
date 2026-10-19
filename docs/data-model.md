# The MVP data model

How the app's records are stored in Delta: the naming rules, the two table patterns and their named exceptions, a catalogue of every table, how a write works, how to trace what happened, the audit and monitoring views, and the path from #72's tables to here. The decisions and their reasons are in [ADR-0007](adr/0007-mvp-delta-data-model.md). Terms in **bold** are defined in [`GLOSSARY.md`](../GLOSSARY.md).

> This is the target design. Today, #72's tables in `resources/store-schema.sql` are the only app tables on main; each area's tables land with that area's build ticket.

## Contents

- [Naming conventions](#naming-conventions)
- [The two table patterns](#the-two-table-patterns)
- [Table catalogue](#table-catalogue)
- [How a write works](#how-a-write-works)
- [How to trace what happened](#how-to-trace-what-happened)
- [The audit view](#the-audit-view)
- [Monitoring views](#monitoring-views)
- [Migration from #72](#migration-from-72)

## Naming conventions

### Schemas: one per area

All tables live in the bundle's catalog (`catalog_name` in `databricks.yml`).

| Schema            | Area                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `onboarding`      | **Onboarding requests** and their **intake packages**                  |
| `initiatives`     | **Initiatives** and their **datasets**                                 |
| `teams`           | **Dataset owners**, dataset members (one role each) and email bindings |
| `access_requests` | **Access requests** for a **dataset role**                             |
| `change_list`     | The **change list**                                                    |
| `eir`             | **EIRs**, their submissions and drafts; published **EIR definitions**  |
| `privacy`         | Immutable privacy-notice acknowledgments                               |
| `admin`           | `display_counters`: the next change-list number (`CL`)                 |
| `membership`      | The group snapshot (#109): who Databricks says is in each group        |
| `audit`           | The one view of every action                                           |
| `monitoring`      | Views for EDP staff                                                    |

Only `admin` is shared with #72, which has `admin.tenants` there; `display_counters` doesn't clash with it. The other schemas are new (#72's are `catalog`, `requests`, `access` and `admin`).

### Tables and columns

- **Names are `snake_case`, in plain words, using glossary terms.** A table is the plural of what one row is: `dataset_members` holds one member per row.
- **A current-state table's actions table is its singular name plus `_actions`**: `onboarding_requests` → `onboarding_request_actions`.
- **A table's own key is `id`**, except on action tables (`action_id`) and #109's snapshot tables, which keep the job's keys. A column pointing at another table's row is that table's singular name plus `_id`: `dataset_id`, `onboarding_request_id`.
- **A person is named by their role in the row**, with up to three columns: `<role>_principal_id` (their **Databricks account ID**; the column keeps Databricks' technical name), `<role>_display` (the name as shown), and `<role>_email` (trimmed and lower-cased). For example: `provider_principal_id`, `requester_display`, `person_email`. On action rows the role is always `actor`.
- **Times are `TIMESTAMP` in UTC and end in `_at`**: `occurred_at`, `stage_entered_at`, `expires_at`.
- **A change from one value to another is `from_<thing>` and `to_<thing>`**: `from_stage`/`to_stage` for a lifecycle, `from_role`/`to_role` for a dataset role.
- **No column holds a list of other rows' IDs.** A link points one way, from the later row back to what caused it (`caused_by_action_id`).
- **`ARRAY<STRING>` is only for a short list of plain values that's always written whole**, such as an intake's levers or an entry's grants. Never for anything with an ID.
- **JSON (`STRING` holding JSON) is only for a payload that's stored and shown as it was given, and never queried or updated in place**: the raw intake answers, and EIR form values. Each use is named in the catalogue with its reason.

### Enum values

Enums are `STRING` columns with a `CHECK` constraint listing the allowed values, which are the code's values (kebab-case).

| Enum                     | Values                                                                                  | Source                                                        |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Onboarding request stage | `submitted`, `business-roi-review`, `ccb`, `standup`, `active`, `rejected`, `withdrawn` | PR #99 `onboarding/types.ts:13-16`; `active` arrives with #89 |
| Initiative stage         | `standup`, `active`                                                                     | `src/data/datasets/types.ts:18`                               |
| Dataset role             | `tester`, `developer`, `manager`                                                        | `src/data/datasets/types.ts:10`                               |
| Access request stage     | `requested`, `active`, `rejected`, `withdrawn`                                          | PR #108 `access-requests/types.ts:13`                         |
| EIR stage                | `not-started`, `submitted`, `questions`, `valid`, `rejected`, `expired`, `revoked`      | PR #98 `eir/types.ts:4-5`                                     |
| EIR submission kind      | `first`, `resubmission`, `renewal`                                                      | New                                                           |
| Change-list entry kind   | `add-member`, `remove-member` (later: grants, revokes, tags, standup steps)             | `src/data/change-list/types.ts:48`                            |
| Change-list entry stage  | `pending`, `approved`, `applied`, derived, not stored (ADR-0008 decision 3)             | `applied: null` vs `{by,at}` today                            |
| Owner or member source   | `intake`, `configuration`, `app`                                                        | ADR-0006                                                      |

**Renewal** in EIR names means a person signing a new EIR so theirs doesn't lapse. It's not **recertification**, which is about access (ADR-0007 decision 9).

**Action names are past-tense verbs** in kebab-case, because a row records something that happened: `submitted`, `forwarded`, `approved`, `sent-back`, `rejected`, `withdrawn`, `resubmitted`. Each area's list is in its catalogue entry. Where code uses another form (onboarding's `approve`, the EIR's `valid`), the adapter maps it.

## The two table patterns

Every area uses the same two kinds of table: **current-state tables** say what's true now, and **action tables** say what anyone did, in order. Current-state tables are real tables, not views over the actions: screens read them directly, and the write that records an action updates them in the same transaction (ADR-0007 decisions 1 and 6).

The exceptions, each marked in the catalogue:

- **Child tables** hold a record's parts (intake datasets, EIR submissions). They follow the current-state pattern without `version`, and their history is on the parent's action table.
- **Add-only tables** (`teams.email_bindings`) have rows that never change, so they have no `version` or `updated_*`.
- **`eir.eir_drafts`** has a version but no action table, because a draft save decides nothing.
- **#109's snapshot tables** (`membership`) record what Databricks shows, so they keep the snapshot job's own shape and keys.
- **`admin.display_counters`** is one row per prefix, with no history.
- **`eir.eir_definition_versions`** is add-only and **`delta.appendOnly`**: Delta itself refuses any `UPDATE` or `DELETE` on it, and on `eir.eir_definition_actions`.

### Current-state columns

Every current-state table starts with these columns.

| Column                    | Type        | Meaning                                                                                                                                                                                                                       |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `STRING`    | UUID the server generated. The key. Declared `PRIMARY KEY` (informational).                                                                                                                                                   |
| `display_code`            | `STRING`    | Only on EIRs, onboarding requests and access requests: the **display code** people quote (`ONB-7K3QFD`), random and unique (ADR-0007 decision 2, amended 2026-10-10). Null on records made before display codes. Never a key. |
| `display_number`          | `BIGINT`    | Change-list entries: taken from `admin.display_counters`, shown with the prefix (`CL-0042`). On the other tables, only records made before display codes have one (`ONB-1000`); they keep it. Never a key.                    |
| `version`                 | `BIGINT`    | 1 when created, plus one on every change. Every update checks it.                                                                                                                                                             |
| `created_at`              | `TIMESTAMP` | When the row was created.                                                                                                                                                                                                     |
| `created_by_principal_id` | `STRING`    | The Databricks account ID of whoever created it, or `system`.                                                                                                                                                                 |
| `updated_at`              | `TIMESTAMP` | When the row last changed.                                                                                                                                                                                                    |
| `updated_by_principal_id` | `STRING`    | Who last changed it.                                                                                                                                                                                                          |
| `last_action_id`          | `STRING`    | The action that set this version. How a retry knows the state step is done.                                                                                                                                                   |

Lifecycle records (onboarding requests, access requests, EIRs) also have `stage`, `stage_entered_at`, `sla_due_at` and `sla_due_soon_at`. The two SLA columns are worked out by `src/data/sla.ts` when the stage is entered, and are null at stages with no SLA target.

Child tables have `id`, the parent's `<parent>_id`, `created_at` and, when they can change, `updated_at`. They have no `version`: they're only written together with a version change on the parent. Add-only tables (`teams.email_bindings`) have no `version` or `updated_*` either, because their rows never change.

### Action columns

Every action table has these columns, with these names.

| Column                       | Type        | Meaning                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action_id`                  | `STRING`    | UUID. The key.                                                                                                                                                                                                                                                                              |
| `<record>_id`                | `STRING`    | The record acted on, such as `onboarding_request_id`.                                                                                                                                                                                                                                       |
| `action`                     | `STRING`    | What happened: a past-tense verb from the area's list.                                                                                                                                                                                                                                      |
| `from_<thing>`, `to_<thing>` | `STRING`    | What changed, where the action moves something: `from_stage`/`to_stage` on lifecycle records. Null otherwise.                                                                                                                                                                               |
| `record_version`             | `BIGINT`    | The record's version after this action. Orders a record's history exactly, even when two actions share a timestamp. Unique per record.                                                                                                                                                      |
| `actor_principal_id`         | `STRING`    | Who did it: the Databricks account ID of the signed-in person, resolved by the server from the session and never taken from the request. `system` when the app acted with no person behind it (a forward, standup, loading configuration); real IDs are numeric, so `system` can't collide. |
| `actor_display`              | `STRING`    | Their name as shown when they did it; `EDP Vending Machine` for `system`.                                                                                                                                                                                                                   |
| `occurred_at`                | `TIMESTAMP` | When, in UTC.                                                                                                                                                                                                                                                                               |
| `idempotency_key`            | `STRING`    | The client's key for this one intent by a person. Unique among lead actions (those with no `caused_by_action_id`).                                                                                                                                                                          |
| `caused_by_action_id`        | `STRING`    | When another action caused this one (an approval that adds a member, which lists a change-list entry), that action's ID. Null for actions a person took directly.                                                                                                                           |
| `note`                       | `STRING`    | Why, in the actor's words: a reviewer's note, send-back questions, a rejection reason. Null if none.                                                                                                                                                                                        |
| `payload`                    | `STRING`    | JSON, only in tables that name it below, for details with no column of their own. Null elsewhere.                                                                                                                                                                                           |
| `command`                    | `STRING`    | Lead actions only: JSON of the whole requested change, as the server validated it. Recovery and retries use this, never a resent request body.                                                                                                                                              |
| `command_hash`               | `STRING`    | Lead actions only: SHA-256 of `command`. The same key with a different hash is refused.                                                                                                                                                                                                     |
| `expected_effects`           | `STRING`    | Lead actions only: JSON list of every follow-on row the write must produce (table and ID), so a check can prove the write is complete.                                                                                                                                                      |
| `result`                     | `STRING`    | Lead actions only: JSON of the row the command's response is built from, read inside the same transaction. A replay of the key returns exactly this response, never the record's later state.                                                                                               |

Every action moves its record's version up by one, even an action that changes nothing else (a refusal such as `access-refused`), so each action has its own place in the record's order and `last_action_id` always points at the newest action. A refusal can therefore make a concurrent write by the same record's owner conflict and retry; that's the safe direction. An add-only record has one action, at version 1.

Action tables are append-only: never updated, never deleted, and kept indefinitely until a records schedule exists (ADR-0007 decision 12). Change Data Feed is on for them and the other add-only history tables, and off for current-state tables (decision 13). CDF is a feed for downstream readers, not the audit record: the action rows are.

## Table catalogue

`PK` is the key. "Unique" lists rules Delta doesn't enforce by itself: the write checks them inside its transaction, and `monitoring.invariant_violations` reports any that are broken (see [How a write works](#how-a-write-works)). Columns from the shared patterns above aren't repeated unless they need a word.

### Onboarding (`onboarding`)

**`onboarding_requests`**: one row per **onboarding request**, holding its current stage and the parts of the **intake package** reviewers read. Display prefix `ONB-`.

| Column                          | Type                  | Meaning                                                                                                                                                                           |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `display_code`            |                       | PK; `ONB-` display code (`display_number` on requests made before codes)                                                                                                          |
| `title`                         | `STRING`              | The request's title                                                                                                                                                               |
| `initiative_id`                 | `STRING`              | The UUID the **initiative** will have, reserved at submit (ADR-0007 decision 8)                                                                                                   |
| `provider_principal_id`         | `STRING`              | The **data provider** who submitted it                                                                                                                                            |
| `provider_display`              | `STRING`              | Their name at submit                                                                                                                                                              |
| `submitted_at`                  | `TIMESTAMP`           | When it was first submitted                                                                                                                                                       |
| `stage`, `stage_entered_at`     | `STRING`, `TIMESTAMP` | Current **stage** and when it was entered                                                                                                                                         |
| `sla_due_at`, `sla_due_soon_at` | `TIMESTAMP`           | SLA dates for the current stage (business & ROI review, CCB)                                                                                                                      |
| `initiative_name`               | `STRING`              | From the intake                                                                                                                                                                   |
| `business_case`                 | `STRING`              | From the intake                                                                                                                                                                   |
| `annual_benefit`                | `DECIMAL(18,2)`       | From the intake                                                                                                                                                                   |
| `levers`                        | `ARRAY<STRING>`       | From the intake: a short list, always written whole                                                                                                                               |
| `workspace_isolation`           | `STRING`              | Workspace-needs answer                                                                                                                                                            |
| `workspace_team_size`           | `INT`                 | Workspace-needs answer                                                                                                                                                            |
| `intake_answers`                | `STRING` (JSON)       | Every raw intake answer, as given, so reviewers read what the provider filled in (PR #99 `types.ts:41-43`). The fields above are extracted from it; this column is never queried. |
| `open_send_back_from_stage`     | `STRING`              | While a **send-back** is open: the review stage that sent it, where the **resubmission** returns                                                                                  |
| `open_send_back_action_id`      | `STRING`              | The `sent-back` action holding the questions. Null when none is open.                                                                                                             |
| `initiative_owner_kind`         | `STRING`              | Who owns the **initiative** (#103): `self` (the provider picked Myself) or `someone-else`. Null on requests made before it was asked                                              |
| `initiative_owner_display`      | `STRING`              | The initiative owner's name: the signed-in session's for `self`, as typed for `someone-else`                                                                                      |
| `initiative_owner_email`        | `STRING`              | Their email, normalised. Display and matching data, never a key (ADR-0006)                                                                                                        |
| `initiative_owner_principal_id` | `STRING`              | The signed-in session's principal for `self`; null for `someone-else`                                                                                                             |

Unique: `id`; `display_code`; `display_number`.

**The initiative owner** is one person per request, so it's four columns here rather than a row in `onboarding_intake_owners`. That table's rows are dataset owner contacts: each has an `intake_dataset_id`, and standup turns each into a `teams.dataset_owners` row with the same ID, which an initiative owner must never become. The columns are nullable and added by upgrade steps, so they can move to a child table later without touching the dataset owner rows.

**Who counts as verified (#103).** An owner is verified only when they are the provider's own signed-in session: Myself stores the server-resolved principal (the session's SCIM `/Me` id; the browser sends `{ "kind": "self" }` and nothing else). Someone else is a name and an email the provider typed. The email's format is checked, it's stored normalised, its principal is null, and the owner reads as **not verified**. Nothing confirms that the person is a Databricks user, and nothing writes an `email_bindings` row (ADR-0006). Each dataset owner is chosen the same way, Myself or Someone else, and the same rule applies: a contact whose `person_principal_id` is the provider's own is verified. A dataset can have Myself as at most one of its owners; the provider can be the initiative owner and an owner of several datasets. These rules live in `src/data/onboarding/owners.ts`, so the next resolver (staff matching, then owner resolution in code, #249) replaces them there.

A **resubmission** can change the whole intake (#222): it rewrites `title`, the extracted intake columns and `intake_answers` from the intake the provider edited, after the server re-validates all of it. `id` and `display_code` never change.

**`onboarding_intake_datasets`** (child): one row per **dataset** named in the intake.

| Column                  | Type     | Meaning                                                 |
| ----------------------- | -------- | ------------------------------------------------------- |
| `id`                    | `STRING` | PK, and the ID the dataset gets at standup (decision 8) |
| `onboarding_request_id` | `STRING` | The request                                             |
| `position`              | `INT`    | Order in the intake                                     |
| `name`                  | `STRING` | Dataset name                                            |
| `domain`                | `STRING` | A **domain** ID, or `other`                             |
| `dataset_tag`           | `STRING` | The dataset tag                                         |

Unique: (`onboarding_request_id`, `position`). A contract test must fail when the submitted `IntakeSchema` fields change without a matching update to these extracted columns and their adapter mapping.

**`onboarding_intake_owners`** (child): one row per owner contact named for an intake dataset. It's contact data, not ownership: standup turns it into a `teams.dataset_owners` row with the same ID.

| Column                  | Type     | Meaning                                                                                                            |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                    | `STRING` | PK, and the ID the owner record gets at standup                                                                    |
| `intake_dataset_id`     | `STRING` | The intake dataset                                                                                                 |
| `onboarding_request_id` | `STRING` | The request, so a request's owners are one filter                                                                  |
| `position`              | `INT`    | Order on the dataset                                                                                               |
| `person_display`        | `STRING` | The name the provider gave                                                                                         |
| `person_email`          | `STRING` | The email the provider gave, normalised                                                                            |
| `person_principal_id`   | `STRING` | Their Databricks account ID: the provider's own when they picked Myself (#103), else null until matched or standup |

Unique: (`intake_dataset_id`, `person_email`).

On a **resubmission** (#222) the provider can add and remove datasets and owner contacts, and change the initiative owner. The browser names a kept row by its `id`, and the server refuses any `id` that isn't one of this request's rows (an owner's must be on the same dataset). A kept row is updated in place, `position` included. So is its `person_principal_id`: the session's for Myself, null for a contact typed in, so switching an owner from Myself to someone else clears it. A new row gets a follow-on ID of the resubmit action. A row the provider removed is deleted; the removal is in the `resubmitted` action's `note` and `payload`. No column was added for this.

**`onboarding_request_actions`**: one row per transition or edit on a request. `from_stage`/`to_stage`. `payload` on `resubmitted` is `{"answer", "changes"}`: the answer on its own, and one `{"field", "before", "after"}` per intake field the resubmission changed (every wizard answer, by its wizard label; dataset names, domains, tags and owner contacts), empty when only the answer is new. A dataset or owner contact added or removed is one change with `"kind": "added"` or `"removed"` and the whole record as its `after` or `before`. It's null on every other action, and on resubmissions stored before #221, which have only their `note`.

A **resubmission** returns to the review stage that sent the request back (#221): `open_send_back_from_stage`, or, if a row lacks it, the `from_stage` of the `sent-back` action `open_send_back_action_id` names. If neither is a review stage, it goes to the business & ROI review, the stage every resubmission used before. The server reads this from the stored row; the resubmit command can't name a stage. Entering the stage writes fresh `sla_due_at`/`sla_due_soon_at` from that stage's configured target.

| Action        | Who                   | Meaning                                                                               |
| ------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `submitted`   | data provider         | Created the request                                                                   |
| `forwarded`   | `system`              | Moved to the next stage with no one deciding (**forward**)                            |
| `approved`    | reviewer at the stage | **Approval** past their stage                                                         |
| `sent-back`   | reviewer at the stage | **Send-back**; `note` holds the questions                                             |
| `resubmitted` | data provider         | Answered a send-back; `note` holds the answer. Returns to the stage that sent it back |
| `rejected`    | reviewer at the stage | **Rejection**; `note` holds the reason                                                |
| `withdrawn`   | data provider         | **Withdrawal**                                                                        |
| `activated`   | `system`              | Standup finished (#89)                                                                |

### Initiatives and datasets (`initiatives`)

**`initiatives`**: one row per **initiative**, created at standup with the ID reserved at submit.

| Column                  | Type     | Meaning                                                                                                                  |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | `STRING` | PK; equals `onboarding_requests.initiative_id`, or the configured ID for one loaded from deployment configuration (#123) |
| `onboarding_request_id` | `STRING` | The request that started it                                                                                              |
| `name`                  | `STRING` | Initiative name                                                                                                          |
| `tenant`                | `STRING` | The **tenant**                                                                                                           |
| `stage`                 | `STRING` | `standup` or `active`                                                                                                    |

Unique: `onboarding_request_id`.

**`initiative_actions`**: `created` (standup began), `activated`. `from_stage`/`to_stage`.

**`datasets`**: one row per **dataset** onboarded in the app.

| Column          | Type     | Meaning                                                                                                      |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `id`            | `STRING` | PK; equals the intake dataset's ID, or the configured ID for one loaded from deployment configuration (#123) |
| `initiative_id` | `STRING` | Its initiative                                                                                               |
| `name`          | `STRING` | Dataset name                                                                                                 |
| `domain_tag`    | `STRING` | Its domain tag                                                                                               |
| `dataset_tag`   | `STRING` | Its dataset tag                                                                                              |

Unique: `dataset_tag`.

**`dataset_actions`**: `created`, `renamed`. Certification (`certified`, `deprecated`, `certification-removed`, with `from_certification`/`to_certification`) and **dataset additions** follow this pattern when they're built.

This is not #72's `catalog.datasets`, which is the seeded discovery catalogue (ADR-0007 open question 2).

### Dataset teams, owners and email bindings (`teams`)

**`dataset_owners`**: one row per **dataset owner** of a dataset. Every owner also has a `dataset_members` row with the manager role (ADR-0005 decision 2).

| Column                | Type        | Meaning                                                                                                                        |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `STRING`    | PK; for intake owners, equals the intake owner's ID                                                                            |
| `dataset_id`          | `STRING`    | The dataset                                                                                                                    |
| `source`              | `STRING`    | `intake`, `configuration` or `app`                                                                                             |
| `person_display`      | `STRING`    | Name                                                                                                                           |
| `person_email`        | `STRING`    | Normalised email; null for an owner known only by Databricks account ID                                                        |
| `person_principal_id` | `STRING`    | Databricks account ID: given for intake and configuration owners, copied from `email_bindings` for app-added owners once bound |
| `bound_at`            | `TIMESTAMP` | When the email binding was copied here; null until bound                                                                       |

Unique: one row per person per dataset (ADR-0006 decision 6): no two rows on a dataset share an email, or an account ID, or an email bound to an account ID another row has. At least one of `person_email` and `person_principal_id` is set (`CHECK`). A dataset always keeps at least one owner (checked by the write).

**`dataset_owner_actions`**: `from_*`/`to_*` unused. `payload` holds the dataset and the person as recorded, because the owner row is deleted on removal; on `access-refused`, also the refused account ID.

| Action           | Meaning                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `added`          | Made an owner (at standup with `actor = system`, or by an owner or EDP staff)                                              |
| `bound`          | The email binding was copied onto this record                                                                              |
| `access-refused` | A session with this email but another account ID was refused (ADR-0006 decision 5); `payload` holds the refused account ID |
| `removed`        | No longer an owner; the row is deleted from `dataset_owners`                                                               |

**`dataset_members`**: one row per person holding a **dataset role** on a dataset. One role per person per dataset (ADR-0007 decision 11), enforced on every add path.

| Column                | Type     | Meaning                                              |
| --------------------- | -------- | ---------------------------------------------------- |
| `id`                  | `STRING` | PK                                                   |
| `dataset_id`          | `STRING` | The dataset                                          |
| `role`                | `STRING` | `tester`, `developer` or `manager`                   |
| `source`              | `STRING` | `intake` (owners named at intake) or `app`           |
| `person_display`      | `STRING` | Name                                                 |
| `person_email`        | `STRING` | Normalised email; null for an intake owner with none |
| `person_principal_id` | `STRING` | Databricks account ID once known                     |

Unique: one row per dataset per person, matched by email. At least one of `person_email` and `person_principal_id` is set (`CHECK`). One role per person per dataset is enforced in the write, not by a table constraint (Delta `PRIMARY KEY`/`UNIQUE` are informational): adding a person who already holds a role refuses — a repeat of the role they hold records nothing, a different role is refused and a switch goes through `change-member-role`. The same pure rule (`src/data/datasets/membership.ts`) runs in the memory store and the Delta command, and the add's block guards one member row per (dataset, person) so concurrent different-role adds converge to one row rather than two. Making an existing member an owner is refused for the same reason, since every owner also holds the manager role (ADR-0005).

**`dataset_member_actions`**: `from_role`/`to_role`. `payload` holds the dataset and the person as recorded, because the member row is deleted on removal. A role grants a fixed set of access (ADR-0007 decision 10), so there are no per-member access levels.

| Action         | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `added`        | Given a role, directly by an owner or by an approved access request (`caused_by_action_id`) |
| `role-changed` | Moved from one role to another                                                              |
| `removed`      | Role removed; the member row is deleted                                                     |

**`email_bindings`** (add-only): one row per email bound to a Databricks account ID (ADR-0006 decisions 3 and 4). Inserted once, never updated or deleted.

| Column                    | Type        | Meaning                                                                |
| ------------------------- | ----------- | ---------------------------------------------------------------------- |
| `id`                      | `STRING`    | PK                                                                     |
| `email`                   | `STRING`    | Normalised email                                                       |
| `principal_id`            | `STRING`    | The Databricks account ID it's bound to                                |
| `created_at`              | `TIMESTAMP` | When it was bound                                                      |
| `created_by_principal_id` | `STRING`    | The session that bound it (the same account ID, or EDP staff via #103) |

Unique: `email`.

**`email_binding_actions`**: `bound`, the only action, carrying the dataset where it happened in `payload`. Refusals are on `dataset_owner_actions`, where EDP staff look for them.

### Access requests (`access_requests`)

**`dataset_access_requests`**: one row per **access request**: one person asking one dataset's owners for one dataset role. Display prefix `AR-`. Not #72's `requests.access_requests`.

| Column                          | Type        | Meaning                                        |
| ------------------------------- | ----------- | ---------------------------------------------- |
| `id`, `display_code`            |             | PK; `AR-` display code                         |
| `dataset_id`                    | `STRING`    | The dataset                                    |
| `role`                          | `STRING`    | The dataset role asked for                     |
| `reason`                        | `STRING`    | Why they need it, in their words               |
| `requester_principal_id`        | `STRING`    | Who asked (from their session)                 |
| `requester_display`             | `STRING`    | Their name                                     |
| `requester_email`               | `STRING`    | Their email, so the member row can match       |
| `requested_at`                  | `TIMESTAMP` | When                                           |
| `stage`, `stage_entered_at`     |             | `requested`, `active`, `rejected`, `withdrawn` |
| `sla_due_at`, `sla_due_soon_at` | `TIMESTAMP` | The owners' SLA, while `requested`             |

Unique: `display_code`; one open (`requested`) request per (`requester_principal_id`, `dataset_id`). PR #108 allows one per role; with one role per person (#114), one per dataset is enough.

**`dataset_access_request_actions`**: `from_stage`/`to_stage`. `requested`, `approved` (its `dataset_member_actions` row points back with `caused_by_action_id`), `rejected` (`note` is the reason), `withdrawn`. PR #108's `changeListEntryIds[]` is replaced by those back-links.

### Change list (`change_list`)

**`change_list_entries`**: one row per **change list** entry: one change for EDP staff to make in Databricks. Display prefix `CL-`. An entry's description never changes after it's listed. Its stage isn't stored here: ADR-0008 decision 3 derives it from the two add-only tables below (`applied` if it has an application, `approved` if it has an approval, otherwise `pending`), so that each step can be granted to one identity.

| Column                 | Type            | Meaning                                                                                                                              |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `display_number` |                 | PK; `CL-` number                                                                                                                     |
| `kind`                 | `STRING`        | `add-member`, `remove-member`                                                                                                        |
| `reason`               | `STRING`        | Why, as a kind: `dataset-role-added`, `dataset-role-changed`, `dataset-role-removed`, `dataset-owner-added`, `dataset-owner-removed` |
| `caused_by_action_id`  | `STRING`        | The action that listed it. Who and when come from there, so they're not copied here.                                                 |
| `dataset_id`           | `STRING`        | The dataset                                                                                                                          |
| `group_name`           | `STRING`        | The **dataset group**, for membership entries                                                                                        |
| `role`                 | `STRING`        | The dataset role, for membership entries                                                                                             |
| `person_display`       | `STRING`        | Whom it's about                                                                                                                      |
| `person_email`         | `STRING`        | Their email, for EDP staff to find the person in Databricks                                                                          |
| `person_principal_id`  | `STRING`        | Their Databricks account ID, once known                                                                                              |
| `grants`               | `ARRAY<STRING>` | What the role grants or the person loses, from config when listed                                                                    |

Unique: `display_number`. An entry already listed, pending or applied, is never listed again (ADR-0005 decision 6): the grant reconciler checks this table's net state before listing.

**Who may read the change list (least privilege).** EDP staff see every entry; anyone else sees only entries on datasets they own, matched by their owner records (a read never binds an email). This is intentional: entries carry other people's names, emails and grants, so a signed-in user who owns none of the affected datasets sees nothing, rather than the whole queue. The `change-list/entries` read scopes this on both backends (`src/data/datasets/memory.ts`, `src/server/delta/areas/teams.ts`). A dataset's members and team history stay readable by anyone signed in, as the read-only team page has shown since #110.

**`change_list_entry_actions`**: `from_stage`/`to_stage`. `listed` (always `caused_by_action_id` set), `applied`.

**`change_list_approvals`** (add-only): one row per entry approved for Apply: `id`, `change_list_entry_id`, `created_at`, `created_by_principal_id`, `caused_by_action_id`. Only the staff app's principal may insert. Nothing writes it until the Apply job (ADR-0008 decision 4). Unique: `change_list_entry_id`.

**`change_list_applications`** (add-only): one row per entry applied in Databricks: `id`, `change_list_entry_id`, `method` (`by-hand` or `job`), `run_id` and `outcome` (the Apply job's; null by hand), `created_at`, `created_by_principal_id`, `caused_by_action_id`. In the MVP EDP staff apply by hand and the staff app records `by-hand`; once the Apply job is live only its principal inserts. Unique: `change_list_entry_id`.

ADR-0008 names these `changes.*`; they live in the `change_list` schema with the entries, because grants are per table and the schema makes no difference to the boundary.

### EIR (`eir`)

**`eirs`**: one row per person with an **EIR**.

| Column                          | Type        | Meaning                                                                                        |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `id`                            | `STRING`    | PK                                                                                             |
| `display_code`                  | `STRING`    | The **Record ID**, a display code (`EIR-7K3QFD`) shown on the form and in the PDF. Never a key |
| `display_number`                | `BIGINT`    | The Record ID of an EIR started before display codes (`EIR-1042`); null since                  |
| `person_principal_id`           | `STRING`    | Whose EIR it is                                                                                |
| `person_display`                | `STRING`    | Their name                                                                                     |
| `stage`, `stage_entered_at`     |             | EIR stage. `expired` is shown when `expires_at` has passed; see below.                         |
| `sla_due_at`, `sla_due_soon_at` | `TIMESTAMP` | The safeguards validator's SLA, while an EIR submission waits                                  |
| `expires_at`                    | `TIMESTAMP` | When the valid EIR expires; null unless it has been valid                                      |
| `valid_submission_id`           | `STRING`    | The submission that made it valid                                                              |
| `open_submission_id`            | `STRING`    | The submission waiting on a validator (first, resubmission or renewal), or null                |
| `current_submission_id`         | `STRING`    | The submission the stage is about: its form values are the EIR's signed form                   |
| `renewal_submission_id`         | `STRING`    | A renewal running alongside the valid EIR (submitted, sent back or rejected)                   |

Unique: `person_principal_id`; `display_code`; `display_number`. `id` is a UUID v5 of the person's Databricks account ID, so a draft can name the EIR before its row exists. The row is created when the person starts the form (`eir/start`, a `started` action, stage `not-started`), so the PDF they sign carries its Record ID; a first submission with no start creates it too. Expiry isn't written: readers and views show `expired` when `stage = 'valid'` and `expires_at` has passed (ADR-0007 decision 9).

**Submission kinds** (decision 2026-10-05): a `first` submission is a person's first, and also starting again after their EIR was **rejected or revoked**; a `resubmission` answers a send-back; a `renewal` renews a **valid or expired** EIR. A valid EIR stays valid while its renewal is pending: the renewal runs alongside it (`renewal_submission_id`), and only its approval replaces the expiry. Only safeguards validators decide and revoke, and never on their own EIR.

**`eir_submissions`** (child): one row per signed PDF submitted.

| Column                                   | Type               | Meaning                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | `STRING`           | PK                                                                                                                                                                                                                                                                                                                   |
| `eir_id`                                 | `STRING`           | The EIR                                                                                                                                                                                                                                                                                                              |
| `kind`                                   | `STRING`           | `first`, `resubmission` or `renewal`                                                                                                                                                                                                                                                                                 |
| `volume_path`                            | `STRING`           | Where the signed PDF is in the Unity Catalog volume. Never a link or token.                                                                                                                                                                                                                                          |
| `document_sha256`, `document_size_bytes` | `STRING`, `BIGINT` | The PDF's hash and size when signed, to prove the file in the volume is the one submitted                                                                                                                                                                                                                            |
| `form_values`                            | `STRING` (JSON)    | The form as signed. JSON because the fields come from configuration and are still open (MVP access model open question 7); the PDF is the record.                                                                                                                                                                    |
| `form_version`                           | `STRING`           | The EIR definition the answers were given under (#224): a published version's number (`1`, `2`…), a built-in definition's reserved name (`bootstrap`), or a form version stored before #224: `1.3` (the bootstrap's content), `1.2`, or `0.1` for #98's interim checklist (migrated as it was, never as 1.2 answers) |
| `form_started_at`                        | `TIMESTAMP`        | When the person started this form (its draft's start, else the submission). The yearly training rule counts back a year from it                                                                                                                                                                                      |
| `stage`                                  | `STRING`           | This submission's own stage: `submitted`, `questions`, `valid`, `rejected`, or `closed` (a renewal closed because the EIR was revoked)                                                                                                                                                                               |
| `submitted_at`                           | `TIMESTAMP`        | When                                                                                                                                                                                                                                                                                                                 |

Unique: `volume_path`. Kept indefinitely, with the PDFs (decision 12). The submission's questions, answers and decisions are on `eir_actions`.

**`eir_drafts`**: one unsigned draft per person, overwritten on each save. It has `version` and `updated_*` but no actions table: a draft save decides nothing (decision 9).

| Column            | Type            | Meaning                                                                  |
| ----------------- | --------------- | ------------------------------------------------------------------------ |
| `id`              | `STRING`        | PK                                                                       |
| `eir_id`          | `STRING`        | The EIR                                                                  |
| `form_values`     | `STRING` (JSON) | The draft form                                                           |
| `form_version`    | `STRING`        | The EIR definition it's pinned to: as on `eir_submissions`               |
| `form_started_at` | `TIMESTAMP`     | When this draft started: its first save since a submission last used one |

Unique: `eir_id`. A submission clears it (`form_values` null).

**`eir_draft_saves`** (named exception): the transaction runner keeps every command's idempotency key, command and result on a lead-action row, and a draft save has no action. So its lead rows go here, in the action-table columns, and **not** into `audit.actions`. Only `saved`. This keeps the saved values in `command`, so a draft's history is kept here even though `eir_drafts` holds only the last save.

**`eir_evaluations`**: one append-only, system-attributed evaluation of an exact `eir_drafts.version`. It records the definition it ran against (`definition_version` and `form_version`, both the draft's pinned definition since #224), effective time, overall outcome, structured rule outcomes (stable reason code, field, disposition and guidance), and whether the result could ever be eligible for automatic validity. A later draft version makes an earlier evaluation stale; blocking results refuse PDF generation and upload. A definition-load or evaluator failure that the repository can record becomes persisted `manual-review`, never blocking or valid. If persistence or transport fails, no evaluation is invented or saved; the person is told to retry. Evaluations are computed evidence, not user or staff decisions, so they are intentionally excluded from `audit.actions` and remain queryable in `eir.eir_evaluations`. This table does not authorize automatic validity or FTI use; #148 remains the policy gate.

**`eir_actions`**: `from_stage`/`to_stage` (the EIR's stage), plus `eir_submission_id` for actions on one submission. `payload` is `{"selfDecisionTestMode":true}` on a validator's decision on their own EIR, which only a PR preview's test mode allows (`docs/eir-volume.md` → "Preview test mode"); the server alone sets it, and `audit.actions.self_decision_test_mode` is derived from it. A Send response (`docs/eir-volume.md` → "Answering a send-back") is a `resubmitted` or `renewal-submitted` action on the sent-back submission itself, with no new submission row.

| Action              | Who                  | Meaning                                                                                                                                                                                           |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started`           | the person           | Started the form: the EIR gets its Record ID                                                                                                                                                      |
| `submitted`         | the person           | First submission                                                                                                                                                                                  |
| `sent-back`         | safeguards validator | Questions (code: `questions`); `note` holds them                                                                                                                                                  |
| `resubmitted`       | the person           | Answered; `note` holds the answer                                                                                                                                                                 |
| `validated`         | safeguards validator | Marked valid (code: `valid`); sets `expires_at`                                                                                                                                                   |
| `rejected`          | safeguards validator | Rejected                                                                                                                                                                                          |
| `revoked`           | safeguards validator | Revoked early                                                                                                                                                                                     |
| `renewal-submitted` | the person           | A renewal (code: `renewed`)                                                                                                                                                                       |
| `renewal-closed`    | `system`             | A renewal closed because the EIR was revoked                                                                                                                                                      |
| `migrated`          | `system`             | Imported from #98's interim volume record (#126); `payload` names the source file. The record's earlier actions follow it as follow-ons that keep who acted and when, with `actor_app = 'system'` |

`from_stage`/`to_stage` are stored stages (never `expired`). An action on a renewal running alongside leaves the stage where it was (`from_stage = to_stage`), which is how readers tell it from an action on the EIR itself.

_Decision note (2026-10-05): safeguards validators, not EDP staff, revoke EIRs._

### EIR definitions (`eir`)

Published **EIR definitions** (#201), from `resources/store-eir-definitions.sql`. Only the staff app writes them (ADR-0008): Safeguards publish and activate in EDP Admin → EIR definitions. The **built-in definitions** (`src/data/eir/definition/<id>.eir.yaml`) are never stored here; each has a reserved identity no publish can take (#224). The fallback, `bootstrap-2` (every rule blocking, #217), is active until a published version is activated; `bootstrap` stays loaded for drafts and EIRs given under it or under its old label, form 1.3. None of these tables holds anyone's EIR answers.

**`eir_definition_register`**: one row (a fixed ID), created by the first publish. Every publish and activation is version-checked against it, so of two at once, one commits and the other is refused as stale.

| Column                  | Type     | Notes                                                              |
| ----------------------- | -------- | ------------------------------------------------------------------ |
| `active_version_number` | `BIGINT` | The published version new EIR drafts use; null: the bootstrap one  |
| `latest_version_number` | `BIGINT` | The last version number published; the next publish takes one more |

Plus the current-state columns.

**`eir_definition_versions`** (add-only, append-only table): one row per published version. Nothing edits or deletes one.

| Column                                                                                  | Type        | Notes                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                    | `STRING`    | UUID                                                                                                                                                                                         |
| `version_number`                                                                        | `BIGINT`    | 1, 2, 3… in publication order, assigned by the server at publish (#224): the version's identity                                                                                              |
| `definition_version`, `form_version`                                                    | `STRING`    | Since #224, `version_number` as text, the value drafts and submissions record. Before #224 they held the YAML's own `definitionVersion` and `form.version`, which a definition no longer has |
| `source_yaml`                                                                           | `STRING`    | The YAML exactly as published                                                                                                                                                                |
| `normalized_definition`                                                                 | `STRING`    | JSON: the validated definition the #200 service made of it                                                                                                                                   |
| `content_sha256`                                                                        | `STRING`    | SHA-256 of `source_yaml`, the content identity                                                                                                                                               |
| `published_action_id`                                                                   | `STRING`    | Its `published` action                                                                                                                                                                       |
| `published_at`, `published_by_principal_id`, `published_by_display`, `published_by_app` |             | Who published it, from which app (`staff`), and when: from the session, never the body                                                                                                       |
| `created_at`                                                                            | `TIMESTAMP` |                                                                                                                                                                                              |

Unique: `version_number` and `content_sha256`. Delta has no unique constraint, so the publish write checks both inside its own atomic block: it refuses when any row already has that number or that content, whoever wrote it, and the register's version refuses a publish that read an older register. Two publishes at once get two numbers or one refusal, never the same number. A CHECK keeps `version_number` at 1 or more, so no publish takes a built-in definition's identity. A stored version is loaded again before it's used, and must still load and still match its hash. If the active one doesn't, there's no current EIR form: employee EIR commands refuse as unavailable rather than fall back. Reactivating a version that loads is the recovery.

**`eir_definition_actions`** (append-only table): the action columns, plus `definition_version_number` (the version published or activated) and `from_active_version`/`to_active_version` (a version number, or `bootstrap`).

| Action      | Who        | Meaning                                                                                                      |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `published` | Safeguards | Published a new version; the active version doesn't change                                                   |
| `activated` | Safeguards | Made a version active for new drafts. `payload` `{"rollback":true}` when that version had been active before |

**Which definition an EIR uses.** An EIR definition names no version of its own: the YAML may not contain `definitionVersion` or `form.version`, and the server numbers each publish (#224). A draft is pinned to the definition active when it began, by that identity (`eir_drafts.form_version`: the version number, or a built-in's name, `bootstrap` or `bootstrap-2`), and each submission records the one it was signed on (`eir_submissions.form_version`). A new draft starts on the active definition; a draft already started keeps its own through any later publish, activation or rollback, and so does a sent-back submission answered with Send response. The pre-check (`eir_evaluations`), the generated PDF and the upload all resolve the definition by the draft's pinned identity, not whichever is active now. The PDF prints it on one line ("EIR definition: version 7", or "EIR definition: bootstrap (version 0)"). If that definition can't be loaded, the evaluation is recorded as `manual-review`.

**Reserved identities.** Published versions are `1`, `2`, `3`…; a built-in definition is a reserved name that is never digits. The bootstrap definition is `bootstrap`, shown as version 0. A second built-in definition takes `bootstrap-2` (shown as "bootstrap-2 (version 0)") with no schema change: the column is text, and publish only ever assigns numbers of 1 or more. Answers stored before #224 keep their form version (`1.3` is the bootstrap's content, `1.2` and `0.1` the earlier forms) and show with their own labels. A version published before #224 names its own versions in its YAML, so it no longer loads; preview data is disposable, and no production EIR definitions or EIRs exist to migrate. The validity period and review SLA still come from deployment configuration (`eir_validity_days`), not from the published definition.

**The EIR rule set (#217).** In `bootstrap-2` every rule is `blocking`: User ID and Manager ID format; Unauthorized Access, Privacy and Cyber Awareness training within the training timeline; IRM 10.5.8 acknowledged; IRS NDA signed; MBI start not in the future; MBI expiration on or after its start; MBI not expired on the evaluation date (`not-past`); and MBI investigation not preliminary or incomplete. An answer that fails one refuses PDF generation and upload, and its rule's `guidance` tells the employee what to go do, by the field and in the summary. Answers that meet every rule pass. This rule set, its values and its wording are a **non-production MVP default pending Safeguards (#148)**; the guidance is marked "[Placeholder wording]" until Safeguards supplies it. A published definition may give any rule any disposition (`irs-id` can only block), but every `blocking` rule except `irs-id` must carry `guidance` that isn't empty or only whitespace (the checker refuses it with `missing-guidance`, so #201's publish path does too); an ID-format rule's form error already says what to do. A blank or malformed answer is a form error with the form's own reason code (`EIR-FORM-<FIELD>-INVALID`), whatever rules its field has; a rule's code is only given when that rule fails. A `within-timeline` rule applies its timeline, both ends included (UTC), with a day the target month lacks taken as its last day: a date passes when it's no less than `min` units (`years`, `months` or `days`) before the day it's checked, and no more than `max` units before the timeline's `anchor`. `anchor: form-started` (the default when it's left out) counts `max` back from the day the draft was started, which is what `bootstrap-1` and form 1.2 mean, so their drafts and older EIRs keep their meaning; `anchor: evaluated` counts it back from the day it's checked, which is what `bootstrap-2` uses. The anchor is part of the normalized field rule (`within-timeline:<anchor>:<unit>:<min>:<max>`). Windows longer than 10 years, 120 months or 3660 days are refused. Every scenario must have real `formStartedAt` and `submittedAt` dates (its own or inherited), so its outcome doesn't depend on when it runs. `manual-review` remains the outcome for evaluator or definition failures. `bootstrap-1` keeps form 1.3's mix: ID checks block, compliance answers are `manual-review` or `warning`. The validity period and review SLA still come from deployment configuration (`eir_validity_days`), not from the published definition.

### Privacy acknowledgments (`privacy`)

**`acknowledgments`** is an immutable, append-only record of acknowledgments only. Refusals and a person's choice to leave are never recorded.

| Column                       | Type        | Meaning                                                              |
| ---------------------------- | ----------- | -------------------------------------------------------------------- |
| `action_id`                  | `STRING`    | Primary key for the immutable `acknowledged` action                  |
| `acknowledgment_id`          | `STRING`    | Stable acknowledgment identifier                                     |
| `action`                     | `STRING`    | Always `acknowledged`                                                |
| `notice_version`             | `STRING`    | Version of the notice the person acknowledged                        |
| `content_hash`               | `STRING`    | SHA-256 identity of that version's canonical heading, body, and help |
| `record_version`             | `BIGINT`    | Version used by the command transaction                              |
| `actor_principal_id`         | `STRING`    | Authenticated principal; never accepted from the caller              |
| `actor_display`, `actor_app` | `STRING`    | Authenticated display name and the tenant or staff app               |
| `occurred_at`                | `TIMESTAMP` | When the acknowledgment was recorded                                 |
| remaining action columns     |             | Idempotency, causation, command, expected-effects, and result data   |

Rows are never updated or deleted. Repeated and concurrent acknowledgment commands for the same principal and notice collapse to one logical row through the command's idempotent transaction. A notice-version change requires a new row before EIR work can continue. These records are retained indefinitely until an approved records schedule says otherwise, and deployment rollback keeps them; rollback must never revert or erase acknowledgment history.

Under [ADR-0008](adr/0008-separate-tenant-and-staff-apps.md), only the tenant app's server-side command path writes acknowledgments. Staff receives the read-only `privacy/audit` path needed to inspect a person's notice history. Privacy is intentionally absent from the combined `audit.actions` SQL view, so `create_audit_view` does not depend on `create_privacy_tables`.

### Group snapshot (`membership`)

These are #109's tables (`resources/membership-schema.sql` on its branch), kept as they are. They record what Databricks shows, not what anyone did in the app, so they aren't action tables, and the snapshot job owns them.

- **`group_members`**: one row per (`group_id`, `user_id`): `group_name`, `kind` (domain or dataset), `domain`, `dataset_tag`, `managed_by`, `email`, `display_name`, `first_seen`, `last_seen`, `removed_at`. Change Data Feed is on. Only `first_seen` and `removed_at` changes are membership history; `last_seen` moves every run.
- **`snapshot_runs`**: one row per run: `run_id`, `started_at`, `ended_at`, `status`, `groups_expected`, `groups_read`, `unresolved_members`, `message`. A run is complete only when its expected set is non-empty and every expected group was read.

Two names differ from these conventions: `user_id` holds a Databricks account ID (`person_principal_id` here), and `first_seen`/`last_seen` don't end in `_at`. Renaming them before #109 merges is cheap; after, it's a migration.

### Display counters (`admin`)

**`display_counters`**: one row per display prefix (`ONB`, `AR`, `CL`), holding `prefix` (PK), `next_number` (`BIGINT`) and `updated_at`. A write that creates a numbered record moves `next_number` up by one in the same transaction. Two creations at once both update the same row, which Delta treats as a conflict, so one retries and no number is handed out twice. This replaces an identity column, which Databricks doesn't allow on tables that take concurrent writes (ADR-0007 decision 2).

## How a write works

Every write follows the same steps, as one atomic transaction (`BEGIN ATOMIC … END`). The human selected option (c) in ADR-0007 decision 6 after it passed the GovCloud validation. The example is an owner approving an access request.

1. **The server resolves who's acting** from the session (ADR-0004), never from the request body.
2. **The client sends an idempotency key and the version it read.** The key is a UUID the screen creates once for each intent, and resends unchanged on a retry.
3. **The server builds the command**: the validated change as JSON, its SHA-256, and the follow-on rows it will produce, with IDs derived from the new action ID (UUID v5 of the action ID and position).
4. **Inside one transaction**, the server:
   1. **Reads the lead action with this key.** If one exists and its `command_hash` matches, the write already happened: return the stored result (the lead action's `result`). If the hash differs, refuse the request as a reused key.
   2. **Checks the rules against current state**: the person owns the dataset, the request is still `requested`, the record's `version` equals the version read, and any uniqueness rule holds (for a new request: no open request for this person and dataset).
   3. **Writes everything**: the lead action with `command`, `command_hash`, `expected_effects` and `result`, and `record_version` = read version + 1; the state row (`version = version + 1`, `last_action_id`); the follow-on rows and their actions (here the member's `added` and each change-list entry's `listed`, with `caused_by_action_id`); and `admin.display_counters` for any new number.
5. **Commit.** Databricks commits all of it or none of it. If another transaction changed a row this one changed, or added a row matching something this one read (a "phantom read"), the commit fails. Example: a second open request for the same person and dataset.
6. **On a conflict**, the server retries the whole transaction from step 4, with jittered exponential backoff starting at 250 ms, for up to 10 attempts (ADR-0007 decision 6, Retries). A retry re-reads, so it either finds the other writer's work (an idempotency hit) or refuses: "This changed since you opened it. Reload to see the latest."
7. **Return the new state.** The screen replaces what it had.

A new record is the same, with read version 0: the action takes version 1 and the state row is inserted.

**Why this order and these checks:**

- The transaction removes partial writes.
- The stored command means a retry never trusts a resent body.
- Delta's phantom-read and write-write conflicts are what make "check, then insert" safe. Delta has no enforced unique constraints, and two plain inserts never conflict ([conflict matrix](https://docs.databricks.com/aws/en/optimizations/isolation/row-level-concurrency)).
- `SqlClient.execute` returns affected-row counts (`num_affected_rows` from the Statement Execution API), so a version-checked update that changed nothing can never pass as a success.

**If option (a), one serialised writer, is needed as the fallback:**

- The same steps run as separate statements in the order action, then state, then follow-on rows.
- All writes go through the single writer.
- Row-level concurrency is turned off on these tables.
- A retry finishes a half-done write from the stored `command` and `expected_effects`.
- `monitoring.incomplete_writes` lists any write that stopped part-way.

## How to trace what happened

Three queries cover most questions. Each reads the tables or views in this doc and nothing else.

**Everything that happened to one record, in order: who, what, when and why.** For example, access request `AR-7K3QFD` and everything it caused:

```sql
WITH RECURSIVE chain AS (
  SELECT a.* FROM audit.actions a
  JOIN access_requests.dataset_access_requests r ON a.record_id = r.id
  WHERE r.display_code = 'AR-7K3QFD'
  UNION ALL
  SELECT a.* FROM audit.actions a JOIN chain c ON a.caused_by_action_id = c.action_id
)
SELECT occurred_at, actor_display, record_type, action, from_value, to_value, note
FROM chain
ORDER BY occurred_at, record_version;
```

The result reads like a story. The person asked for access. The owner approved, with their note. That added the member, which listed `CL-` entries, and EDP staff later marked them applied.

**Everything one person did**, across every area, newest first:

```sql
SELECT occurred_at, area, record_type, record_id, action, from_value, to_value, note
FROM audit.actions
WHERE actor_principal_id = :databricks_account_id
ORDER BY occurred_at DESC;
```

**Open work for monitoring**: what's waiting, on whom, and how close it is to its SLA:

```sql
SELECT area, waiting_on, sla_state, count(*) AS items, min(stage_entered_at) AS oldest
FROM monitoring.open_work
GROUP BY area, waiting_on, sla_state
ORDER BY sla_state = 'breached' DESC, oldest;
```

## The audit view

**`audit.actions`** is one `UNION ALL` of every action table, with the shared columns normalised. It answers "who did what, when, to what, and why" across the app, and a record's history is `WHERE record_id = … ORDER BY record_version`. Its last column, `self_decision_test_mode`, is true only for an EIR self-decision taken in a PR preview's test mode, derived from the action's structured `payload` (false in every other branch); no note text can stand for it.

```sql
CREATE OR REPLACE VIEW audit.actions AS
SELECT 'onboarding' AS area, 'onboarding_request' AS record_type, onboarding_request_id AS record_id,
       action_id, action, 'stage' AS changed, from_stage AS from_value, to_stage AS to_value,
       record_version, actor_principal_id, actor_display, occurred_at,
       idempotency_key, caused_by_action_id, note
FROM onboarding.onboarding_request_actions
UNION ALL
SELECT 'teams', 'dataset_member', dataset_member_id,
       action_id, action, 'role', from_role, to_role,
       record_version, actor_principal_id, actor_display, occurred_at,
       idempotency_key, caused_by_action_id, note
FROM teams.dataset_member_actions
-- …one branch per action table: initiative, dataset, dataset_owner, email_binding,
-- dataset_access_request, change_list_entry, eir, eir_definition_register
;
```

| Column                                               | Meaning                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `area`, `record_type`, `record_id`                   | Which table the action is on, and which record                                    |
| `action`                                             | What happened                                                                     |
| `changed`, `from_value`, `to_value`                  | What moved (`stage`, `role`, `certification`), from what to what; null if nothing |
| `record_version`                                     | The record's order                                                                |
| `actor_principal_id`, `actor_display`, `occurred_at` | Who and when                                                                      |
| `idempotency_key`, `caused_by_action_id`             | Which intent it came from, and what caused it                                     |
| `note`                                               | Why                                                                               |

Following `caused_by_action_id` backwards from a change-list entry gives the whole chain: `listed` ← member `added` ← access request `approved`. Each area's build ticket adds its branch to the view.

## Monitoring views

For EDP staff, on Databricks dashboards or in the app. Each is a plain view over the tables above.

**`monitoring.open_work`**: everything waiting on someone, by stage and SLA state. One row per open onboarding request (not terminal and not `active`), open access request (`requested`) and EIR with an open submission.

| Column                       | Meaning                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `area`, `record_id`, `label` | What it is, and how people refer to it (`ONB-7K3QFD`, `AR-7K3QFD`, the person for an EIR)                                                      |
| `stage`, `stage_entered_at`  | Where it sits, since when                                                                                                                      |
| `waiting_on`                 | The **reviewer** role: `business-office`, `ccb`, `edp-staff`, `dataset-owner`, `safeguards-validator`, or `provider` while a send-back is open |
| `sla_due_at`                 | When the stage's SLA target is reached                                                                                                         |
| `sla_state`                  | `breached` once past `sla_due_at`, `due-soon` once past `sla_due_soon_at`, otherwise `on-track`; null at stages with no SLA                    |

Grouped by `area`, `stage` and `sla_state`, it's the "open work by stage" chart; filtered to `breached`, it's what's **escalation-appropriate**.

**`monitoring.change_list_backlog`**: every `pending` change-list entry, oldest first, with `kind`, `dataset_id`, `group_name`, `person_display`, the time it was listed (from its `listed` action), and `age_days`. Grouped by kind, it shows how much EDP staff have to apply and how long it's waited.

**`monitoring.recent_activity`**: `audit.actions` for the last 30 days, newest first, with the record's display label joined in. It's the activity feed, and filtered by `actor_principal_id` it's one person's trail.

**`monitoring.incomplete_writes`**: lead actions older than five minutes where either the record's current `version` is below the action's `record_version`, or a row listed in `expected_effects` doesn't exist. Under atomic transactions it should always be empty. A row means a write stopped part-way and nobody retried it (see [How a write works](#how-a-write-works)).

**`monitoring.invariant_violations`**: one row per broken rule, with the rule's name and the record. It covers:

- a uniqueness rule broken: two open requests for one person and dataset, two members or owners for one person on a dataset, two bindings for one email, a duplicate display code, display number, idempotency key or (`record_id`, `record_version`)
- a dataset with no owner, or an owner without the manager role
- a current-state row whose `last_action_id` isn't its newest action, which would mean it was changed outside the write path
- an owner or member whose cached principal ID disagrees with `teams.email_bindings`, an orphan child row, or duplicate logical rows hidden behind different IDs

A rule for the EIR gate (no access into a **sensitive environment** for a person without a valid EIR) is added with #90, once change-list entries record their target workspace and whether it's sensitive.

Built so far (`resources/store-audit.sql`, #177): the duplicate display code and duplicate display number rules, for every table in the store's area schemas that has those columns, as columns `rule` (`duplicate-display-code` or `duplicate-display-number`), `record_table`, `record_id` and `detail` (the value). The other rules come with the rest of the monitoring views.

It should always be empty. It's the alarm that the uniqueness checks in [How a write works](#how-a-write-works) have been bypassed.

## Migration from #72

#72's 18 tables (`resources/store-schema.sql:8-27`) stay untouched while the new areas land. Nothing is converted from old rows to new ones: the models don't line up (ADR-0007 decision 7).

**Order of build tickets**, each through #76's server SQL route, each landing its DDL, adapter methods and audit-view branch together:

1. `initiatives`, `teams` and `change_list` (#123, `resources/store-teams.sql`). These back #110's team screens. Datasets and owners from deployment configuration (`EDP_PILOT_CONFIG_JSON`; on a preview without it, the sample in `src/data/datasets/seed.ts` with owners from `EDP_SEED_DATASET_OWNER_IDS`; in production without it, nothing) are loaded once as `created` and `added` actions by `system`. See `docs/delta-backend.md` → "The pilot configuration".
2. `access_requests` (PR #108).
3. `onboarding` (PR #99), then standup creating initiatives, datasets and owners from the reserved IDs (#89).
4. `eir` (PR #98; built in #126). #98's interim volume records are migrated by `scripts/eir-volume-migration.ts`: see [`eir-volume.md`](eir-volume.md#migrating-the-interim-records-126) for the row-count check and the rollback path.
5. The `monitoring` views, once their areas exist.

New DDL goes in its own file next to `store-schema.sql` and runs from the same bundle job, with `CREATE … IF NOT EXISTS` so a rerun is safe. New tables are Unity Catalog managed tables with catalog commits enabled (`'delta.feature.catalogManaged' = 'supported'`), which multi-statement transactions need. The first build ticket also runs the concurrency test in ADR-0007 decision 6 in the GovCloud workspace before any area depends on it.

**What happens to each #72 table:**

| #72 table                                                                                                                | End state                                                                                                                         | When                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `requests.access_requests`, `requests.request_items`, `requests.request_steps`                                           | Dropped. The seven-stage cart request, replaced by `access_requests.dataset_access_requests` and `onboarding.onboarding_requests` | #96                        |
| `requests.waiver_attestations`                                                                                           | Dropped. The per-request waiver, replaced by the per-person EIR (ADR-0005 decision 4)                                             | #96                        |
| `catalog.access_bundles`, `catalog.bundle_components`, `catalog.dataset_required_bundles`, `catalog.onboarding_personas` | Dropped. The catalog cart's bundles, replaced by domain entitlements and dataset roles                                            | #96                        |
| `access.my_access_bundles`                                                                                               | Dropped. A person's bundles                                                                                                       | #96                        |
| `requests.pipeline`, `requests.pipeline_decisions`                                                                       | Dropped. The seven-stage pipeline screen, replaced by `monitoring.open_work` (the human's decision)                               | #96                        |
| `access.my_access`, `access.my_access_workspaces`                                                                        | Dropped once the **access view** reads `membership` and `teams`                                                                   | The access-view ticket     |
| `catalog.source_systems`, `catalog.domains`, `catalog.datasets`, `catalog.dataset_lineage`                               | Kept: discovery reference data, not app records                                                                                   | Open (ADR-0007 question 2) |
| `admin.tenants`                                                                                                          | Kept: reference data                                                                                                              | —                          |

Before #96 drops a table in an environment that holds anything other than test data, it copies the table into an `archive` schema (`CREATE TABLE … DEEP CLONE`). Unity Catalog's `UNDROP` window is a safety net, not the plan. #96 also deletes the adapter methods for the dropped tables (`delta.ts:281-355`) and their memory equivalents.

Each migration ticket records the archived source tables' row counts before anything is dropped, compares old and new reads side by side at the `DataStore` seam, and names the per-area rollback path before switching readers. A mismatch stops the cutover; archived source tables remain available until the human accepts the reconciliation.

**End state:** the schemas above, every app table following the two patterns, `audit.actions` covering every action, and from #72 only the discovery reference tables and `admin.tenants`.
