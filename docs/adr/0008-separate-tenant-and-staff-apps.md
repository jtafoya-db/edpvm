# ADR-0008 — Separate tenant and EDP staff apps

- **Status:** Accepted (2026-10-06). Amends ADR-0007's change-list area and action columns as described in decisions 4 and 5. Amended 2026-10-18 for the MVP: one EDP admin group holds every staff role (see [Notes](#notes)).
- **Related:** ADR-0005 (domain access model), ADR-0007 (MVP Delta data model), [`GLOSSARY.md`](../../GLOSSARY.md), `docs/production-checklist.md` (private source document; not published)

## Context

Today one Databricks App serves everyone. Tenants use it to submit intake, sign their **EIR**, manage the people who hold **dataset roles** and request access. **EDP staff** use the same app to review onboarding, validate EIRs and work the **change list**.

The change list will eventually be applied automatically: adding people to **dataset groups**, issuing grants and setting tags. Whatever identity does that holds powerful rights. Three facts shape where that identity should live:

- **On-behalf-of-user (OBO) authorization can't start jobs.** The documented scopes a Databricks App can request for the signed-in person's token include no Jobs scope, and Databricks blocks anything outside those scopes. So EDP staff can't start an Apply job "as themselves" from inside an app. The fallback was tested on `example-workspace` (2026-10-04): an app's service principal holding `CAN_MANAGE_RUN` on one job can start it, and the run executes as the job's `run_as` identity.
- **An app's own identity is its service principal.** Anything the app does in Databricks, Databricks records as that service principal, not as the person who clicked.
- **Bugs in shared code have already crossed this line.** Review caught three: a file-path bug in #98 that let any signed-in person call workspace APIs with the app's credentials; caller-supplied reviewer roles in #99; and a Reject path in #108 that skipped the full ownership check. Each would have been far worse if the same app had also held grant rights.

## Decision

### 1. Two apps from one codebase

- **The tenant app** is open to everyone who uses the EDP. It has the intake and "My onboarding requests", the EIR form and submission, the pages where **dataset owners** manage owners and dataset roles, access requests and the owner's inbox, and discovery.
- **The EDP staff app** is open only to EDP staff groups. It has the **EDP business office** and **CCB** review inboxes, the **safeguards validators'** EIR inbox, the change list and **Apply**, owner reassignment, and the EDP management views.

Both are built from the same repository and the same data model (ADR-0007), with a build switch choosing each app's screens. They read and write the same Delta schemas, with per-table grants as set out in decision 3. The server enforces roles in both.

**Why:**

- The privileged identity is only reachable through an app that people outside EDP staff groups can't open.
- A bug in tenant-facing code can only reach the tenant app's low-privilege service principal.
- The split is simple to explain in an ATO review: the privileged identity sits behind a staff-only app, and every use of it is recorded.

**Rejected: one app with in-app role checks only.** Our code would be the only thing between a tenant and the privileged identity, on every route, every time. The three bugs above show how easily that check is missed.

**Rejected: OBO so EDP staff start jobs as themselves.** There's no Jobs scope, so it isn't possible today.

**Cost:**

- Two apps to deploy per environment. PR previews deploy the staff app only when the PR touches its screens.
- Moving today's staff screens out of the single app is a refactor, done before the Apply job is built.
- Links between the apps need each other's URLs from configuration.

### 2. Databricks gates the staff app before our code runs

