# EDP Vending Machine — Phase 1 Build Plan

**Purpose:** the technical/design plan for making P1 real — how we stub-and-evolve, how the intake form becomes editable, and how the LLM challenger works. Review this architecture before code.
**Companions:** [implementation-plan.md](implementation-plan.md) (the LOE/phasing) · [onepager-copy.md](onepager-copy.md) / [slide-distilled.md](slide-distilled.md) (the IRS executive sponsor pitch).
**Source app:** `~/Downloads/EDP Front Door.zip` — TanStack Start + React + shadcn/ui + USWDS. The real screens live in `src/legacy/*.jsx`; the onboarding wizard is `src/legacy/onboarding.jsx`.

---

## 0. The one idea everything hangs on: a single **intake schema**

Today the wizard hardcodes everything in `onboarding.jsx` — steps, fields, `INGEST_PATTERNS`, `ACCESS_PATTERNS`, `ENG_MODELS`, `ROI_LEVERS`, the sizing coefficients (`FREQ_FACTOR`/`CPLX_FACTOR`), the validation gates (`canNext`), and request assembly (`launch`).

**We extract all of it into one declarative `IntakeSchema`.** Three consumers read from it:

```
                    ┌───────────────────────┐
                    │     IntakeSchema       │  ← the contract
                    │  steps · fields ·      │
                    │  option-lists · rules ·│
                    │  sizing coeffs         │
                    └───────────┬───────────┘
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   Form renderer          Admin editor          LLM challenger
   (tenant fills)     (EDP edits the flow)   (per-section grill,
                                              writes suggestions
                                              back into fields)
```

This is the deep-module seam: get the schema right and the form, the editor, and the LLM are all downstream of it. Nothing hardcoded in the component anymore.

---

## 1. Stub-and-evolve: capability registry + greying *(Q18 → A)*

Goal: **one app** where every capability advertises its status, so the app itself is the living progress board — you watch it evolve as flags flip.

**`FEATURES` registry** — one entry per capability with `status: "live" | "stub" | "planned"`:

| Capability | P1 status | Notes |
|---|---|---|
| Governed catalog (1 domain) | live | seeded, real tags |
| Data onboarding wizard | live | schema-driven |
| LLM challenger | **stub** | per-section (see §3); shown grayed in P1, mock content |
| Request submit → JIRA create | stub → live | live when JIRA path lands (OQ-6) |
| Request status tracking | live (stub data) | UI live, JIRA-fed data stubbed until path lands |
| EDP admin — pipeline/roll-up | live (stub data) | prototype tabs exist |
| EDP admin — **form editor** | live (repo-backed) | edits the IntakeSchema; saves to in-app state + emits a PR-ready config diff, no runtime write yet (see §2) |
| Cross-system access view | planned | P2 |
| Automated provisioning | planned | P3 |

**`<FeatureGate>`** wrapper renders one of three ways:
- `live` → the real component.
- `stub` → the **real intended UI, grayed + inert**, with a "Not yet implemented" ribbon, populated by **baked-in mock data** so stakeholders see what's coming (your call: show the real UI grayed, not an empty placeholder).
- `planned` → a compact "coming in Phase N" card.

Mock data lives in one `mock/` module so stub screens look real without a backend. Flipping `stub → live` is the unit of visible progress.

---

## 2. Editable intake form: renderer + EDP admin editor *(Q19 → A+B)*

**Renderer.** A generic `<SchemaForm schema={IntakeSchema}>` replaces the hand-written JSX steps. Field types cover what the wizard uses today: `text`, `textarea`, `select`, `number`, `card-select` (the PatternCards), `multi-card` (ROI levers), plus per-step validation rules and the sizing block. The architecture diagram + sizing estimator are step "widgets" the schema references by id.

**Admin editor (in scope for P1, per your call).** An EDP-only admin screen to add/reorder/edit steps, fields, and option-lists (ingest/access patterns, ENG models, ROI levers, source systems) and tune sizing coefficients — **without editing code**. Start with the highest-churn surface (option-lists + field labels/required flags), then step/field structure. Full drag-drop form-builder polish can itself be a `stub` if we need to timebox.

