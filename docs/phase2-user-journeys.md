# EDP Vending Machine — Phase 2 User-Journey Decomposition

Status: PLAN (drafted 2026-09-28; key decisions locked 2026-09-29 — see §9).
This is the **authoritative Phase-2 framing**
and reorganizes `mvp-roadmap-p2.md` / `mvp-plan-p2-execution.md` from broad
milestones into two decomposed **user journeys** plus the shared platform they
both stand on. Grounded in a read-only audit of `main` @ `fae4538`.

---

## 1. The two personas, and the tension between them

The product exists to mediate a genuine conflict between two people:

- **The Tenant**, here as a **data provider** onboarding a new dataset (see
  `GLOSSARY.md`; a tenant can also be a data consumer). Wants to onboard
  **fast** and, above all, wants **visibility** — "I submitted; where is it,
  who has it, and when can I chase someone?" Their anxiety is *uncertainty*.

- **The EDP Employee** (internal staff supporting onboarding). Faces an
  **influx** of requests and must **triage, decide, and lean on automation**.
  Their pain is *volume and prioritization* — "which of these 40 do I do next,
  and can the system do the boring ones for me?"

These pull against each other: the tenant wants speed and constant status; the
employee is swamped and needs to batch, prioritize, and defer. **The product's
job is to hold that tension fairly** — and the instrument that does it is a
single shared artifact: the **SLA clock**.

### The SLA clock is the spine

One number, two lenses:

| | The Tenant sees… | The Employee sees… |
|---|---|---|
| **SLA target** | a *promise* ("actioned within 3 business days") | a *commitment they configure* |
| **Time remaining** | "expected by Thu; escalate after that" | "goes red in 4h — do it next" |
| **Breach** | the *escalation button* lights up (email/Teams) | an *accountability* signal on their queue |

If we model the request lifecycle and the SLA clock **once, correctly**, both
journeys largely fall out of it. That is the anti-spaghetti thesis of Phase 2:
**build the shared request/SLA/status platform first, then the two journey UIs
on top of it.** We do *not* build "tenant features" and "admin features" as
separate stacks that later have to be reconciled — they read and write one
canonical record.

---

## 2. Current state (why the platform must come first)

The audit found the tenant and employee sides are **two disconnected data
models today**, and the visibility/SLA experience is prototyped but hollow:

1. **Four overlapping, inconsistent status vocabularies:**
   - Tenant top-level `In progress / Action needed / Completed` (`requests.jsx:180`)
   - Subrequest enum `done / active / pending / blocked` (`types.ts:141`)
   - Global `STAGES` (6): Submitted → Domain owner review → EDP access review →
     BEARS → Databricks provisioning → Access active (`appData.js:401`)
   - Admin pipeline states (7): `intake/review/ccb/provisioning/live/blocked/returned`
     (`appData.js:502`)

2. **The tenant record and the admin record are unlinked shapes.**
   `AccessRequest` (`types.ts:164`) and `PipelineEntry` (`types.ts:186`) are
   separate. `PipelineEntry` carries the fields an employee needs — `owner`,
   `ageDays`, `nextAction`, `jira`, `decisions` — but those **never attach to a
   real tenant submission.**

3. **Submissions never reach the employee.** `submitRequest` writes an
   `AccessRequest` into an in-memory array (`memory.ts:46`); `listPipeline()`
   always returns a fresh clone of the **seeded** 7 rows (`memory.ts:54`). A
   tenant sees their session-local request; **no employee queue ever shows it.**

4. **The "pizza tracker" is fake.** The post-submit `StatusScreen` embeds
   `RequestStatusPanel`, a 4-stage tracker literally labeled
   **"LIVE STATUS · STUB JIRA DATA"** that always shows the same mock request
   `REQ-2026-0142` regardless of input (`CapabilityPreviews.tsx:126`,
   `mock/index.ts:30`). The real stepper beside it is reconstructed from seed,
   and its progress bar is `stageIndex / (stages-1)` — not real work
   (`requests.jsx:215`).

5. **No decision affordances.** "Record decision" only flashes a toast
   (`admin.jsx:737`); "Open in Jira" is a hardcoded link; assignment is a
   read-only string. The store exposes only create + read — **no update,
   transition, assign, or comment APIs** (`store.ts:42`).

