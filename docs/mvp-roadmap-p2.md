# EDP Vending Machine — Phase 2 MVP Roadmap

> **Primary Phase-2 framing lives in [`phase2-user-journeys.md`](./phase2-user-journeys.md)** 
> (two decomposed user journeys + the shared request/SLA/status platform they
> stand on). This roadmap remains valid for the consumer-discovery workstream,
> which the journey doc sequences *after* the two core journeys.

Status: PLAN (agreed 2026-09-28). Supersedes nothing; extends the Phase-1 build
(onboarding wizard, IntakeSchema, SchemaForm, FeatureGate, admin intake editor,
Databricks App re-home, UC tenant-provisioning notebook).

## Two personas, one tag taxonomy

- **Provider** — "Onboard new data" (the wizard). Already real. Produces datasets
  and assigns their domain/dataset tags.
- **Consumer** — "Discover and request access to data that already exists."
  Today's browse/domain/dataset/search screens, currently gated `coming-soon`.

The tag taxonomy is the bridge: providers tag data -> consumers discover it by
those tags -> consumers request access. Discovery is the *read side* of the tag
model, not new mock scaffolding.

Honesty bar (carried from the MVP gating work): every surface shows only real
data or is clearly gated. No mock data presented as real.

---

## Workstream A — Consumer discovery & access

**Tag model (two levels).**
- Add a `tags: string[]` field to `BusinessDomain` (today it has none).
- Build a tag facet/filter on the existing `DataAsset.tags` (today free-form,
  matched in search full-text but with no facet/filter).
- Domain tags + dataset tags are distinct levels.
- MVP: free-form-ish but curated; a controlled vocabulary can come later.

**Ungate discovery.** Flip `data-discovery` from `coming-soon` to live; browse,
domain, dataset, and search render again — driven off the seam
(`listDomains/getDomain/listDatasets/getDataset`).

**Real data only.** Seed a small set of *manually-tagged real datasets* so
discovery shows only real things. No fake catalog padding.

**Request access (lightweight).** A new, lightweight request-access form
(dataset + purpose + duration). Distinct from the provider onboarding wizard.
Produces a request that flows into the Workstream-B request platform.

---

## Workstream B — Request platform & admin review inbox

The meaningful build. Today `submitRequest` writes to an in-process array
(session-only; a reload loses it), and the admin pipeline tracker reads a static
seed — so submitted requests never reach an admin. This workstream fixes that.

**Enriched request record.** A submitted request is the *full package*:
domain, requester/tenant, business justification, ROI, sizing, architecture,
and the complete intake answers — not the flattened `purpose`/`items` that
`AccessRequest` carries today.

**Delta backend store.** Persist requests durably through the data seam's Delta
adapter + the Databricks App server (survives reload; visible across admins).
This is the first real write path.

**SLAs.** Requests/stages carry SLAs — due dates, aging, and breach indicators —
as first-class fields, surfaced in the admin inbox.

**Integration seam (ServiceNow + Jira).** A stubbed surface now (FeatureGate
`coming-soon`), designed as the seam where ServiceNow/Jira ticketing wires in
later. No live integration in MVP.

**Admin review inbox.** Actions: view, triage, approve, reject — where **reject =
"send back with more questions"** (a return-for-info state, not a hard kill).
Reads the enriched requests from the store. Approval hand-off to the
UC tenant-provisioning notebook is a documented seam for a later phase.

---

## Workstream C — Google-Forms-style intake editor

Replace the current tab-based option-list/coefficient editor with a
single-page, question-oriented editor: see every question, edit its type /
options / validation, reorder, add/remove. Keep the PR-ready config-diff export.

**Controls: `@trussworks/react-uswds`** (accessible USWDS React components).
USWDS is the standard direction for the product; the editor is where we start
applying it.

**Build on our own schema (`src/schema/intake.config.json`), hardened.**
Rather than migrating to a third-party form schema (Formily/Designable is the
only fully-MIT builder; SurveyJS Creator and FormEngine Designer are
commercial), we keep our schema and the SchemaForm renderer + parity tests we
already shipped. To address maintainability as the schema grows:
- Formalize `intake.config.json` as a **versioned, JSON-Schema-validated** model
  with a typed TS interface and round-trip tests.
- Keep the **renderer and editor decoupled via the existing seam**, so new field
  types are added by extending the schema + renderer, not rewriting screens.
- The seam is the escape hatch: if we ever truly outgrow the bespoke schema, we
  can swap the engine without touching consumer screens — no risky migration now.

---

## Sequencing

1. **Workstream A** and **Workstream B** first (A = consumer discovery/read + tag
   model + lightweight request-access; B = request platform + admin inbox).
2. **Workstream C** (Google-Forms-style editor) after.

Each workstream ships in its own worktree + PR, cross-reviewed by the opposite
vendor. polly never merges; the human does.

## Deferred / later phases
- Controlled tag vocabulary + normalization; domain-tag governance.
- Live ServiceNow + Jira integration (seam built in B).
- Approval -> UC tenant-provisioning notebook hand-off (seam noted in B).
- Full-app USWDS reskin (editor-first in C).
- Durable Delta adapter for the discovery catalog (memory seed -> real UC tags).
