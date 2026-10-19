# MVP: the EDP access model

**Status:** Draft, 2026-10-01. The direction is a **domain model**, which replaces the earlier per-dataset entitlement assumption. Inputs: the [EDP Access Decision Chart](sources/edp-access-decision-chart.html) (a self-contained HTML page; open it in a browser), kept as delivered and **superseded** where it differs from this doc (per-tag BEARS entitlements, "tag owner", the Sensitive Data Waiver), and [`governance-research.md`](governance-research.md). Terms in **bold** are defined in [`GLOSSARY.md`](../GLOSSARY.md). This draft is the input to the spec (`/to-spec`) and the ticket breakdown (`/to-tickets`).

## The model in one paragraph

Access comes in layers. **BEARS** (SailPoint) holds only coarse **entitlements**: the **Databricks entitlement**, which gives an account and the dev and test workspaces with basic compute, and one **domain entitlement** per **domain**, which gives read access to that domain's certified and deprecated data. Anything finer is managed in the app: each **dataset** has **dataset groups** for the **tester**, **developer**, and **manager** roles, and its **dataset owners** decide who is in them. Separately, the app tracks each person's **EIR** (Employee Identity Record). A valid EIR is required to enter any **sensitive environment**. On the provider side, a tenant brings data through an **initiative** that is reviewed once, and each of its datasets is onboarded with a domain, a dataset tag, and one or more owners. In the MVP the app never changes Databricks access itself: it produces a **change list** of everything that needs to happen. The one direct Databricks write is document storage: the server writes signed EIR PDFs to a configured Unity Catalog volume.

## How a person gets access

| Step                                  | Where                                                                      | What they get                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Request the Databricks entitlement | BEARS                                                                      | A Databricks account and the dev and test workspaces, with basic compute and no data                                           |
| 2. Request a domain entitlement       | BEARS, approved by the domain owner and provisioned by EDP staff           | Read access to the domain's certified and deprecated data: the **data consumer** role. The app shows it but doesn't manage it. |
| 3. Get a dataset role                 | The app: request it from a dataset owner, or an owner adds them            | **Tester**, **developer**, or **manager** on one dataset, plus the workspaces that role needs                                  |
| 4. Submit an EIR                      | The app: upload the signed PDF, then a safeguards validator marks it valid | Entry to sensitive environments, such as analytics prod, on top of steps 2 or 3                                                |

- **FTI isn't an entitlement.** The app holds a yes/no per person: a valid EIR, or not. The EIR is the same form CDW already uses, uploaded as a signed PDF because signatures can't be automated yet. Without one, nobody reaches prod. Masked access and general (non-FTI) access in prod come later.
- **Write access is never domain-wide.** It always comes from a dataset role.
- **Special entitlements** for specific datasets that a domain entitlement shouldn't open are deferred. Each such dataset will get its own entitlement, which works like a domain entitlement (CDW calls these special access groups), and the model has to leave room for it.

## Dataset roles

| Role          | Access to one dataset                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| **Tester**    | Read everything with the dataset's tag, uncertified data included, and read its folders               |
| **Developer** | Read and write everything with the dataset's tag, and read its folders                                |
| **Manager**   | Elevated: everything a developer has, plus managing permissions on what the dataset publishes in prod |