6. **No SLA anywhere.** Only cosmetic bundle strings ("3–5 business days") and a
   hardcoded 14-day age-goes-red (`admin.jsx:707`). No due-date, elapsed time,
   breach state, escalation, or notification exists.

7. **Persistence is unimplemented.** Default backend is `memory` (lost on
   reload); the `delta` adapter throws on every operation (`delta.ts`).

8. **Automation is unwired.** The real UC-tenant-provisioning notebook
   (`notebooks/provisioning/`) has **zero** app hand-off — no payload, job
   trigger, run id, or status polling. Jira/ServiceNow are stubs/absent.

**Conclusion:** the two journeys cannot be "nailed" as UI work alone. They share
a foundation that does not exist yet. Build the foundation, then the journeys.

---

## 3. Journey A — The Tenant (onboarding + visibility)

> *"I submitted my request. Where is it, who has it, and when am I allowed to
> chase someone?"*

Step-by-step. Each step notes the **tension**, the **current state**, and the
**target**.

### A1 — Submit the onboarding package
- **Current:** wizard assembles a real `AccessRequest` and navigates to
  `#status/{id}` (`onboarding.jsx:42`). It lands in memory only.
- **Target:** submission persists to the shared store (Delta) as a canonical
  request with a lifecycle state, timestamped `submitted` event, and an SLA
  clock started.
- **Tension:** tenant wants instant confirmation it "counts"; employee needs it
  to arrive structured and complete.

### A2 — Confirmation → tracker handoff (not a dead end)
- **Current:** confirmation is honest but terminal ("assembled locally").
- **Target:** "Request `REQ-…` received. Track it here →" leads straight into
  the tracker. The clock and the promised SLA are visible immediately.

### A3 — The pizza tracker (the heart of the tenant experience)
- **Current:** the fake `RequestStatusPanel` + a seed-driven stepper.
- **Target:** a **real** stage tracker for *this* request showing, per stage:
  **what's happening**, **who owns it** (the assigned employee/team), and the
  **SLA state** (on-track / due-soon / breached) with a human date
  ("EDP review — expected by Thu Oct 2").
- **Tension:** this is precisely where tenant visibility meets employee
  workload — the tracker exposes the employee's SLA state to the tenant.

### A4 — SLA visibility + escalation-readiness
- **Current:** nothing.
- **Target:** each active stage shows "expected by `<date>`." Once the SLA is
  breached, the tracker surfaces an **"escalation now appropriate"** indicator
  naming the stage owner/team to contact. This answers "how long do I wait
  before I ping someone?" — **the app tells you *when*, but does not perform the
  escalation.** The actual channel (email/Teams) is **out of MVP scope**; the
  tenant reaches out themselves. (A live deep-link/send is a later enhancement.)

### A5 — Back-and-forth (Action needed)
- **Current:** `Action needed` status exists as a label only.
- **Target:** when an employee **sends a request back**, the tenant sees the
  specific questions and can respond **without re-submitting the whole package**;
  responding returns the request to the employee's queue and re-arms the clock.

### A6 — Completion
- **Current:** static "activated resources" links on complete.
- **Target:** honest completion tied to the real provisioning outcome (or a
  clearly-labeled "provisioning hand-off pending" until automation is wired).

**Tenant user stories (A):**
- As a tenant, when I submit, I get a durable request I can return to later
  (survives reload / different device).
- As a tenant, I can see every stage of my request, who owns it, and whether
  it's on time.
- As a tenant, I can see the *date* by which each stage should be done.
- As a tenant, once an SLA is breached, I see a clear "you may now escalate"
  indicator naming who to contact (I reach out via my own email/Teams — the app
  does not send it in MVP).
- As a tenant asked for more info, I can answer inline and see my request move
  back into review.

---

## 4. Journey B — The EDP Employee (support + decisions + automation)

> *"I have a queue of 40. Help me decide fast and let the system do the boring
> parts."*

### B1 — The request inbox / queue
- **Current:** the Pipeline Tracker reads 7 hardcoded seed rows
  (`admin.jsx:650`); real submissions never appear.
