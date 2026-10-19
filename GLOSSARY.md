# EDP Vending Machine

The self-service front door to the IRS Enterprise Data Platform, where tenants bring new data onto the platform and get access to data already there. EDP staff review onboarding requests, and dataset owners decide who works on their data.

## Language

### People and roles

**Tenant**:
A team that wants to use Databricks on the EDP, as a data consumer, a data provider, or both. A tenant submits requests and tracks them to completion.
_Avoid_: Requester, customer, user

**Data consumer**:
A person reading a domain's certified or deprecated data through a domain entitlement, from any tenant or none.
_Avoid_: Reader, subscriber

**Data provider**:
A tenant bringing its own data onto the EDP. Everything the EDP needs to know about that data comes up front, in the intake package.
_Avoid_: Data owner, publisher, source

**Dataset owner**:
A person accountable for one dataset and named for it at intake, usually someone leading the tenant's work. A dataset owner holds the dataset's manager role and decides who gets a dataset role.
_Avoid_: Tenant lead, tenant manager, data manager, tag owner, steward

**Domain owner**:
The person who approves a domain's entitlement in BEARS, against criteria they define. A domain owner works outside the app.
_Avoid_: Steward, council, domain approver

**EDP**:
The IRS Enterprise Data Platform itself.
_Avoid_: using "EDP" alone to mean the people who run it

**EDP staff**:
The internal team that supports tenants and runs the EDP review stages.
_Avoid_: Employee, admin, EDP

**EDP admin group**:
The account group whose members hold every staff role in the MVP: EDP staff, EDP business office, CCB and Safeguards validator. Each role can move to its own group later (ADR-0008).
_Avoid_: Admins, staff group

**Domain**:
An IRS business area, such as Individual Filing or Business Tax, used to classify data. Many tenants' datasets can share one domain.
_Avoid_: Business unit, area, council

**Reviewer**:
Whoever must act on a request at a review stage. Each review stage has exactly one reviewer role.
_Avoid_: Approver, assignee

**EDP business office**:
The EDP staff who assess a request's business value and ROI.
_Avoid_: Finance review, business review board

**Change Control Board**:
The EDP board, abbreviated **CCB**, that approves an onboarding request's security, architecture fit, and platform capacity. Its approval is the decision to onboard.
_Avoid_: Intake board, CAB

**Safeguards validator**:
The EDP staff member who confirms that a person's EIR is valid.
_Avoid_: Compliance reviewer

### Requests and lifecycle

**Initiative**:
A tenant's approved effort to bring data onto the EDP for one business case. It passes the business & ROI review and the CCB once, and datasets are then added to it over time.
_Avoid_: Project, program

**Dataset**:
A body of data that a tenant provides under an initiative, carrying a domain tag and its own dataset tag. It is built up in bronze, silver, and gold layers.
_Avoid_: Table, source, data asset

**Onboarding request**:
A data provider's request to start an initiative, including its first datasets. Both the tenant and every reviewer read the same record.
_Avoid_: Pipeline entry, ticket, application

**Dataset addition**:
A lighter request to add a dataset to an already approved initiative, inheriting its business case.
_Avoid_: Onboarding request, amendment

**Intake package**:
Everything a data provider supplies up front with an onboarding request: every answer in the onboarding wizard (source profile, architecture, delivery support, business case, the datasets and their owners, workspace needs and sizing) and its attachments. The business & ROI reviewer, the CCB and the data provider all read the whole package.
_Avoid_: Form, application, submission

**Access request**:
A person's request to a dataset owner for a dataset role, decided in the app rather than in BEARS.
_Avoid_: Join request, access ticket, entitlement request

**Lifecycle**:
The fixed sequence of stages one kind of tracked work moves through. There are four: the onboarding request, the dataset addition, the access request, and the EIR.
_Avoid_: Pipeline, workflow, process

**Standup**:
The EDP staff work that sets an approved initiative or dataset up on the platform, between approval and active.
_Avoid_: Provisioning, setup

**Stage**:
One step in a lifecycle. Every request or EIR sits at exactly one stage at a time.
_Avoid_: Status, step, phase

**Terminal stage**:
In the three request lifecycles, a stage a request never leaves: active, rejected, or withdrawn.
_Avoid_: Closed, final state

**Transition**:
A request moving from one stage to another. The kinds are forward, approval, send-back, rejection, and withdrawal.
_Avoid_: Status change

**Forward**:
The system moving a request to its next stage with no one deciding, such as from submitted to business & ROI review.
_Avoid_: Advance, auto-approve

**Approval**:
A reviewer's or dataset owner's decision that moves a request past their stage.
_Avoid_: Sign-off, forward

**Send-back**:
A reviewer returning a request to the person who made it with questions, so they can answer without starting a new request.
_Avoid_: Reject-with-questions, bounce, return

**Resubmission**:
The person's answer to a send-back, with the whole intake as they edited it: any answer, and datasets and owners added or removed. The request goes back to the review stage that sent it back, with a fresh SLA due date, and that reviewer sees the answer and what changed since the send-back.
_Avoid_: Re-request, reapplication

**Rejection**:
A reviewer or dataset owner ending a request for good.
_Avoid_: Denial, decline

**Withdrawal**:
A person ending a request they made.
_Avoid_: Cancellation

**Live data**:
Production IRS data, including FTI, as opposed to test or synthetic data. Live data exists only in sensitive environments.
_Avoid_: Real data, prod data

