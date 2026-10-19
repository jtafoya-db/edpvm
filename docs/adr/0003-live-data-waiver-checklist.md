# ADR 0003 — Live-data waiver as an attestation checklist

- **Status:** Superseded by [ADR-0005](0005-domain-access-model.md). Previously: Accepted (model); implementation lands in the employee-journey slice
- **Deciders:** product owner + polly
- **Related:** ADR-0001 (stage 5 `live-data-waiver`), `lifecycle.ts` (`livesOnLiveData` gate)

## Context

Access to live/production data requires certain safeguard forms to be **on file**
(e.g. Pub-1075 / FTI-adjacent safeguards). Product direction: *"it's essentially a
checklist of forms you need to have on file — not our problem where they live — just
need folks to check yes."* So the app is **not** an evidence store; it records that a
validator has confirmed each required form exists.

There is no "waiver" concept in the repo today; the nearest real reference is the
SBU / Publication 1075 safeguards material in the challenger skill's context pack.

## Decision

The `live-data-waiver` stage is an **attestation checklist**, not document storage.

1. **Shape (attached to the canonical request):**
   ```
   LiveDataWaiverChecklist = {
     items: Array<{
       id: string;            // stable key
       label: string;         // e.g. "Pub 1075 safeguards documented"
       description?: string;  // what "on file" means for this item
       required: boolean;
       attested: boolean;     // the validator's "yes, on file"
       attestedBy?: string;   // who (audit)
       attestedAt?: string;   // when, ISO (audit)
       note?: string;         // optional pointer/reference text
     }>;
   }
   ```
   The checkbox attests *"this form is on file elsewhere"* — it is **not** evidence
   upload. The UI must say so plainly (honesty bar).

2. **Template is configurable data** (admin-editable later), seeded with a *starting*
   set — e.g. Pub-1075 safeguards documented; data-sharing agreement / ISA on file;
   privacy impact assessment on file; SBU/authority-to-operate handling confirmed.
   We do **not** claim this is the legally complete set; the org edits the template.

3. **Trigger:** the stage exists only when `livesOnLiveData === true`. P1 already
   enforces this in `validateTransition` (blocks `ccb → provisioning` for live-data
   requests). Test-data-only requests skip the stage.

4. **Exit criterion:** every `required` item `attested === true` → advance to
   `provisioning`. Any unattested required item blocks; a validator may `send-back`.

5. **Validator:** the EDP **safeguards-validator** role, via the role-scoped inbox
   (ADR-0002 mechanism). The record captures who/when per item for audit.

## Consequences

- **+** Small to build: checklist state on the record + a validator screen with checkboxes.
- **+** Auditable (who attested what, when) without any file-storage scope.
- **+** Template editable as the real form list firms up.
- **−** The app trusts the attestation; it does not verify the forms exist. This is a
  deliberate scope boundary and must be stated in the UI and to auditors.
- **−** Needs a seeded checklist template + the safeguards-validator role-group.