- **Target:** a real inbox of *actual* submitted requests, **sorted by SLA
  urgency** (breached and due-soon first), with filters (state, domain, tenant,
  owner) and the KPIs computed from real data.
- **Tension:** the sort order *is* the negotiated fairness between tenants —
  whoever's clock is reddest gets done next.

### B2 — Open a request (the full package)
- **Current:** seed detail (requester, sensitivity, architecture, cost/ROI, next
  action) on mock rows (`admin.jsx:717`).
- **Target:** the same rich detail rendered from the **real** submitted package —
  domain, requester/tenant, business justification, ROI, sizing, architecture —
  everything the wizard collected, in one review view.

### B3 — Triage
- **Target:** assign an owner (real mutation, not a static string), set/adjust
  priority, filter and batch. Assignment is visible to the tenant as "who has
  it" in A3.

### B4 — Decide (the three-way)
- **Current:** "Record decision" is a toast (`admin.jsx:737`); no store API.
- **Target:** **Approve / Reject / Send-back** as real
  lifecycle transitions that mutate the canonical record, append a timestamped
  decision + note, advance/return the stage, and re-arm or stop the SLA clock.
  - *Send-back* is the loop that feeds Journey A5.

### B5 — Lean on automation (seams now, wiring later)
- **Current:** provisioning notebook exists but is unwired; Jira/ServiceNow are
  stubs.
- **Target for MVP:** on approval, present the **hand-off surface** — a
  clearly-labeled seam that will (later) trigger the UC-provisioning notebook /
  create the Jira/ServiceNow ticket. MVP records the intent + shows the seam;
  the live trigger is a **documented next phase**, not faked as done.

### B6 — SLA configuration + accountability
- **Current:** hardcoded 14-day red only.
- **Target:** employees **configure** the per-stage SLA targets (the numbers
  tenants see in A4), and see queue aging / breach counts. Configurable + visible
  is the whole point.

**Employee user stories (B):**
- As an EDP employee, I see every submitted request in one queue, newest and
  most-overdue surfaced first.
- As an employee, I can open a request and see the complete intake package.
- As an employee, I can assign a request to an owner.
- As an employee, I can approve, reject, or send back, and that
  decision is recorded and moves the request.
- As an employee, when I approve, I get a hand-off toward provisioning/ticketing
  (seam now, automated later).
- As an EDP admin, I can configure the SLA targets per stage, and those targets
  are what tenants see.

---

## 5. The shared platform (build this first)

Everything above depends on one foundation. This is the first thing to build,
and it is mostly non-UI:

**P-1. Unified request lifecycle + canonical record.**
- Collapse the four vocabularies into ONE 7-stage lifecycle state machine
  (Submitted → Domain owner review → EDP business & ROI review → EDP intake CCB →
  **Live-data waiver validated** → BEARS + Databricks provisioning → Access
  active) with allowed transitions. The live-data-waiver stage is a gate before
  provisioning and may be conditional (N/A for test-data-only requests).
- One canonical request shape that carries both tenant-facing and employee-facing
  fields (merge/relate `AccessRequest` + `PipelineEntry`): requester/tenant, the
  full intake package, stage, owner, decisions[], timestamped events[].

**P-2. SLA model.**
- Per-stage configurable target in **business days**, computed with a **built-in
  business-calendar** (skips weekends + a static holiday list) — **no external
  calendar integration.**
- Computed at read time: `dueAt`, `timeRemaining`, `state ∈ {on-track,
  due-soon, breached}`, `escalationAvailableAt`.
- Escalation **contact metadata** (owner/team to name in the indicator).
  Performing the escalation (email/Teams send) is **out of MVP scope** — the app
  only surfaces the "escalation appropriate" indicator.

**P-3. Store APIs.**
- Add `updateRequest`, `transition(state, decision, note)`, `assign(owner)`,
  `comment` to the `DataStore` seam (`store.ts`), on top of existing create/read.
- One queue read that returns real submissions (replaces the seed-only
  `listPipeline`).

**P-4. Durable persistence (Delta).**
- Implement the `delta` adapter enough to persist requests + events + SLA config,
  so a submission survives reload and is visible to a *different* employee. This
  is the "make it real" step — the first real write path, running on the
  Databricks App server we already have.