The staff app's permissions give **`CAN_USE` only to the EDP staff groups**: EDP staff, safeguards validators, the EDP business office and the CCB. In the MVP that's one group, the EDP admin group (2026-10-18 amendment, [Notes](#notes)). `CAN_MANAGE` is held by the deploying group only. Anyone else is stopped by the Databricks Apps authorization layer and never reaches the app.

Workspace admins inherit `CAN_MANAGE` on apps, and with it the ability to open them. The design doesn't claim otherwise; their use is recorded like anyone else's.

Inside the staff app, the server still checks which staff role the person holds, for example a safeguards validator vs. the EDP business office. Those checks are a second layer, not the only one.

### 3. Three service principals, each limited by Unity Catalog grants

| Identity                                   | May                                                                                                                                                       | May not                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant app** service principal           | Write the tenant-side tables, and insert change-list entries                                                                                              | Insert into the approval or application tables; run the Apply job; change any Databricks group, grant or tag                               |
| **Staff app** service principal            | Write the staff-side tables, insert change-list entries, and insert into `changes.change_list_approvals`; `CAN_MANAGE_RUN` on the Apply job only          | Insert into `changes.change_list_applications` once the Apply job is live (decision 4); change any Databricks group, grant or tag directly |
| **Apply job** service principal (`run_as`) | Read entries and approvals; insert into `changes.change_list_applications`; change membership of the EDP groups it manages and grants on the EDP catalogs | Anything outside the EDP groups and catalogs                                                                                               |

- **Neither runtime app principal owns the schemas or tables.** An EDP deployment group owns them.
- **Each boundary is a separate table, because grants are per table.** Unity Catalog `INSERT` and `MODIFY` grants can't restrict which values a writer puts in a column. So the steps that must belong to one identity get their own add-only tables, granted to that identity alone:
  - `changes.change_list_approvals`: one row per entry approved for Apply. Only the staff app's principal may insert.
  - `changes.change_list_applications`: one row per entry applied, with the run ID and result. Once the Apply job is live, only its principal may insert (decision 4 covers the MVP's by-hand path).

  An entry's stage (`pending`, `approved`, `applied`) is derived from those tables, not stored on the entry. This amends ADR-0007's change-list area, where the stage was a column moved by actions. A forged entry from the tenant app is never applied, because only the staff app can approve it and only approved entries are applied.

- **The job's principal gets narrow rights, to be confirmed by the Apply-job ticket:** group manager on the specific EDP groups (a Preview feature that still includes write access) and `MANAGE` on the EDP catalogs, rather than account admin. Whoever creates the job needs the "Service principal user" role on that principal; that's an EDP staff deployment group, never an app.

### 4. The app records decisions; the Apply job acts on Databricks

- **Both apps write only their own tables**, in one `BEGIN ATOMIC` transaction per write (ADR-0007 decision 6).
- **Only the Apply job changes access in Databricks.** In the MVP there's no job yet: EDP staff apply the change list by hand, and the staff app records each one in `changes.change_list_applications` with `method = by-hand`. For that, the staff app's principal holds `INSERT` on that table during the MVP only. When the Apply job goes live, that grant is revoked and only the job writes applications, with `method = job`. When automation lands:
  1. An EDP staff member selects entries and clicks **Apply** in the staff app.
  2. In one transaction, the staff app inserts the approval rows and an `apply-requested` action naming the person.
  3. It calls `run-now` with the action's ID as the Jobs **idempotency token** (a UUID fits its 64-character limit), and the action's ID and the person's Databricks account ID as job parameters. The `apply-requested` action is already committed, so the attempt is on record before Databricks is called.
  4. It then inserts one `audit.job_invocations` row with the outcome: the action ID, job ID, the returned run ID, and whether the call succeeded. Nothing is updated in place.
  5. **If the app fails between steps 3 and 4,** the run isn't lost. `monitoring.unconfirmed_job_invocations` lists `apply-requested` actions older than five minutes with no `audit.job_invocations` row. Recovery calls `run-now` again with the same idempotency token:
     - If a run with that token exists, Databricks returns its run ID and doesn't start another.
     - If none was started, this starts it.

     Either way, recovery records the outcome row. If the earlier run was **deleted**, reusing the token fails. Recovery then marks the invocation failed, and the entries that have no application row stay approved, so a person can start Apply again. Any entry that run already changed is caught by step 6's desired-state check.

  6. The job applies only approved entries with no application row yet, and inserts one `changes.change_list_applications` row per entry, with its run ID and result. **Applying an entry is idempotent, because each entry describes a desired state, not a step.** The job reads the current state first, so:
     - adding someone who's already in the group changes nothing;
     - granting a privilege that's already held changes nothing;
     - removing someone who's already gone changes nothing.

     So if the job crashes after changing Databricks but before writing the application row, the next run finds the state already correct, makes no change, and writes the row.

  7. The group snapshot job (#109) later confirms the change.

**Why:** the click stays fast, the powerful rights stay in the job, and the app can only say "go" for work an EDP staff member has approved.

**The job is a gate, not a pass-through.** It acts on rows the staff app wrote, so a compromised staff app could still put entries in front of it. The job only earns its separate identity if it limits what those entries can do. It must:

1. **Never run SQL or instructions taken from a row.** It reads typed fields (dataset, role, person, operation) and builds every statement itself.
2. **Accept only a fixed set of operations:** add or remove a member of an EDP dataset group (`edp-ds-*`), and grant or revoke a role's fixed privileges (ADR-0007 decision 10) on an EDP catalog or schema. Nothing outside EDP's groups and catalogs, no ownership transfers, no `MANAGE`.
3. **Re-derive the expected end state from the source tables.** It recomputes what should be true from the team rows and the role grants, and refuses an entry that doesn't match. For example, no grant into a sensitive environment without a valid EIR.
4. **Refuse unusually large or unusual batches,** the way the group snapshot job (#109) holds back mass removals.

This allowlist is narrower than the change list: certification-tag changes and standup steps remain manual work, outside this job's execution scope. Before revoking the staff app's application-table grant, the later automation slice must provide a separate, authorized completion-recording path for these manual-only entries, preserving who acted and when without extending the job's execution rights. Automated Apply is a later-phase enhancement, not a prerequisite for the integrated MVP.

A refused entry stays approved but unapplied, with the reason recorded, and appears in the audit view.

**Why keep both the job and the staff app.** They protect against different failures:

| Setup                       | A tenant-facing bug is exploited                            | The staff app is compromised            |
| --------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| One app + job               | Can forge approvals; the job applies them within its limits | Same                                    |
| Two apps, no job            | Can't approve anything                                      | Gets the principal's full rights        |
| **Two apps + job (chosen)** | Can't approve anything                                      | Limited to the job's allowed operations |

The staff app controls _who can approve_: only its principal can insert approval rows. The job controls _what an approval can do_. Neither protects against an EDP staff member approving something they shouldn't; the audit trail covers that.

**Rejected: the staff app issuing grants directly.** It would put the job's rights back into an always-running web app, so any staff-app defect (a hijacked session, a validation gap, SSRF) would carry full group and grant rights. Kept as the fallback simplification only if security explicitly accepts that larger blast radius. Decided 2026-10-06 by the project owner.

### 5. Every use of the staff app's powers is attributable

Databricks records the person at the app proxy, but it records everything downstream (SQL, `run-now`) as the app's service principal. It doesn't join the two. So the apps build the chain themselves:

1. **The person comes from the server, never from the request body.** Two separate things are needed, and they come from different places:
   - **Who is signed in, for authentication and display:** the Databricks-injected proxy headers (`X-Forwarded-User`, `X-Forwarded-Email`). These fill `actor_display`.
   - **The stable account ID, for `actor_principal_id`:** the SCIM account ID that ADR-0004 decision 2 makes the key. It's resolved server-side, today through SCIM `/Me` with the forwarded access token (`src/server/identity.ts`). If that token isn't available, the only acceptable alternative is a mapping that is itself **keyed by a stable ID the proxy supplies**. For example, if `X-Forwarded-User` turns out to carry the account ID, the server can check it against the group snapshot table (#109), which an admin-owned job fills from SCIM. Looking a person up **by email** is not acceptable, because ADR-0004 rules email out as the key and a reused or reassigned address would attribute actions to the wrong person.
   - **If no stable-ID path works, writes fail closed.** The app refuses the action rather than recording an email or username in `actor_principal_id`. A string that isn't the account ID would break the joins and the audit attribution this decision exists for.

   This ADR also adds one column to ADR-0007's action columns: **`actor_app`** (`tenant`, `staff`, `job` or `system`), so every action says which identity wrote it.

2. **Every Databricks call carries the action's ID:**
   - as job parameters on `run-now`, with the run ID recorded in `audit.job_invocations` and `changes.change_list_applications`;
   - as SQL query tags (`edp_action_id`, `edp_app`) where available. Query tags are in Public Preview and not confirmed in GovCloud; a SQL comment is the fallback.
3. **One audit view joins it up:** person → action → job invocation or statement → applications → what Databricks recorded. It reads the app's tables, `system.access.audit` (the Jobs `runNow` events and Unity Catalog `updatePermissions`) and `system.query.history` where available.

That answers "who used the staff app's service principal to do what". It's also the first EDP management view to build.

## Consequences

- **A refactor ticket** moves the staff screens into the staff app and adds the build switch and the second bundle app. It comes before the Apply-job ticket.
- **An Apply-job ticket** builds the job, its principal's grants, the approval, application and job-invocation tables, the `actor_app` column and the audit view. It confirms the job principal's rights against real groups and catalogs.
- **ADR-0007's change-list tables** gain the approval and application tables; the entry's stage becomes derived. The change-list build ticket follows this ADR.
- **#121** (should EDP staff make themselves owners) is decided in the staff app.
- **`docs/production-checklist.md`** gains the three principals and their grants, the staff app's `CAN_USE` groups, and the GovCloud checks below.

## Must be verified before production

1. **Identity in GovCloud: headers _and_ the stable account ID.** On the IRS GovCloud demo workspace, every existing app reports `effective_user_api_scopes: null`, while the commercial test app reported two default scopes. With a throwaway app there, verify both:
   - that `X-Forwarded-User` and `X-Forwarded-Email` arrive;
   - that the server can resolve the person's stable SCIM account ID: through `/Me` with the forwarded access token, or, if there's no token, through a mapping keyed by a stable ID the proxy supplies (for example, whether `X-Forwarded-User` carries the account ID, checked against the group snapshot table from #109). An email lookup doesn't count.

   Header presence alone isn't enough. If no trustworthy path to the account ID exists, writes stay fail-closed (decision 5) and this blocks go-live. Not verified yet.

2. **Groups in GovCloud.** The identity headers carry no groups. Today the app reads the person's groups through the signed-in person's token with the default scopes. If that token isn't available in GovCloud, the apps need another source: for example, the group snapshot table from #109, read by the person's account ID. That would need no extra rights for either app.
3. **What a non-member sees** when they open the staff app: test with a real account outside the EDP staff groups.
4. **`system.query.history` and query tags** in the GovCloud workspace, before relying on tags. Job parameters plus the app's own tables are the baseline.

## Open questions for the human

1. **Who opens the staff app?** This ADR assumes the safeguards validators, the EDP business office and the CCB all use the staff app. If some of them aren't EDP staff, they may need their own screens in the tenant app instead. _Answered for the MVP (2026-10-18): they're all the EDP admin group, so they all use the staff app._
2. **Apply for every change, or automatic after approval?** The recommendation is an EDP staff click on Apply for every Databricks change, because access to FTI data should have a person look first.

## Notes

- **2026-10-18: one EDP admin group holds every staff role in the MVP (#226, #148 decision 2).** Decision 2's four staff groups are one group for the MVP: the **EDP admin group** (`EDP_ADMIN_GROUP_ID`). Its members hold every staff role: EDP staff, Safeguards validator, EDP business office and CCB. Anyone outside it holds none.
  - **Membership is direct (#226 decision, 2026-10-19).** Add each staff member directly to the EDP admin group. Membership through a nested group, including the workspace `admins` group, grants no EDP staff role. Widening this rule requires a later explicit decision.
  - **The staff app's `CAN_USE`** goes to the EDP admin group only.
  - **In-app role checks stay a second layer, role by role.** The server still checks each role, not just "is staff". Each role is derived from membership in the one group (`src/server/identity.ts`, `deriveStaffRoles`).
  - **Splitting a role out later** is a change to that one function plus deploy configuration. The bundle keeps `safeguards_validator_group_id`, `business_office_group_id` and `ccb_group_id` as variables reserved for that split. The app ignores them, and the deploy preflight warns if one is supplied.
  - **Decisions 1, 3, 4 and 5 are unchanged.** That includes the tenant/staff app split and the Apply boundary.
  - **Actor separation isn't decided here.** One member may act at every stage today. The rules for no self-validation and validation independence belong to #148. The existing rule that a validator can't decide their own EIR still applies.

## Terminology amendment (#260)

_The human's decision (2026-10-18, #141)._ The dataset role stored as `manager` is called **Maintainer** wherever people read it: everything a developer has, plus running the dataset's jobs and managing permissions on what the dataset publishes in prod. Only dataset owners, with EDP staff, decide who is on a dataset's team; a Maintainer who isn't an owner can't add or remove people. The stored value is still `manager` (`DatasetRoleName`, `teams.dataset_members.role`, action payloads, group-name suffixes), so no data or group was renamed. This ADR doesn't name that role. The "group manager" in decision 3 is Databricks' own group manager role on a group, which the Apply job's principal holds; it isn't the dataset role.
