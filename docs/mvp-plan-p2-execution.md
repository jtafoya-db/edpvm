# Phase 2 Execution Plan — Milestones, User Stories, Tasks

Companion to `mvp-roadmap-p2.md` (the what/why). This is the how/when: the
ordered backlog we execute against. Status: PLAN (2026-09-28).

## Guiding principles (the anti-spaghetti rules)

1. **One milestone at a time.** A milestone is a shippable slice. We do not start
   a dependent milestone until its predecessor is merged to `main`.
2. **Build on clean `main`.** No towers of stacked unmerged PRs. Each milestone
   branches off current `main`; merge before the next dependent milestone.
3. **Every task is cross-reviewed** by the opposite vendor before merge. polly
   never merges; the human does.
4. **Honesty bar.** Every surface shows real data or is clearly gated. No mock
   data presented as real.
5. **Seam discipline.** New data flows through the existing data seam
   (`src/data/store.ts` + adapters). Screens never reach past the seam.
6. **Definition of Done (applies to every task):** typecheck clean; unit tests
   added and green; `npm run build` + `npm run build:databricks` green; diff
   cross-reviewed clean; no new lint errors vs baseline.

## Milestone overview

| ID | Milestone | Persona | Depends on | Ships |
|----|-----------|---------|------------|-------|
| M0 | Merge Phase-1 tail (#19 gating, #16 deploy) | — | — | clean `main` baseline |
| M1 | Consumer Discovery (read-only) + tag model | Consumer | M0 | browse/search by tag, real seed |
| M2 | Request Platform foundation (enriched model + Delta store) | both | M0 | durable, admin-readable requests |
| M3 | Admin Review Inbox (triage/approve/reject + SLA + integ seam) | Admin | M2 | working review loop |
| M4 | Consumer Request-Access form | Consumer | M2 | consumer end-to-end |
| M5 | Google-Forms-style Intake Editor | Admin | M0 | schema editor rework |

Ordering: M0 -> (M1 ∥ M2) -> M3 -> M4 -> M5. M1 and M2 are independent (read
side vs request side) and may run in parallel once M0 is merged; M3 needs M2;
M4 needs M2; M5 is independent of M1-M4 but sequenced last per priority.

---

## M0 — Merge the Phase-1 tail (human action)

Not a build. Merge #19 (MVP gating) and #16 (deploy-config) so Phase 2 starts on
a clean, honest, deployable `main`. M1 inverts #19's `data-discovery` gate, so
#19 must land first.

**Done when:** #19 and #16 are merged; `main` builds and deploys.

---

## M1 — Consumer Discovery (read-only) + tag model

**Goal:** the Consumer persona can find real datasets by domain and by tag.

### User stories
- As a **data consumer**, I want to browse datasets grouped by business domain so
  I can see what data exists in an area I care about.
- As a **data consumer**, I want to filter/search datasets by tag (domain-level
  and dataset-level) so I can narrow to relevant, trustworthy data.
- As a **data consumer**, I want to open a dataset and see its real metadata
  (classification, certification, owner, UC location, lineage, tags) so I can
  judge fit before requesting access.
- As a **platform admin**, I want discovery to show only real, curated datasets so
  we never present fake data as real.

### Tasks
1. **Tag model.** Add `tags: string[]` to `BusinessDomain` (`src/data/types.ts`);
   keep `DataAsset.tags`. Update the memory seed and legacy bridge.
   *AC:* both domain and dataset carry tags; types + bridge compile; seam returns them.
2. **Tag facet/aggregation in the seam.** Add a tag-listing/aggregation read path
   (e.g. `listTags()` / facet counts) to `store.ts` + memory adapter.
   *AC:* returns distinct tags with counts, sourced from real seed.
3. **Browse + search by tag.** Add a tag facet/filter UI to `browse.jsx` /
   `search.jsx` (domain-tag and dataset-tag filters); keep existing full-text.
   *AC:* filtering by a tag narrows results correctly; tests cover facet logic.
4. **Ungate discovery.** Flip `data-discovery` from `coming-soon` to live in
   `src/features/registry.ts`; restore nav entries in `chrome.jsx`; remove the
   direct-nav gate in `App.jsx` for discovery routes.
   *AC:* browse/domain/dataset/search reachable; onboarding + admin unaffected.
5. **Curated real seed.** Replace/trim the mock catalog to a small set of
   manually-tagged **real** datasets (with honest metadata).
   *AC:* every dataset shown maps to a real, tagged asset; no fake padding.

### Definition of Done
Consumer can browse/search real datasets by domain and tag; discovery ungated;
all DoD gates green; cross-reviewed; merged.

---

## M2 — Request Platform foundation

**Goal:** a submitted request is a durable, admin-readable full package.

### User stories
- As a **data provider**, when I submit the onboarding wizard, I want my full
  request (domain, justification, ROI, sizing, architecture, all answers) captured
  so reviewers have everything they need.
- As a **platform admin**, I want submitted requests to persist (survive reload,
  visible to any admin) so nothing is lost and review is possible.
- As a **platform admin**, I want each request to carry an SLA (due date, aging)
  so I can see what is on time vs breaching.

### Tasks
1. **Enrich the request record.** Extend `AccessRequest` (`src/data/types.ts`) to
   carry the full intake package + requester/tenant + SLA fields (due date,
   created/updated, aging, breach flag). Update `helpers.ts` request assembly to
   populate it (stop flattening everything into `purpose`/`items`).
   *AC:* a submitted wizard request contains domain, justification, ROI, sizing,
   architecture, requester, and SLA fields; parity tests updated.
2. **Delta-backed store.** Implement the request side of the Delta adapter
   (`src/data/adapters/delta.ts`) + app-server write path so `createRequest` /
   `listRequests` persist durably; keep memory adapter for local/dev.
   *AC:* submit persists across reload when the Delta backend is selected; honest
   loading/error states (no silent fallback to memory).
3. **Submit -> readable store wiring.** Ensure `createRequest` produces records
   that the admin inbox (M3) can read (either directly as enriched `AccessRequest`
   or via a linked admin projection). Close the current gap where submissions
   never reach the admin surface.
   *AC:* a freshly submitted request is retrievable via the request read path.
4. **SLA computation.** Derive aging/breach from SLA + timestamps in the seam.
   *AC:* unit tests cover on-time / due-soon / breached.

### Definition of Done
Onboarding submit persists a full, SLA-bearing request to a durable store that a
read path can list; DoD gates green; cross-reviewed; merged.

---

## M3 — Admin Review Inbox

**Goal:** admins run the review loop on real submitted requests.

### User stories
- As a **platform admin**, I want an inbox of submitted requests with status and
  SLA so I can triage what needs attention.
- As a **platform admin**, I want to open a request and see the full package so I
  can make a decision.
- As a **platform admin**, I want to **approve** a request so it can move forward.
- As a **platform admin**, I want to **reject = send back with more questions** so
  the requester can clarify and resubmit (return-for-info, not a hard kill).
- As a **platform admin**, I want to see where ServiceNow/Jira ticketing will plug
  in (a clearly-labeled seam) so the future integration is visible but honest.

### Tasks
1. **Inbox surface.** New admin review inbox (in `admin.jsx` / a new component)
   reading enriched requests from M2; list + filter by status/SLA.
   *AC:* shows real submitted requests with status + SLA; empty state honest.
2. **Request detail + decision.** Detail view of the full package; actions:
   approve, reject-send-back (with a questions/notes field), triage/assign.
   *AC:* actions update request state via the seam; state persists; tested.
3. **Return-for-info loop.** "Send back" sets a distinct state + attaches the
   admin's questions; requester-visible path to resubmit.
   *AC:* state machine covers submitted -> in-review -> approved | sent-back ->
   resubmitted; unit tests for transitions.
4. **ServiceNow + Jira seam.** A FeatureGate `coming-soon` surface on the request
   detail marking where ticketing wires in; no live calls.
   *AC:* seam visible, clearly labeled future, makes no external call.

### Definition of Done
Admin can triage, open, approve, and send-back real requests with SLA visibility;
integration seam present and honest; DoD gates green; cross-reviewed; merged.

---

## M4 — Consumer Request-Access form

**Goal:** the Consumer persona has a real end-to-end (discover -> request).

### User stories
- As a **data consumer**, from a dataset I want a lightweight "Request access" form
  (dataset + purpose + duration) so I can ask for access without the full
  provider-onboarding wizard.
- As a **data consumer**, I want my access request to land in the same admin
  review inbox so it gets triaged like any request.

### Tasks
1. **Lightweight request-access form.** New form (react-uswds controls) launched
   from the dataset detail; fields: dataset (prefilled), purpose, duration,
   optional justification.
   *AC:* validates required fields; assembles a request via the M2 platform.
2. **Feed the platform.** Submit creates an enriched request (kind =
   access-request) via M2's store so it appears in the M3 inbox.
   *AC:* a submitted access request is visible in the admin inbox; tested.

### Definition of Done
Consumer can request access to a real dataset and it appears in the admin inbox;
DoD gates green; cross-reviewed; merged.

---

## M5 — Google-Forms-style Intake Editor

**Goal:** replace the tab editor with a single-page, question-oriented editor.

### User stories
- As a **platform admin**, I want to see the whole intake form as a list of
  questions on one page so I understand its structure at a glance.
- As a **platform admin**, I want to edit a question's type, options, and
  validation inline so I can evolve the form without engineering.
- As a **platform admin**, I want to reorder/add/remove questions.
- As a **platform admin**, I want to export a PR-ready config diff so changes go
  through review (keep the existing diff pattern).

### Tasks
1. **Harden the schema.** Formalize `src/schema/intake.config.json` as a
   versioned, JSON-Schema-validated model with a typed TS interface + round-trip
   tests. Keep the SchemaForm renderer decoupled via the seam.
   *AC:* schema validates; round-trip (parse -> edit -> serialize) is lossless;
   renderer parity preserved.
2. **Forms-style editor UI.** Single-page question list using
   `@trussworks/react-uswds`; per-question editing of type/options/validation;
   reorder/add/remove.
   *AC:* edits mutate the schema model; live preview reflects changes.
3. **Keep diff export.** Preserve the PR-ready unified-diff export against
   `intake.config.json`.
   *AC:* round-trip patch tests pass; exported diff applies cleanly.
4. **USWDS scope.** Editor-only adoption of USWDS now; full-app reskin deferred.

### Definition of Done
Admin edits the intake form as a single-page question editor on a hardened
schema, with working preview + diff export; DoD gates green; cross-reviewed;
merged.

---

## Dependency graph

```
M0 ── M1
   └─ M2 ── M3
        └── M4
M0 ──────── M5
```

## Tracking
Each milestone's tasks become entries in `.polly/registry.json` as they are
dispatched, with implementer/reviewer vendors and PR numbers recorded.
