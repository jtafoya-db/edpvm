// The MVP gate: this registry is the single source of truth for which surfaces
// are genuinely real ("live") versus mock-backed and therefore not part of the
// MVP ("coming-soon"). FeatureGate reads it to decide what the user actually
// sees, and the legacy shell (App.jsx / admin.jsx) routes every gated screen
// through it. Keeping this honest is the whole point — a surface marked "live"
// must be really wired, not just "the UI is built".
export const FEATURE_STATUSES = ["live", "stub", "planned", "coming-soon"] as const;

export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureDefinition {
  id: string;
  label: string;
  status: FeatureStatus;
  phase?: number;
  notes: string;
}

export const FEATURES = {
  // ---- Genuinely real — featured in the MVP -------------------------------
  "onboarding-wizard": {
    id: "onboarding-wizard",
    label: "Data onboarding wizard",
    status: "live",
    notes: "Schema-driven onboarding flow — fields, validation, sizing/ROI and request assembly.",
  },
  "admin-form-editor": {
    id: "admin-form-editor",
    label: "Intake form editor",
    status: "live",
    notes: "Repo-backed editor that emits a PR-ready config diff.",
  },
  "eir-lifecycle": {
    id: "eir-lifecycle",
    label: "Employee Identity Record",
    status: "live",
    notes:
      "Employee Identity Record (EIR) form, signed-PDF submission, stage, and safeguards validation. Records are saved to Delta (eir schema); signed PDFs stay on the Unity Catalog volume.",
  },
  "eir-definition-publishing": {
    id: "eir-definition-publishing",
    label: "EIR definitions (Safeguards)",
    status: "live",
    notes:
      "Safeguards edit an EIR definition's YAML in EDP Admin, validate and preview it on the server, publish immutable versions and activate one; reactivating an earlier version rolls back. New EIR drafts use the active version; drafts and submissions keep theirs. Saved to Delta (eir schema). The editor is a plain textarea. The validity period and review SLA still come from deployment configuration, not the published definition. Nothing here makes an EIR valid automatically.",
  },
  "dataset-team": {
    id: "dataset-team",
    label: "Dataset team",
    status: "live",
    notes:
      "Dataset owners add, edit and remove testers, developers and Maintainers, and manage owners; each role grants a fixed set of access, and each change goes on the change list. Saved to Delta (see dataset-access-persistence).",
  },
  "change-list": {
    id: "change-list",
    label: "Change list",
    status: "live",
    notes:
      "Changes for EDP staff to apply in Databricks by hand, then mark applied. The app writes nothing to Databricks. Saved to Delta (see dataset-access-persistence).",
  },
  "onboarding-request-persistence": {
    id: "onboarding-request-persistence",
    label: "Saved onboarding requests",
    status: "live",
    notes:
      "Onboarding requests and their review decisions are saved to Delta when the Delta backend is enabled. Local memory mode still keeps them only for the current session.",
  },
  "access-requests": {
    id: "access-requests",
    label: "Access requests",
    status: "live",
    notes:
      "People ask a dataset's owners for a dataset role; owners approve or reject it. Approval adds the person exactly as a direct add does, change-list entry included. The SLA target shown is a provisional default from configuration that the business hasn't confirmed, and it doesn't skip holidays.",
  },
  "access-request-persistence": {
    id: "access-request-persistence",
    label: "Saved access requests",
    status: "stub",
    notes:
      "Requests you make, and every approval, rejection and withdrawal, are kept in this browser tab's in-memory store, with every data backend, Delta included, so they're visible only in the tab where they happened. Saving them to Delta isn't built yet, and reloading the page discards them. In local development, and on a PR preview deployed to ask for them, two sample requests (marked \"sample\") are recreated, open, every time the app loads. Production has none.",
  },
  "dataset-access-persistence": {
    id: "dataset-access-persistence",
    label: "Saved team members and change list",
    status: "live",
    notes:
      "Datasets and their owners, team members, owners added in the app, team history and change-list entries are saved to Delta (the initiatives, teams and change_list schemas, #123) when the app runs with the Delta backend, as previews and production do: they survive a reload and every session sees them. With the memory backend (local development only) they're kept in the browser tab, and the team and change-list screens say so. Access requests are still session-only (access-request-persistence).",
  },
  "onboarding-review": {
    id: "onboarding-review",
    label: "Onboarding review inboxes",
    status: "live",
    notes:
      "Business & ROI review and CCB inboxes for direct members of the EDP admin group, with SLA states. Requests are saved to Delta when the app uses the Delta backend; the local-development memory backend resets on reload.",
  },
  "onboarding-request-status": {
    id: "onboarding-request-status",
    label: "My onboarding requests",
    status: "live",
    notes:
      "A data provider's onboarding requests with current stage and SLA state; answer a send-back and resubmit, or withdraw.",
  },
  "intake-owners": {
    id: "intake-owners",
    label: "Initiative and dataset owners at intake",
    status: "live",
    notes:
      "In the onboarding wizard the data provider names the initiative point of contact and each dataset's owners, each as Myself or Someone else. Myself is verified from the account they're signed in with. Someone else is a name and an email: the email is checked for format only, and the person shows as not verified. Naming someone as the initiative point of contact doesn't make them a dataset owner or give them dataset-team rights. EDP staff then match these people to Databricks users by hand (owner-matching); confirming someone from a user directory isn't built (owner-directory-verification, #249).",
  },
  "owner-matching": {
    id: "owner-matching",
    label: "Owner matching to Databricks users",
    status: "live",
    notes:
      "On an onboarding request at review, EDP staff (direct members of the EDP admin group) enter the Databricks account ID they found for each owner who isn't the provider's own account, or request user onboarding, which lists one by-hand onboard-user entry on the change list. A staff match is labelled entered by staff, not verified (see owner-directory-verification), and writes no permanent email binding. The provider sees each owner's match state only, not the IDs or who matched.",
  },
  "group-membership-reader": {
    id: "group-membership-reader",
    label: "Databricks group membership snapshot",
    status: "live",
    notes:
      "The server reads current membership and bounded Change Data Feed history through the allow-listed SQL proxy as the app service principal. Dataset owners see domain groups for their owned datasets' domains and dataset groups only for their exact owned dataset tags; EDP staff can read all rows. Maintainer-only identities see no member rows.",
  },

  // ---- Grayed preview panels (inert stubs). Semantics preserved. ----------
  "dedicated-workspace-criteria": {
    id: "dedicated-workspace-criteria",
    label: "Dedicated-workspace decision",
    status: "stub",
    notes:
      "Your answers are recorded for EDP, but the criteria for deciding when an initiative needs dedicated workspaces aren't defined yet.",
  },
  "intake-attachments": {
    id: "intake-attachments",
    label: "Intake package attachments",
    status: "stub",
    notes:
      "Attachments can't be added to an intake package yet, so none are shown here. Uploading supporting documents, such as architecture documents, isn't built yet.",
  },
  "compute-policy-change-requests": {
    id: "compute-policy-change-requests",
    label: "Compute policy change requests",
    status: "stub",
    notes: "Asking EDP to change your compute policy isn't in the app yet.",
  },
  "llm-challenger": {
    id: "llm-challenger",
    label: "LLM challenger",
    status: "stub",
    phase: 1,
    notes: "Per-section preview with mock suggestions; FMAPI wiring follows P1.",
  },
  "jira-create": {
    id: "jira-create",
    label: "Request submit to JIRA create",
    status: "stub",
    phase: 1,
    notes: "Becomes live when the JIRA path lands (OQ-6).",
  },
  "eir-form-fields": {
    id: "eir-form-fields",
    label: "EIR form fields",
    status: "live",
    notes:
      "EDP's EIR form, rendered from the validated built-in EIR definition bootstrap-2 (version 0, src/data/eir/definition/bootstrap-2.eir.yaml) while no published version is active; if it can't be loaded the EIR is shown as unavailable. The person types their manager; there's no HR-system lookup. Every rule blocks the PDF and says what to go do (#217); drafts begun on the bootstrap definition (or form 1.3) keep its rules. The rule set and its placeholder wording are a non-production MVP default pending Safeguards (#148); nothing is validated automatically.",
  },

  // ---- A genuinely future (not-yet-built) capability ----------------------
  "automated-provisioning": {
    id: "automated-provisioning",
    label: "Automated provisioning",
    status: "planned",
    phase: 3,
    notes: "Planned for Phase 3.",
  },

  "owner-directory-verification": {
    id: "owner-directory-verification",
    label: "Confirm owners from a user directory",
    status: "planned",
    phase: 2,
    notes:
      "Not built: the app can't read a user directory (SCIM user search is admin-only and app user tokens have no scim scope), so a staff-entered Databricks account ID is checked for format only and stays not verified. A directory projection that resolves owners in code is #249.",
  },

  // ---- Mock-backed surfaces — hidden from nav, gated as coming-soon -------
  // These render on the window.AppData mock seed today. They stay in the repo
  // but are NOT surfaced: nav hides them, and direct navigation shows the
  // coming-soon card instead of the mock content.
  "data-discovery": {
    id: "data-discovery",
    label: "Data discovery & catalog",
    status: "coming-soon",
    notes: "Browse domains, dataset search and the governed catalog are not part of this MVP yet.",
  },
  "access-bundles": {
    id: "access-bundles",
    label: "Access bundles",
    status: "coming-soon",
    notes: "Pre-packaged entitlement bundles are not part of this MVP yet.",
  },
  "request-cart": {
    id: "request-cart",
    label: "Request cart",
    status: "coming-soon",
    notes: "Assembling and submitting an access-request cart is not part of this MVP yet.",
  },
  "request-status-tracking": {
    id: "request-status-tracking",
    label: "Request stage tracking",
    status: "coming-soon",
    notes: "Live request tracking arrives once the JIRA/provisioning path is connected.",
  },
  "cross-system-access": {
    id: "cross-system-access",
    label: "My Access (cross-system view)",
    status: "coming-soon",
    notes: "A cross-system view of your active access is not part of this MVP yet.",
  },
  "admin-operations": {
    id: "admin-operations",
    label: "Admin operations console",
    status: "coming-soon",
    notes:
      "Bundle mapping, provisioning health, dataset registry, onboarding flow, pipeline tracker and tenant/budget run on mock data and are not part of this MVP yet.",
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureId = keyof typeof FEATURES;

export function getFeature(id: FeatureId): FeatureDefinition {
  return FEATURES[id];
}
