# Group membership snapshot operations

The job observes Databricks account-group membership and never changes groups. Databricks is the source of truth. A `managed_by: scim` snapshot shows the latest membership written by SCIM; EDP staff maintain `managed_by: manual` groups after BEARS approval. Dataset groups must be manual and must not contain nested groups.

## Set up identities and grants

1. Have an account administrator create a dedicated service principal owned by EDP platform operations. Never use the app service principal.
2. The shipped job currently uses the Workspace SCIM API, so its only wired identity path is the workspace-admin fallback proven in the spike. The preferred Account Groups API path—Manage on only the allowlisted groups—still needs account-host and M2M credential wiring plus a non-production authorization test. Databricks has no roster-read-only permission; Manage also permits mutations and deletion. Do not claim least privilege until that path exists and has security approval.
3. `scripts/deploy-turnkey.sh` runs `provision_membership_snapshot` with the deploying identity before it applies app grants. Grant the recurring job identity `USE CATALOG`, `USE SCHEMA`, `SELECT`, and `MODIFY` on those tables; it does not need schema ownership. Production requires `membership_job_sp`, sets the job's `run_as.service_principal_name`, enables a runtime service-principal identity check, and is the only target whose schedule is unpaused. Preview and dev stay paused and may run manually as the deployer only for an admin-path proof.
4. The wrapper grants the separate app identity only `USE CATALOG`, `USE SCHEMA`, and table-level `SELECT` on `group_members` and `snapshot_runs` (the reader's `latestRun()` reads `snapshot_runs` so the UI can show when the snapshot was last refreshed). Never grant the app write or SCIM access. The live reader runs through the server SQL proxy with the app service principal. Its current and Change Data Feed queries expose domain groups for the domains of a dataset owner's datasets and dataset groups only for that owner's exact dataset tags; EDP staff see all rows. Manager-only identities see no member rows. No membership catalog, schema, token, or credential is sent to the browser.

## Add an allowlisted group

The committed empty allowlist is preview-only. Production preflight requires a non-empty `membership_allowlist_json`. Each run records `groups_expected` and `groups_read`; only a run with `status = 'succeeded'`, at least one expected group, and every expected group present in `groups_read` is complete and eligible to establish freshness. If an operator unpauses a preview schedule without overriding the empty default, every snapshot run records `partial` and fails by design.

When upgrading an existing deployment, re-run `provision_membership_snapshot` before running the new notebook so the `groups_expected` column exists before the job writes it. Existing rows have no expected set and never count as fresh; expect one stale alert until the first new complete run succeeds.

The committed allowlist is empty. Pass `membership_allowlist_json` when deploying. Every entry has a unique immutable `group_id`, non-empty display `group_name`, `kind` (`domain|dataset`), `domain`, `managed_by` (`scim|manual`), and `account_group: true`. Dataset entries also require `dataset_tag` and `managed_by: manual`. The `account_group: true` field is the operator's explicit assertion that the group is an account group, not workspace-local: the snapshot reads through the workspace SCIM API, which returns both, but workspace-local groups are invisible to `is_account_group_member()` (the #115 row-filter path) and would snapshot rows no one can read. The job fails closed on any entry that omits it. Automatic account-scope verification waits on the Account Groups API path (set-up step 2). Never discover by prefix. Confirm it is an account group and whether SCIM writes it, obtain security approval, update the deployment value, run once manually, and inspect `snapshot_runs` plus the new rows. Removing a group from the allowlist leaves its existing rows untouched; retire or archive those rows through an explicit operator procedure rather than treating an absent configuration entry as an empty roster.

The default cadence is 15 minutes. Manual groups allow at most 10 removals per group/run; SCIM-managed groups default to 100 because normal sync churn can be larger. An entry can override this with `max_removals`. A guard is per-group: adds/re-adds are still written, removals are skipped, the reason is recorded, and later groups continue. Runs serialize, retry typed throttling/server exceptions, refuse removals after partial or suspicious zero-user responses, record nested groups/service principals, and enable Change Data Feed. A nested group in a dataset group produces a warning and is never flattened.

Set `alert_emails` to the EDP staff addresses for Jobs failure notifications. When it is empty, failures alert nobody. Guarded removals, partial user lookups, suspicious empty rosters, and nested dataset groups are collected while every allowlisted group is processed, then fail the run so `on_failure` fires.

A completed run, for freshness purposes, means `status = 'succeeded'`, `groups_expected` contains at least one group, and `groups_read` contains every expected group. Old rows with a null expected set and partial or empty runs are stale.

A Jobs `on_failure` email cannot fire when a scheduled run never starts — or has never completed one — so the bundle ships a companion job, `membership_snapshot_freshness` (`jobs/membership_snapshot/monitor.py`), on the same cadence and the same `alert_emails`. Each run reads the newest complete row of `snapshot_runs` and fails on purpose after `--allowed-missed` scheduled opportunities (default two) have strictly passed without success, which sends the same `on_failure` email. A prior successful, complete run excludes its own opportunity, and an opportunity firing exactly at the check time is not yet missed. A `snapshot_runs` table with no complete run is treated as stale rather than silent: it counts from the `membership_monitor_since` baseline (the schedule's go-live, set when unpausing), including the opportunity at go-live itself; with no baseline configured the monitor fails closed and alerts. Keep `membership_cadence_seconds` in sync with `membership_schedule`, and keep `membership_monitor_schedule` on the same period as `membership_schedule` but offset within it (default seven minutes later) so a just-completed run is recorded before the monitor checks. The monitor cannot detect an outage that also stops the monitor itself; a platform-level job-health alert still backstops a full scheduler outage.

An intentionally empty group with previously active snapshot rows is indistinguishable from a truncated response. It therefore warns and preserves those rows on every run until an operator resolves the condition; this is the deliberate fail-closed trade-off.

`last_seen` advances for every observed active membership on every run. Consumers for #93 must interpret CDF only when `removed_at` changes (null to timestamp for removal, timestamp to null for re-add), not every update preimage/postimage.

The app reader inspects at most 1,000 table-history entries and requests Change Data Feed from the earliest commit in the most recent six days. This stays inside Delta's default seven-day deleted-file retention boundary. A dormant table with no commit in that window returns no history rather than asking Delta for vacuumed files. The reader returns only inserts and updates where `removed_at` changed, in pages capped at 500 rows. Each page includes a keyset `nextCursor` over `(commitVersion, groupId, userId)`, or `null` when exhausted, so bulk changes from one commit continue without dropped rows. The pre-image join relies on the snapshot MERGE key having one row per `(group_id, user_id)` in each commit. Longer audit retention or archival remains an operator decision and is not implied by the reader.

The raw `managed_by` value is part of the reader result. Its user-facing labels (“Managed by BEARS (SCIM)” and “Managed by hand”) belong to the domain picker (#105) and access view (#93), which are outside this job slice.

## Local tests

The deployed task is `jobs/membership_snapshot/notebook.py`, a source-format
Databricks notebook with titled cells for parameters, identity checks, roster
reads, reconciliation/MERGE, all-group processing, and audit completion.
The roster/MERGE cells expose the actual per-group code; the processing cell
executes it for each allowlisted group. Pure rules remain in `reconcile.py`.
Task parameters are notebook widgets supplied by DAB `base_parameters`.

With no successful run, go-live itself is the first scheduled opportunity:
go-live 12:00, 15-minute cadence, checks 12:07 and 12:22 count one and two
misses respectively (the second check alerts). With a success at 12:00,
those checks count zero and one. An opportunity firing exactly at the check
time is not yet missed.

The pure Python tests need only the standard library:

```bash
python -m unittest discover -s jobs/membership_snapshot -p 'test_*.py'
```

The TypeScript reader tests run in `npm test`.
