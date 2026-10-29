# ADR-0006 — Email-matched dataset owners

- **Status:** Accepted. Amends ADR-0004 decision 2 for dataset owners only; reconciled by ADR-0007 decision 4.
- **Related:** ADR-0004 (identity), ADR-0005 (domain access model), [`GLOSSARY.md`](../../GLOSSARY.md), `src/data/datasets/ownership.ts`

## Context

ADR-0004 decision 2 keys every record by the account SCIM principal id and says email alone is not the key. But **dataset owners** and dataset-role members are added by name and email (#84, #103), because the app can't search Databricks users. A **dataset owner** added in the app therefore has an email and no SCIM id, yet has to be able to act alone (ADR-0005).

## Decision

1. **An owner added in the app is recorded by name and email.** The email is trimmed and lower-cased.
2. **Until the email is bound, that owner is recognised by the session email.** The session email is the one the server resolves from SCIM for the signed-in user. An email a caller supplies is never used to decide who is acting.
3. **An owner's first ownership-protected action binds their session email.** When a session takes an action the store checks ownership for (adding, editing or removing members, changing roles, or adding or removing owners) and matches an owner, whether by SCIM id or by email, the store inserts the session email and SCIM id into the add-only `teams.email_bindings` table, if that email isn't bound yet, and records the time. Owner rows may cache that principal ID for reads, but the binding table is the source of truth. Viewing a page doesn't bind; screens only use the email match to decide what to show. From then on, owner rights for that email follow the bound SCIM id.
4. **A binding is never reset.** It belongs to the email, on every dataset, not to the owner record. Removing the owner doesn't delete it, and re-adding the same email, by an owner or by EDP staff reassigning ownership, reuses it, so only the bound SCIM id can act. The app has no way to rebind an email; a recycled email needs a deliberate EDP-staff rebind, which is out of scope.
5. **A mismatch is refused.** A session whose email is bound to a different SCIM id is refused, EDP staff included, wherever that email bears on the dataset: an owner record has the email, the person it's bound to owns the dataset, or the session matches an owner some other way. The refusal is recorded as an `access-refused` action on `teams.dataset_owner_actions`, so it appears in the `audit.actions` view for EDP staff. Like every action (ADR-0007 decision 5), it moves the owner row's `version` and `last_action_id` on, so the record's history stays in order even after repeated refusals. Nothing else about the owner changes.
6. **One person, one owner record per dataset.** Adding an owner by email is refused when that email, or the SCIM id it's bound to, already owns the dataset. A person put on record twice before their email was bound (once by SCIM id, once by email) is still one person: they count once toward the rule that a dataset keeps an owner, and removing them removes every record and its Maintainer role.
7. **Actions are always attributed to the SCIM id.** Email only decides whether someone is an owner, never whose action it was.

Owners named at intake or by deployment configuration are keyed by SCIM id as before. A member's dataset role, even Maintainer, never makes someone an owner.

## Consequences

- Email aliases and changed emails won't match an owner who hasn't signed in yet. Once bound, a changed email doesn't matter.
- The main risk is a recycled email reaching an owner whose email isn't bound yet. Binding on any owner's first protected action, never resetting the binding, and refusing a mismatch limit that window to the time before the real owner first acts.
- A person whose SCIM id changes, or a recycled email that's already bound, is locked out until a rebind exists. That's a deliberate EDP-staff action, and it isn't built.
- #103's matching of emails to Databricks users by EDP staff can bind owners earlier, before they sign in.
- This ADR is superseded once every dataset owner is bound to a SCIM id.

## Terminology amendment (#260)

_The human's decision (2026-10-18, #141)._ The dataset role this ADR first called `manager` is called **Maintainer** wherever people read it: everything a developer has, plus running the dataset's jobs and managing permissions on what the dataset publishes in prod. Only dataset owners, with EDP staff, decide who is on a dataset's team; a Maintainer who isn't an owner can't add or remove people. The stored value is still `manager` (`DatasetRoleName`, `teams.dataset_members.role`, action payloads, group-name suffixes), so no data or group was renamed. This ADR's prose now says Maintainer; where it quotes a stored value, it still says `manager`.
