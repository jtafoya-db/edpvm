# ADR 0002 — Domain-owner routing (how a request reaches the right owner)

- **Status:** Superseded by [ADR-0005](0005-domain-access-model.md). Previously: Accepted (model); implementation lands in the P3 / employee-journey slices
- **Deciders:** product owner + polly
- **Related:** ADR-0001 (stage 2 = domain-review), `types.ts` (`BusinessDomain`), `canonical-request.ts`

## Context

Stage 2 (`domain-review`) needs to route each request to the **accountable reviewer
for its domain** — a third actor, not EDP staff. But today:

- `BusinessDomain.owner` is a **council name** ("Individual Returns Data Council") and
  `steward` is a **person's display name** ("Marcus Liu"). Neither is a routable auth
  principal.
- P1 fixed the prerequisite bug: the canonical record now persists `domainId` (the
  request used to drop it), so a request *can* now be tied back to its domain.

We need a routable identity for "the owner(s) of domain X," and a way to show a
domain owner only their domain's pending requests.

## Decision

Model the domain owner as a **routable owner-group per domain**, distinct from the
existing display fields.

1. **Owner identity = a group, not a person.** Add `ownerGroup` to the domain model
   (e.g. `domain-owners-individual-filing`). This is durable (survives people leaving)
   and matches the group-ownership model already used by the UC-tenant-provisioning
   notebook. `owner` (council) and `steward` (person) remain **display-only**.

2. **Routing table = a domain → owner-group mapping behind the data seam.** Expose
   accessors like `getDomainOwnerGroup(domainId)` and `isDomainOwner(user, domainId)`.
   For MVP the mapping + group membership are **seeded config** (a small list of
   member identities per group); a later adapter reads **real UC / account groups**
   (reuse the account-group concept from the provisioning notebook) — same seam swap
   pattern as everything else. No UI or store code depends on where the mapping lives.

3. **Role-scoped inbox.** At `domain-review`, the queue for a user shows requests whose
   `domainId` maps to an owner-group the user belongs to. The same mechanism
   generalizes to the other review stages, each with its own EDP role-group:
   `edp-roi-review` → business-office group, `ccb` → CCB group,
   `live-data-waiver` → safeguards-validator group.

4. **Fail loud on unrouted requests.** If a request's `domainId` has **no mapped
   owner-group**, it must surface in an EDP fallback/exception queue with a clear
   "unrouted — assign an owner-group for domain X" message. It must **never silently
   disappear** (that is exactly the class of bug P1 fixed).

## Consequences

- **+** Requests route deterministically by `domainId`; role-scoped inboxes are a
  simple group-membership check.
- **+** Steward/council stay human-readable for display and contact.
- **+** MVP works on seeded groups; production swaps to real account groups with no UI change.
- **−** Requires a domain → owner-group seed and a membership source (config now).
- **−** Introduces a governance chore: every domain must have an owner-group, enforced
  by the fail-loud unrouted queue.

## Open follow-ups (not blocking the model)
- Where does group membership come from in production — the same account groups the
  provisioning notebook manages? (Likely yes; confirm at wiring time.)
- Should EDP admins be able to reassign a request's domain/owner-group from the inbox?
