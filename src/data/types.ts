/**
 * Domain types for the EDP Vending Machine data-access seam.
 *
 * These model the app's three state families — CATALOG (reference/dimension
 * data), REQUEST (the access requests a tenant submits) and STATUS (the
 * approval/provisioning timeline for a request) — the way they would live in
 * Delta tables behind Unity Catalog. See docs/delta-schema.md for the implied
 * table shapes. Today the P1 in-memory adapter is seeded from the existing
 * `window.AppData` prototype data (src/legacy/appData.js); a later phase swaps
 * in a Delta/UC-backed adapter with no change to these types or their callers.
 */

import type { OnboardingReviewerRole } from "./onboarding/types";
import type { EffectiveSlaConfig } from "./sla-config";

// ---- Session / identity ----------------------------------------------------

/**
 * Where the server took a user's display name from (`/api/session`), so an
 * operator can see why a name looks wrong without server logs. Only
 * `scim-display` and `scim-parts` are a person's real name; `none` means no
 * usable value, so the display name is a placeholder.
 */
export type NameSource = "scim-display" | "scim-parts" | "header" | "email" | "username" | "none";

/**
 * The current user (identity + tenant + role flags). Delta: `access.current_user`.
 *
 * `principalId` is the STABLE account SCIM id resolved server-side from the
 * Databricks App forwarded identity (ADR-0004, decisions 1–2); it — not `email`
 * — is the durable key any request/attestation is attributed to. `isAdmin` is
 * derived from real group membership server-side, never trusted from the browser.
 */
export interface UserProfile {
  /** Stable account SCIM principal id (server-resolved). The durable identity key. */
  principalId: string;
  name: string;
  /** SCIM `/Me` name parts, when the workspace has them (EIR form pre-fill). */
  givenName?: string;
  familyName?: string;
  /** Where `name` came from (server-resolved). Absent for seed users. */
  nameSource?: NameSource;
  initials: string;
  title: string;
  tenant: string;
  email: string;
  isOnboardingLead: boolean;
  isAdmin: boolean;
  /** Holds the Safeguards validator role: in the MVP, membership of the EDP admin group (#226). */
  isSafeguardsValidator?: boolean;
  /**
   * A PR preview's EIR test mode (`src/server/eir-test-mode.ts`): this
   * validator may decide their own EIR. Present only when it's on.
   */
  eirSelfDecisionTestMode?: true;
  /**
   * A PR preview's sample access requests are on
   * (`src/server/sample-access-requests.ts`): the Delta store seeds them.
   * Present only when it's on; production never has it (#312).
   */
  sampleAccessRequests?: true;
  /** Onboarding reviewer roles held, derived server-side (#86): both for an EDP admin group member (#226). Absent ⇒ none. */
  onboardingReviewerRoles?: OnboardingReviewerRole[];
  /** Effective deploy-time SLA settings, read server-side and returned by /api/session. */
  slaConfig?: EffectiveSlaConfig;
  /** Optional deploy-time support mailbox; absent means the UI must not imply one exists. */
  supportEmail?: string;
}

// ---- Catalog (reference / dimension) --------------------------------------

/** A source system of record (MeF, IMF, …). Delta: `catalog.source_systems`. */
export interface SourceSystem {
  id: string;
  name: string;
  short: string;
  org: string;
  type: string;
}

/** A governed business domain. Delta: `catalog.domains`. */
export interface BusinessDomain {
  id: string;
  name: string;
  code: string;
  color: string;
  tags?: string[];
  aliases: string[];
  description: string;
  useCases: string[];
  /** Source-system ids that feed this domain. */
  systems: string[];
  steward: string;
  owner: string;
}

export type BundleComponentType =
  "bears_role" | "sailpoint_group" | "dbx_workspace" | "dbx_entitlement" | "dbx_group" | "uc_grant";

/** One grant/entitlement inside a bundle. Delta: `catalog.bundle_components`. */
export interface BundleComponent {
  type: BundleComponentType;
  label: string;
  scope: string;
}

/** An access bundle a tenant can request. Delta: `catalog.access_bundles`. */
export interface AccessBundle {
  id: string;
  name: string;
  persona: string;
  color: string;
  description: string;
  sla: string;
  bearsRequired: boolean;
  approvalModel: string;
  approvers: string[];
  /** Bundle ids that must be held first. */
  prerequisites: string[];
  requestable: boolean;
  components: BundleComponent[];
  unlocks: string[];
}

export type AssetType = "table" | "view" | "dashboard" | "genie";

export type BundleRequirement = "required" | "alternative" | "optional";

