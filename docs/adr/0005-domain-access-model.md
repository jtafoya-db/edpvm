# ADR-0005 — The domain access model

- **Status:** Accepted. Supersedes ADR-0001, ADR-0002 and ADR-0003.
- **Refined by:** ADR-0007 (how the change list and every action are stored in Delta).
- **Related:** [`docs/mvp-access-model.md`](../mvp-access-model.md), [`GLOSSARY.md`](../../GLOSSARY.md), ADR-0004 (identity), `src/data/datasets/`, `src/data/change-list/`

## Context

The app modelled access as one seven-stage request lifecycle (ADR-0001), routed to domain owners in the app (ADR-0002), with a live-data waiver checklist on each request (ADR-0003). Each new dataset would also have needed its own BEARS entitlement, so the entitlement catalog would grow with every dataset. That isn't how access on the EDP is meant to work.

## Decision

Access comes in layers, and only the coarse layer lives in BEARS.

1. **BEARS holds two kinds of entitlement.** The **Databricks entitlement** gives an account plus the dev and test workspaces, with basic compute and no data. One **domain entitlement** per **domain** gives read access to that domain's `certified` and `deprecated` data: the **data consumer** role. Domain owners approve these in BEARS, outside the app. The app reads domain-group membership but never manages it.
2. **Dataset groups are managed in the app.** Each **dataset** has a **tester**, a **developer** and a **manager** group. Its **dataset owners**, named at intake and keyed by SCIM id, decide who is in them. A dataset always has at least one owner, and any owner can act alone. Every dataset owner holds the manager role on their dataset. The manager role comes with ownership: owners named at intake hold it from standup, and adding an owner replaces any previous dataset role with manager. Removing an owner removes their manager membership and lists that removal on the change list; someone who stays on the team must later be added with another role. Write access always comes from a dataset role and is never domain-wide.
3. **Group names come from configuration.** The naming convention is still open, so the app reads dataset + role → group name from configuration (`src/data/datasets/group-naming.json`): a template, plus per-dataset overrides. Every name, template or override, must identify both its dataset and its role, and no two dataset roles may share a name. The app refuses configuration that breaks either rule.
4. **An EIR per person gates sensitive environments.** The EIR replaces the per-request waiver. It belongs to the person, not to any request. A safeguards validator marks it valid, and access into a sensitive environment is held until it is.
5. **Certification is a tag the dataset owner sets.** `system.certification_status` is `certified` (opens the dataset's gold and silver layers to the domain's consumers), `deprecated` (consumers keep access, and the dataset is labelled), or removed (consumers lose access).
6. **The change list replaces writes to Databricks.** In the MVP the app never calls a Databricks write API to change access. The one exception is document storage: each person's signed EIR PDF is written server-side to a Unity Catalog volume. That stores a file and grants nothing, so every access change, including those that follow from an EIR, still goes on the change list. A pure **grant reconciler** behind the store seam compares what the app's records say should exist with what's already there, and every difference becomes a **change list** entry. Each entry records what to change (group, principal, object, tag), why, and when it was created. EDP staff apply entries by hand and mark them applied, which records who did it and when. An entry that's already listed, pending or applied, is never listed again.
7. **Four lifecycles replace the seven-stage machine:** onboarding request, dataset addition, access request and EIR (see the MVP access model doc). Send-back and SLAs carry over.
8. **Every action records its actor and time.** The actor is the signed-in user's SCIM id, resolved by the adapter (ADR-0004), never passed in by the caller. Refined by ADR-0007: every action is a row in an append-only `_actions` table with the same actor and time columns.

## Consequences

- The data store seam gains repositories for datasets and their owners, dataset roles, and the change list. These are additive, so existing callers don't change, and the Delta adapter stubs them until it implements them.
- The first reconciler cut covers group membership only. Grants, revokes, certification tags, EIR holds and standup steps are added as new entry kinds in later slices, and reading real Databricks groups lets entries clear when Databricks already matches.
- "EDP staff" in the app currently means membership in the configured EDP-admin group (`EDP_ADMIN_GROUP_ID`, surfaced as `isAdmin`). In the MVP that group also holds the Safeguards validator, EDP business office and CCB roles (ADR-0008, 2026-10-18 amendment).
- `lifecycle.ts`, `waiver.ts`, `domain-owners.ts` and the catalog cart's bundles encode the superseded model. They are retired or reworked slice by slice.

## Notes

- **2026-10-04: per-member access levels removed (#119).** #87 let dataset owners set access levels on top of each member's role (read, read/write, job management, folder management, folder reading), with their own change-list entries. They're gone. Each dataset role now grants a fixed set of access, the grants on its role card (`src/data/datasets/role-descriptions.json`), and adding, changing or removing a role lists those grants on the change list. A fixed set per role is simpler, and that granularity isn't needed yet. Which Unity Catalog privileges sit behind each role's set is still open (MVP access model, open question 2).