Each role grants a fixed set of access, the one its role card describes. Dataset owners don't set access levels per member: a fixed set per role is simpler, and that granularity isn't needed yet (decided 2026-10-04, #119). Each role brings the workspaces the dataset needs for it, such as the SDLC workspaces for developers. A dataset owner holds the manager role.

## Who does what

| Role                       | In the MVP they…                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Data provider**          | Submits the onboarding request, naming one or more owners for each dataset                             |
| **Dataset owner**          | Approves or rejects access requests, adds people directly, sets their roles, and certifies the dataset |
| **Tester** / **developer** | Request a dataset role, submit an EIR, and work in the workspaces their role brings                    |
| **Data consumer**          | Holds a domain entitlement (outside the app) and reads the domain's certified and deprecated data      |
| **Domain owner**           | Approves domain entitlements in BEARS, against their own criteria. Outside the app.                    |
| **EDP business office**    | Reviews the business case and ROI                                                                      |
| **CCB**                    | Makes the decision to onboard                                                                          |
| **EDP staff**              | Check dataset additions, work through the change list, and provision domain entitlements               |
| **Safeguards validator**   | Marks a person's EIR valid, or sends it back, rejects it, or revokes it                                |

In the MVP one group, the **EDP admin group** (`EDP_ADMIN_GROUP_ID`), holds the four staff roles: EDP business office, CCB, EDP staff and Safeguards validator. Its members hold all four, and anyone outside it holds none (ADR-0008, 2026-10-18 amendment). The roles stay separate in the app, so one can move to its own group later. Whether one person may take two decisions on the same record is still open (#148). The app already refuses a validator their own EIR.

## Four lifecycles

```
Onboarding request   submitted → business & ROI review → CCB → standup → active
Dataset addition     submitted → EDP check (may escalate to CCB) → standup → active
Access request       requested → active | rejected        (an owner can also add someone directly)
EIR                  not started → submitted → valid → expired | revoked   (renewal restarts at submitted)
```

At any review stage, a request can also be **rejected**, which ends it, or **withdrawn** by the person who made it. **Active**, **rejected**, and **withdrawn** are the request lifecycles' terminal stages.

1. **Onboarding request** (starts an initiative). The intake package carries the business case and ROI, the datasets (each with a domain, a dataset tag, and one or more owners), and the workspace needs (derived from questions about isolation and team size). The intake also shows an overview of the standard compute policy, which tenants can ask to change later. Reviewers can **send back** a request with questions. **Standup** creates the schemas, compute, and SQL warehouse in every environment, permits the initiative's workspaces (providing dedicated workspaces where they're needed), and creates each dataset's groups. **Active** means dataset owners can start adding people; it doesn't wait for certification.
2. **Dataset addition** (adds a dataset to an approved initiative). It collects only dataset-level fields, inherits the business case, and skips the business & ROI review and the CCB unless the EDP check escalates it. The new dataset can be in a different domain, and it gets its own owners and dataset groups, but no new BEARS entitlements.
3. **Access request** (one person, one dataset, one role). The person asks for tester, developer, or manager, and a dataset owner approves or rejects it. A dataset owner can also add someone directly. Nothing goes through BEARS.
4. **EIR** (one per person, independent of any request). The person submits the signed PDF, and a safeguards validator marks it valid. It expires after a fixed period, and a safeguards validator can revoke it early, which holds any pending access to sensitive environments until it's valid again. Access into a sensitive environment is held until the EIR is valid, then goes on the change list.

_Decision note (2026-10-05): the Safeguards validator role revokes EIRs. In the MVP the EDP admin group holds that role._

**Rules that apply across all four:**

- **Send-back.** Any review stage can send a request back to the person who made it, with questions, so they can answer without starting a new request. Their resubmission goes back to the stage that sent it back: a CCB send-back returns to the CCB, a business & ROI review send-back to the business & ROI review. That stage's SLA starts again from the resubmission, and its reviewer sees the answer and what changed since the send-back.

  _Decision note (2026-10-15): a resubmission returns to the stage that sent it back, replacing the earlier rule that every resubmission returned to the business & ROI review._

- **The change list.** In the MVP the app never writes access changes to Databricks. Every access change it decides on goes on a change list: each group membership to add or remove, each grant to issue or revoke, and each standup step, with what needs to happen and why. EDP staff apply the list by hand for now, and automation can take it over later. Signed EIR PDFs are the sole exception: the app server writes those documents to a configured Unity Catalog volume; that document write never changes access.
- **Grants follow tags.** Schemas and grants are keyed to tags. Each dataset group's grants are keyed to the dataset's tag, and each domain group reads the domain's certified and deprecated datasets. Unity Catalog can't grant table access from tags directly, so a **grant reconciler** reads the tags and works out the `GRANT`/`REVOKE` statements, which go on the change list. On `example-workspace` (commercial AWS), only the grant path was tested: reading the tags, generating one `GRANT SELECT`, and applying it. `REVOKE`, tag removal, deprecation, drift, and GovCloud are untested. See [`governance-research.md`](governance-research.md) section 6.
- **Certification.** A dataset owner sets `system.certification_status` on the dataset:
  - `certified` once its gold and silver layers are ready, which opens it to the domain's consumers;
  - `deprecated` to retire it, so consumers keep access but the dataset is labelled deprecated;
  - removing the tag altogether removes consumers' access, and the grant reconciler puts the `REVOKE`s on the change list.

  Data consumers only ever reach certified or deprecated datasets, and only gold and silver, never bronze. Testers see everything with the dataset's tag, uncertified data included.

- **Dataset owners.** A dataset always has at least one owner, and any one of them can act alone. Owners can add or remove other owners, and EDP staff can reassign ownership when the last one leaves. Every action records who took it.
- **SLAs** apply to the business & ROI review, the CCB, the EDP check, EIR validation, and dataset owners' decisions on access requests. Standup gets an SLA once its automation is real.

## MVP scope

| Real in the first release                                                                                                             | Stubbed and labelled (honesty bar)                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| EIR tracking: signed-PDF upload, validator check mark, and valid, expired, and revoked states                                         | The EIR's checklist items and validity period                                                         |
| Dataset groups: owners add people directly and set their roles                                                                        | Domain-group membership, which the app shows as a read-only consumer role once it can read the groups |
| Access requests routed to dataset owners, if the effort is low. Fallback: show who to ask.                                            | The criteria for dedicated workspaces, and requests to change compute policy                          |
| The change list: every group membership, grant, and standup step to apply, with what needs to happen and why                          |                                                                                                       |
| The access view: per-person access, plus a log of every group add and removal                                                         |                                                                                                       |
| Onboarding requests with the business & ROI review → CCB, send-back, and SLAs                                                         |                                                                                                       |
| Dataset additions, with the EDP check                                                                                                 |                                                                                                       |
| Certification by dataset owners (certified, deprecated, or removed), and consumer access limited to certified and deprecated datasets |                                                                                                       |
| Tenant visibility and EDP management views                                                                                            |                                                                                                       |

**Out of the app entirely:** applying the change list in Databricks; BEARS itself (the Databricks and domain entitlements, which EDP staff provision); special entitlements (deferred); masked access; removing access when someone loses a BEARS entitlement; self-service dataset discovery inside a domain; and access history from the system audit tables.

**Why this split:** EIR tracking, dataset groups, and a clear view of who has what are what EDP staff at the working level need first, and onboarding reviews are included alongside them. Only signed-EIR document storage writes directly to Databricks; no access change does. The change list makes every needed access change explicit, so EDP staff can apply it by hand now and automation can take it over once it's wired and tested.

## What this replaces

- **ADR-0001** (a single 7-stage lifecycle for every request) is replaced by the four lifecycles above. Domain review is gone from the request lifecycle, the waiver becomes the person's EIR, and access is split between BEARS and the app. The send-back loop and SLAs carry over.
- **ADR-0002** (routing requests to domain owners) is replaced. Domain owners approve domain entitlements in BEARS, outside the app, and dataset owners approve dataset roles in the app.
- **ADR-0003** (a per-request live-data waiver checklist) is replaced by the per-person EIR that gates sensitive environments.
- **Existing work to revisit:** #66 stores waiver attestations per request, and #53 creates domain-owner groups in the app. `lifecycle.ts`, `waiver.ts`, and `domain-owners.ts` encode the old model, and the catalog cart's **bundles** give way to domain entitlements and dataset roles.

## Open questions

1. **Group naming and structure.** What are the exact names and structure of the domain groups and dataset groups? The app has to know them.
2. **Mapping roles to Unity Catalog.** The roles' meaning is set (see [Dataset roles](#dataset-roles)). Still open: the exact Unity Catalog privileges and folder permissions behind each role's fixed set of access, and which workspaces each role gets for a given dataset.
3. **Special entitlements (deferred).** Which datasets need their own entitlement, who approves it, and how it's named.
4. **Domain-owner criteria.** Who is the domain owner for each domain, and what criteria do they use to approve domain entitlements in BEARS?
5. **Recertification.** Who confirms that a person still needs a dataset role, how often, and what happens when nobody responds?
6. **Workspace and compute details.** The criteria for dedicated workspaces, and the process for requesting changes to the standard compute policy.
7. **EIR details.** Which checklist items the EIR requires, and how long it stays valid.
8. **Later, not MVP:** masked access, general (non-FTI) access in prod, removing access when someone loses a BEARS entitlement, automating the change list, and how accounts get provisioned and how the app reads domain-group membership.

## Next steps

1. Update the system diagram with the domain model and the in-app dataset workflow.
2. Record the model as ADR-0005, superseding ADR-0001 through ADR-0003.
3. Run `/to-spec` to publish the spec issue, then `/to-tickets` to split it into vertical slices.
4. Re-scope #66 (per-person EIR, not per-request attestations) and #53 (domain owners act in BEARS, not the app).