/** A bundle requirement attached to a dataset. Delta: `catalog.dataset_required_bundles`. */
export interface RequiredBundle {
  bundle: string;
  requirement: BundleRequirement;
  note: string;
}

/** A governed data asset (table/view/dashboard/genie). Delta: `catalog.datasets`. */
export interface DataAsset {
  id: string;
  assetType: AssetType;
  name: string;
  businessName: string;
  domain: string;
  system: string;
  classification: string;
  certification: string;
  usageType: string;
  freshness: string;
  popularity: number;
  owner: string;
  steward: string;
  catalog: string;
  schema: string;
  object: string;
  workspace: string;
  tags: string[];
  description: string;
  requiredBundles: RequiredBundle[];
  unlocks: string[];
  lineage: string[];
}

/** A starter recommendation by persona. Delta: `catalog.onboarding_personas`. */
export interface OnboardingPersona {
  id: string;
  label: string;
  desc: string;
  bundles: string[];
}

/** Tenant usage-vs-budget rollup (admin). Delta: `admin.tenants`. */
export interface Tenant {
  id: string;
  name: string;
  lead: string;
  fyBudget: number;
  fytdSpend: number;
  mtdSpend: number;
  forecastFy: number;
  dbusMonth: number;
  storageTb: number;
  users: number;
  datasets: number;
  openItems: number;
}

// ---- Request + status ------------------------------------------------------

export type SubRequestStatus = "done" | "active" | "pending" | "blocked";

/** One step of a request's approval/provisioning timeline. Delta: `requests.request_steps`. */
export interface SubRequest {
  system: string;
  status: SubRequestStatus;
  detail: string;
  ticket?: string;
  error?: string;
}

/** A line item in a request (a dataset, a bundle or an onboarding ask). */
export interface RequestItem {
  kind: string;
  ref?: string;
  id?: string;
  bundle?: string;
  label?: string;
  sub?: string;
}

/** A tenant access request. Delta: `requests.access_requests` (+ items/steps). */
export interface AccessRequest {
  id: string;
  title: string;
  submittedAt: string;
  status: string;
  overall: string;
  purpose: string;
  items: RequestItem[];
  subRequests: SubRequest[];
  stageIndex: number;
  /** Stable SCIM principal id used as the durable requester key (ADR-0004). */
  requesterPrincipalId?: string;
  /** Display-only username/email stored alongside the stable key. */
  requesterUsername?: string;
}

/** Append-oriented, auditable live-data waiver attestation. */
export interface WaiverAttestation {
  id: string;
  requestId: string;
  checklistItemId: string;
  attestorPrincipalId: string;
  attestorUsername: string;
  attested: boolean;
  attestedAt: string;
  note?: string;
  source: string;
  createdAt: string;
  supersededAt?: string;
}

/** A decision entry on a pipeline row. */
export interface PipelineDecision {
  at: string;
  actor: string;
  decision: string;
  note: string;
  jira: string;
}

/** An enterprise onboarding/access pipeline row (admin). Delta: `requests.pipeline`. */
export interface PipelineEntry {
  id: string;
  kind: "onboard" | "access";
  title: string;
  tenant: string;
  requester: string;
  submittedAt: string;
  state: string;
  stage: string;
  nextAction: string;
  owner: string;
  ageDays: number;
  jira: string;
  jiraStatus: string;
  monthlyCost: number;
  roi: number | null;
  sensitivity: string;
  pattern: string;
  delivery: string;
  decisions: PipelineDecision[];
}

/** The current user's active access. Delta: `access.my_access`. */
export interface MyAccess {
  workspaces: Array<{ name: string; entitlement: string; since: string }>;
  bundles: Array<{
    bundle: string;
    since: string;
    status: string;
    expires?: string;
    domain?: string;
  }>;
  domains: string[];
  recentAssets: string[];
}

/** A read-oriented projection of a request's status/timeline. */
export interface RequestStatus {
  requestId: string;
  status: string;
  overall: string;
  stageIndex: number;
  stages: string[];
  subRequests: SubRequest[];
}

// ---- Seed snapshot ---------------------------------------------------------

/**
 * The raw prototype data shape published on `window.AppData` by the legacy
 * module (src/legacy/appData.js). The in-memory adapter reads a snapshot of
 * this to seed itself, so the app runs with no backend.
 */
export interface AppDataSnapshot {
  user: UserProfile;
  systems: SourceSystem[];
  domains: BusinessDomain[];
  bundles: AccessBundle[];
  datasets: DataAsset[];
  requests: AccessRequest[];
  myAccess: MyAccess;
  onboardingPersonas: OnboardingPersona[];
  STAGES: string[];
  pipeline: PipelineEntry[];
  tenants: Tenant[];
}