**Where the schema lives (DECIDED — OQ-7):** **repo file, behind a `loadSchema()` seam.**
- The schema is a checked-in config file (`app/src/schema/intake.config.json`). The renderer reads it through a small `loadSchema()` function — the renderer only knows "give me the schema," never where it comes from.
- P1 admin editor is **live but repo-backed** (OQ-7 sibling decision): EDP edits the flow in the admin UI; on save it updates the in-app schema state **and emits a PR-ready config diff** ("here's your change — submit it for deploy"). Real, usable editor; no silent prod write.
- **Later upgrade (P2+):** swap `loadSchema()` to read a runtime **Delta/UC store**, and let the admin editor write there directly → true no-deploy EDP editing. Because everything reads through the seam, this is a one-function change, not a rewrite. This is why the seam exists.

---

## 3. LLM challenger: per-section grill + suggestion-insertion *(Q20 → C, per-section)*

> **P1 status: grayed STUB (OQ-8).** In P1 the challenger is shown as a grayed, inert "coming soon" panel after each section — real intended UI, mock suggestions — so stakeholders see the vision without the FMAPI wiring. The skill below is **designed** in P1 (standalone artifact) and **wired live in a later phase**. The behavior spec is what the stub previews and what the eventual live version implements.

**Behavior.** After the user completes **each wizard section**, before advancing, the LLM:
1. **Challenges** — surfaces what they didn't consider ("you picked FTI but the justification doesn't mention Pub 1075 safeguards"; "$750K benefit — from which lever, against what baseline?").
2. **Expands** — pushes for a more concrete MVP scope and defensible business justification.
3. **Offers insertable suggestions** — proposed field values / added prose the user can **accept into the form** with one click (never auto-applied; human confirms).

**Contract.** The challenger's only output is **structured suggestions targeting IntakeSchema fields**, each with a rationale and citing what the user already said. It never invents facts and never bypasses the form — the human always confirms before it lands.

**It's a new skill we build:** an IRS-process-aware grilling skill (same family as the `grilling` skill used to produce these docs), baked with the context EDP review actually scores:
- Approved architecture patterns (EFTU / Informatica / EPZ; off-pattern → consultation).
- FTI / SBU sensitivity → Pub 1075 safeguards path.
- The six ROI levers and how EDP scores business value.
- What a concrete MVP vs. a vague ask looks like for an EDP intake.

**Model:** Sonnet 4.5 (the only GA proprietary FMAPI model in GovCloud — see [[reference_govcloud_ai_model_availability]]). Served via FMAPI/Model Serving from the Databricks App backend.

**Skill artifact (to build):** `edp-intake-challenger` — per-section system prompts + the IRS context pack + the suggestion I/O schema. Design it standalone first, then wire into the wizard.

---

## 4. Build order (P1)

1. **Extract `IntakeSchema`** from `onboarding.jsx` — the foundational refactor; everything depends on it.
2. **`<SchemaForm>` renderer** — reproduce the current wizard from the schema (behavior parity first, no new features).
3. **Capability registry + `<FeatureGate>` + mock module** — stand up the greying framework; wire the P1 status map.
4. **Re-home to a Databricks App** — Delta-backed state, TanStack Query cache (Lakebase deferred — not in GovCloud).
5. **EDP admin editor (live, repo-backed)** — option-lists + field props first; save → in-app state + PR-ready config diff.
6. **`edp-intake-challenger` skill — design standalone** (system prompts + IRS context pack + suggestion I/O schema). Do NOT wire live in P1; it backs the grayed stub and the later live version.
7. **Grayed stubs** for the LLM challenger (per-section, mock suggestions), JIRA-create, status (live UI / stub data), cross-system access (planned), provisioning (planned).

---

## 5. Open questions carried in / added

- **OQ-1 / OQ-2 / OQ-6** — from [implementation-plan.md](implementation-plan.md) (BEARS-as-record; tag granularity; DBX→JIRA egress). Unchanged.
- **OQ-7 (DECIDED):** schema store = **repo file behind a `loadSchema()` seam**; admin editor live but repo-backed in P1; runtime Delta/UC store is the P2+ swap. (See §2.)
- **OQ-8 (DECIDED):** LLM challenger ships as a **P1 grayed stub**; skill designed in P1, wired live later. (See §3.)
