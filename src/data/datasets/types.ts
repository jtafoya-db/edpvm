/**
 * Domain types for initiatives, datasets, dataset owners and dataset roles
 * (ADR-0005). Terms follow GLOSSARY.md.
 *
 * Every action records its actor as the stable account SCIM principal id
 * (ADR-0004) and an ISO-8601 timestamp.
 */

/** The three dataset roles a dataset owner manages in the app. */
export const DATASET_ROLES = ["tester", "developer", "manager"] as const;

export type DatasetRoleName = (typeof DATASET_ROLES)[number];

/**
 * Where an initiative sits. Only `active` initiatives accept dataset roles;
 * the onboarding lifecycle that moves an initiative here is a separate slice.
 */
export type InitiativeStage = "standup" | "active";

/** A tenant's approved effort to bring data onto the EDP for one business case. */
export interface Initiative {
  id: string;
  name: string;
  tenant: string;
  stage: InitiativeStage;
}

/**
 * A person accountable for one dataset. Owners named at intake are keyed by
 * SCIM id. Owners added in the app (#87) are named by name and email, like
 * members; their first owner action with that email binds it to their SCIM id
 * (ADR-0006, ownership.ts).
 */
export interface DatasetOwner {
  /** SCIM id, for owners named at intake or by deployment configuration. */
  principalId?: string;
  displayName: string;
  /** Normalised email, for owners added in the app. */
  email?: string;
  /** SCIM id of whoever added the owner in the app, and when. */
  addedBy?: string;
  addedAt?: string;
  /** For an email-added owner: the SCIM id their email is bound to, and when (ADR-0006). */
  matchedPrincipalId?: string;
  matchedAt?: string;
  /** Set when a session with this email but another SCIM id was refused. */
  mismatch?: { principalId: string; at: string };
}

/** A body of data provided under an initiative, with its domain tag, dataset tag and owners. */
export interface Dataset {
  id: string;
  initiativeId: string;
  name: string;
  domainTag: string;
  datasetTag: string;
  owners: DatasetOwner[];
}

/** The member facts the Datasets list needs without pulling every member row. */
export interface DatasetMemberSummary {
  /** `null` unless the viewer owns the dataset or is EDP staff (`canReadTeam`, #257). */
  totalMembers: number | null;
  /** `null` unless the viewer owns the dataset or is EDP staff (`canReadTeam`, #257). */
  roleCounts: Record<DatasetRoleName, number> | null;
  /** The viewer's own roles; everyone sees these. */
  viewerRoles: DatasetRoleName[];
}

/** A dataset list row with its member summary already attached. */
export type DatasetWithMemberSummary = Dataset & { memberSummary: DatasetMemberSummary };

/**
 * A person named by an owner: a display name and an email contact. The email
 * is stored normalised (trimmed, lower-cased) and is what duplicates are
 * judged on. Matching it to a Databricks user is later work (#103, #88).
 */
export interface PersonContact {
  name: string;
  /** Normalised email, or `""` for an intake owner known only by SCIM id. */
  email: string;
  /** SCIM id, for an intake owner with no email on record. */
  principalId?: string;
}

/** A SCIM id as screens show it: by its glossary name, Databricks account ID. */
export function accountIdLabel(principalId: string): string {
  return `Databricks account ID ${principalId}`;
}

/** How to reach a person: their email, or their SCIM id for an intake owner with none. */
export function personContact(person: PersonContact): string {
  return person.email || accountIdLabel(person.principalId ?? "unknown");
}

/**
 * One key per person: email, or SCIM id when there's no email. The name is a
 * last-resort display key only (React keys, counts on screen); it is never an
 * identity and never decides who may act.
 */
export function personId(person: PersonContact): string {
  return person.email || `scim:${person.principalId ?? person.name}`;
}

/** `addedBy` on the manager role every intake owner holds from the seed (standup). */
export const INTAKE = "intake";

/** Trim and lower-case an email so the same address always compares equal. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A plain shape check: one `@`, no spaces, and a dot in the domain. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** One person's dataset role on one dataset, and who recorded it when. */
export interface DatasetMember {
  datasetId: string;
  person: PersonContact;
  role: DatasetRoleName;
  /** SCIM id of the dataset owner who added the person. */
  addedBy: string;
  addedAt: string;
  /** Who last changed this role, from another role (#87), and when. */
  roleChangedBy?: string;
  roleChangedAt?: string;
}

/** A dataset owner's direct add of a person to a dataset role. */
export interface AddMemberInput {
  datasetId: string;
  /** The person's name, as the owner enters it. */
  name: string;
  /** The person's email; validated, then trimmed and lower-cased. */
  email: string;
  role: DatasetRoleName;
  /** Optional browser-minted key for retrying one confirmed save intent. */
  idempotencyKey?: string;
}

/** The seed the in-memory adapter starts from. */
export interface DatasetSeed {
  initiatives: Initiative[];
  datasets: Dataset[];
}