**EIR**:
Employee Identity Record: a person's signed attestation that they hold the safeguards to work with FTI. A valid EIR is required to enter any sensitive environment, and it belongs to the person, not to any request.
_Avoid_: Live-data waiver, LDW, FTI form, Sensitive Data Waiver

**EIR definition**:
One versioned, validated description of the EIR form, written as YAML: its fields, help text, rules and their dispositions, timelines, validity period and synthetic scenarios. The form is rendered from it, and the bootstrap definition ships with the app.
_Avoid_: Form config, ruleset file

**Published EIR definition**:
An EIR definition Safeguards published from the staff app: an immutable version that keeps its YAML exactly as written, who published it and when. The server numbers it (1, 2, 3…); the YAML never names a version. Publishing doesn't change the form anyone sees.
_Avoid_: Draft definition, saved config

**Active EIR definition**:
The published EIR definition new EIR drafts use, chosen by Safeguards activating it; with none activated, the bootstrap definition. A draft is pinned to the version number it began under (the bootstrap definition's is the reserved `bootstrap`, version 0), and keeps it through later publishes, activations and rollbacks. Reactivating an earlier version is a **rollback**.
_Avoid_: Current config, live rules

**Provisioning**:
Turning a person's entitlements and dataset roles into real access in Databricks.
_Avoid_: Approval, fulfillment

**Recertification**:
The periodic re-review that decides whether active access should continue.
_Avoid_: Renewal, access review

### Data and access

**Tag**:
A governance label on data in the EDP. Every dataset carries a domain tag and a dataset tag.
_Avoid_: Label, dataset ID

**Certification tag**:
The system tag `system.certification_status`, which a dataset owner sets to `certified` to open a dataset to consumers, or `deprecated` to flag it for retirement while consumers keep access.
_Avoid_: Certified flag, quality badge, de-certified

**BEARS**:
The IRS entitlement system, built on SailPoint. It holds every entitlement and runs their approval chains.
_Avoid_: SailPoint

**Entitlement**:
A right held in BEARS: the Databricks entitlement, a domain entitlement, or a special entitlement.
_Avoid_: Role, permission, bundle

**Databricks entitlement**:
The basic entitlement that gives a person a Databricks account and the dev and test workspaces, with basic compute but no data.
_Avoid_: Workspace entitlement, account access

**Databricks account ID**:
The stable ID Databricks gives a person's account. The app keys people by it, and shows it for anyone it has no email for, such as a dataset owner named at intake. Physical Delta columns use `principal_id` for this value.
_Avoid_: SCIM id, principal id

**Domain entitlement**:
A BEARS entitlement for one domain, giving read access to its certified and deprecated data. It is the data consumer's access.
_Avoid_: Consumer entitlement, read role

**Special entitlement**:
A BEARS entitlement, like a domain entitlement, for one specific dataset that a domain entitlement shouldn't open.
_Avoid_: Exception entitlement

**Domain group**:
The Databricks group behind a domain entitlement or special entitlement.
_Avoid_: Domain role

**Dataset group**:
A Databricks group, managed in the app, that gives its members one dataset role on one dataset.
_Avoid_: Dataset entitlement

**Dataset role**:
Access to one dataset beyond a data consumer's read, given by a dataset owner: tester, developer, or manager. Each role grants a fixed set of access; there are no per-member access levels on top of it.
_Avoid_: Entitlement, permission set

**Tester**:
The dataset role with read-only access to all of a dataset's data, uncertified included.
_Avoid_: Consumer, reader

**Developer**:
The dataset role with read and write access to a dataset's data.
_Avoid_: Engineer, contributor

**Manager**:
The elevated dataset role: everything a developer has, plus managing jobs and the permissions on what the dataset publishes in prod. Only dataset owners decide who's on the team.
_Avoid_: Admin, data manager

**Sensitive environment**:
A higher environment where FTI data exists, such as preprod, prod, or analytics prod. Entering one requires a valid EIR.
_Avoid_: Higher env, prod

### Time and pressure

**SLA target**:
The promised turnaround for one stage, in business days.
_Avoid_: Deadline, due date

**SLA state**:
How a request is tracking against its current stage's SLA target: on-track, due-soon, or breached.
_Avoid_: Health, RAG status

**Escalation-appropriate**:
The point where a request's SLA is breached and the person waiting may reasonably chase the reviewer.
_Avoid_: Escalated, overdue

### Working rules

**Role-scoped inbox**:
A reviewer's queue: only the work at their stage and within their scope, such as the onboarding requests waiting on the CCB, the EIRs waiting on a safeguards validator, or the access requests waiting on one dataset's owners.
_Avoid_: Queue, admin view, dashboard

**Access view**:
The app's picture of one person's access: everything they can reach, plus a log of every group they joined or left.
_Avoid_: Permissions report, entitlement list

**Grant reconciler**:
The process that reads datasets' tags and works out the grants and revocations each domain group and dataset group should have.
_Avoid_: Tag policy, sync job

**Change list**:
The app's list of changes to make in Databricks, each with what needs to happen and why, for EDP staff to apply.
_Avoid_: Fulfillment queue, ticket, provisioning job

**Display code**:
The short label a person quotes to EDP staff for an EIR, onboarding request or access request: its prefix and six letters and digits, such as `ONB-7K3QFD`. Unique, not sequential. An EIR's display code is its **Record ID**, printed on the signed PDF. Records made before display codes keep their number (`EIR-1042`). Change-list entries keep sequential numbers (`CL-0042`).
_Avoid_: Ticket number, request number

**Honesty bar**:
The rule that the app never presents sample or stubbed behavior as real. Anything not yet real is gated or labelled.
_Avoid_: Mock mode
