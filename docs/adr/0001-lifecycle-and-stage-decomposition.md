# ADR 0001 — Seven-stage request lifecycle & per-stage decomposition

- **Status:** Superseded by [ADR-0005](0005-domain-access-model.md). Previously: Accepted (lifecycle state machine shipped in P1, `main@547967a`)
- **Deciders:** product owner + polly
- **Related:** ADR-0002 (domain-owner routing), ADR-0003 (live-data waiver), `src/data/lifecycle.ts`

## Context

Before P1 the app had **four overlapping, inconsistent status vocabularies** (tenant
top-level, subrequest timeline, a 6-stage global `STAGES`, and a 7-state admin
pipeline), and the tenant's request and the admin's pipeline were **two disconnected
data models** — a submitted request never reached the admin view. The mock admin
"Onboarding flow" viz already encoded the team's intended process as a 23-node map
with an actor and a mode (tenant-manual / EDP-review / automated) per node. We
formalize that into a single lifecycle.

## Decision

One canonical lifecycle, seven stages, implemented as a pure state machine in
`lifecycle.ts` (`LIFECYCLE_STAGES`, `FORWARD_TRANSITIONS`, `validateTransition`).
Stage **keys are the contract** — every other layer references these, not labels.

```
submitted → domain-review → edp-roi-review → ccb → [live-data-waiver] → provisioning → active
                                                └── (skips waiver when not live-data) ──┘
```
Terminal stages: `active`, `rejected`, `withdrawn`. Transitions: `forward`,
`approve`, `send-back` (to an earlier stage), `reject`, `withdraw`. The
`live-data-waiver` stage is **conditional**: `validateTransition` forbids
`ccb → provisioning` when `livesOnLiveData` is true, forcing the waiver gate; a
test-data-only request goes `ccb → provisioning` directly.

### Per-stage decomposition (the "meaningful content" per step)

| # | Stage key | Actor / role | Entry criterion | What happens (the decision) | Exit | Mode | Tenant sees | SLA (business days, default) |
|---|---|---|---|---|---|---|---|---|
| 1 | `submitted` | Tenant + system | Intake package assembled | Persist canonical record; SLA clock starts | → `domain-review` | tenant/auto | "Received — tracking started" | 0 |
| 2 | `domain-review` | **Domain owner group** (per ADR-0002) | Routed by `domainId` | Confirm need-to-know & domain fit | approve → `edp-roi-review`; else `send-back` | review | "With <domain> owner" | 3 |
| 3 | `edp-roi-review` | **EDP business office** | Domain-approved | Assess business value / ROI / funding | approve → `ccb`; else `send-back` | review | "EDP business & ROI review" | 5 |
| 4 | `ccb` | **Change Control Board** | ROI-approved | Security, architecture conformance, eng + platform capacity | approve → `live-data-waiver` (if live-data) or `provisioning`; else `send-back` | review | "EDP intake CCB" | 5 |
| 5 | `live-data-waiver` *(conditional)* | **EDP safeguards validator** | CCB-approved **and** `livesOnLiveData` | Attest required safeguard forms are on file (ADR-0003) | all required attested → `provisioning`; else `send-back` | review | "Live-data safeguards" (or N/A) | 3 |
| 6 | `provisioning` | Automation (BEARS + UC-tenant-provisioning notebook) | Prior gate cleared | Create entitlements + UC/compute | → `active` | auto | "Provisioning" | 5 (until automated) |
| 7 | `active` | Automation | Provisioned | Notify; register dataset/lineage; set recertification | terminal | auto | "Active" | — |

"business & ROI review" (analysis) and "intake CCB" (board approval gate) are kept
**separate** — the process viz treats them as distinct nodes with different actors,
criteria, and SLAs.

Stages 2–5 are each a **role-scoped inbox** for their actor role and support
**approve / send-back-with-questions**. Send-back is the shared loop that surfaces
"action needed" to the tenant without a full re-submit.

## Consequences

- **+** Single vocabulary; tenant tracker and employee queue read the same record + stage.
- **+** SLA and role-scoped inboxes attach uniformly to stages 2–5.
- **+** The conditional waiver is enforced in the state machine, not UI.
- **−** Downstream layers (store, UI) must migrate off the retired vocabularies (tracked as P3 + journey slices).
- SLA *defaults* live here as design; the authoritative numbers are P2 config and become admin-editable later.