**Platform stories:**
- As the system, a submitted request is one canonical record both journeys read.
- As the system, request state changes only through defined transitions, each
  timestamped.
- As the system, SLA state is computed from config + timestamps, not hardcoded.

---

## 6. Dependency-ordered decomposition (journey-first)

Not broad milestones — discrete, cross-reviewed slices, each shippable on clean
`main`. Ordered by dependency.

```
PLATFORM (P) ── must land first, mostly non-UI
   P-1 unified lifecycle + canonical record (types + state machine + tests)
   P-2 SLA model (config + computed clock, business calendar)
   P-3 store APIs (update/transition/assign/comment + real queue read)
   P-4 Delta persistence (durable, survives reload, cross-user visible)

JOURNEY A (tenant)            JOURNEY B (employee)
   A-1 submit → persist (P4)     B-1 real inbox/queue (P3, SLA sort)
   A-2 confirm → tracker         B-2 full-package review view
   A-3 real pizza tracker (P1)   B-3 triage/assign (P3)
   A-4 SLA + escalation (P2)     B-4 decide 3-way transitions (P1/P3)
   A-5 action-needed loop  <───> B-4 send-back (shared loop)
   A-6 honest completion         B-5 automation hand-off seam
                                 B-6 SLA config UI (P2)
```

- **P-1 … P-4** are the foundation and gate almost everything; do them in order,
  each its own PR + cross-review.
- Once P is in, **Journey A and Journey B proceed in parallel** (they read/write
  the same record but touch different screens), except the **A5 ↔ B4
  send-back loop**, which is one shared slice.
- Each slice keeps the **honesty bar**: real data or clearly-gated; no faked
  "done."

---

## 7. Explicitly deferred (NOT in the two core journeys)

- **Google-Forms-style intake editor.** Confirmed **out of the critical path.**
  We keep the existing config-based intake editor (the real admin tab) as-is;
  the Forms-style drag/drop rebuild (trussworks/USWDS) is a later enhancement,
  not a Phase-2 journey dependency.
- **Consumer discovery/access** (browse/domain/dataset/search + request-access +
  two-level tag model) from `mvp-roadmap-p2.md`. Still valuable, but it is a
  *third* persona journey (data consumer) and secondary to nailing the
  onboarding↔support loop. Sequence it after the two core journeys unless
  priorities change.
- **Live automation triggers** (actual provisioning-notebook run, real Jira /
  ServiceNow ticket creation). MVP ships the *seam and recorded intent*; the live
  trigger is the phase after.

---

## 8. Anti-spaghetti discipline (how we execute)

1. **Platform before journeys.** No tenant/employee UI slice starts before the
   shared record + SLA + store APIs it needs are merged.
2. **One slice at a time on clean `main`.** No towers of stacked unmerged PRs.
3. **Every slice cross-reviewed** by the opposite vendor before merge.
4. **Definition of Done per slice:** typecheck + tests + both builds green +
   cross-reviewed clean + honesty bar held.
5. **The canonical record is sacred** — new fields extend it; we do not
   re-introduce a second parallel shape.

---

## 9. Decisions (locked 2026-09-29)

1. **Canonical lifecycle — 7 stages** (retiring the other three vocabularies):
   1. Access request submitted
   2. Domain owner review
   3. EDP business & ROI review
   4. EDP intake CCB
   5. **Live-data waiver validated** *(gate: confirms approval to use
      live/production data before real access is provisioned; may be
      conditional / N-A for test-data-only requests)*
   6. BEARS entitlements + Databricks provisioning
   7. Access active
2. **SLA units — business days**, computed with a built-in business-calendar
   (weekends + static holiday list); **no external calendar integration.**
3. **Escalation — indicator only.** The app surfaces SLA state and an
   "escalation now appropriate" indicator naming who to contact; the escalation
   **channel (email/Teams) is out of MVP scope.**
4. **Persistence (P-4) — OPEN.** Delta for requests + events + SLA config;
   still to confirm: example-workspace via the app server's write path now, vs a
   local-durable fallback first to de-risk. *(Recommendation: local-durable
   fallback first so the journeys are demoable without standing up the write
   path, then swap to Delta.)*
5. **Consumer discovery — deferred**, sequenced after the two core journeys.
   Confirmed.
