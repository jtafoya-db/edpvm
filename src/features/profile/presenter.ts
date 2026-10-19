/**
 * Profile presenter — the NAMED TEST SEAM for the Profile page (issue #68).
 *
 * A single PURE function, {@link presentProfile}, that maps the server-resolved
 * {@link UserProfile} (plus future access/waiver/request inputs) onto a
 * {@link ProfileViewModel} the view renders verbatim. It performs NO I/O and
 * reads NO globals, so every honesty rule below is unit-testable in isolation:
 *
 * - Only the RESOLVED IDENTITY is presented as real. It comes straight from
 *   `/api/session` (`src/server/session.ts`), which resolves the real Databricks
 *   App forwarded principal server-side (ADR-0004, decisions 1–2).
 * - `isAdmin` is server-derived from EDP-admin group membership; the presenter
 *   only LABELS how it was derived, it never re-decides authorization.
 * - The dev-fallback marker is derived from the known non-real principal-id
 *   sentinels (see {@link isDevFallbackPrincipal}) so a local/dev identity is
 *   never shown as a real Databricks-forwarded one.
 * - The three expansion sections (access, waiver, requests) are ALWAYS rendered
 *   in a "not yet connected" state until their persistence backbone lands
 *   (#24 / #25 / #66). The presenter NEVER fabricates data for them.
 */
import type { UserProfile } from "@/data/types";

/** Where the resolved identity came from. */
export type IdentitySource = "databricks-forwarded" | "local-dev-fallback";

/** The presented identity block — the only part of the page that is real data. */
export interface IdentityView {
  displayName: string;
  /** Shown as "username / email"; the sanitized UserProfile carries only email today. */
  email: string;
  /** Stable account SCIM principal id — the durable identity key (ADR-0004, decision 2). */
  principalId: string;
  source: IdentitySource;
  /** True when this is a local dev/seed identity, not a real forwarded one. */
  isDevFallback: boolean;
  /** Short human label for the source, e.g. "Databricks-forwarded identity". */
  sourceLabel: string;
  /** One-line explanation of what the source means (honesty marker). */
  sourceDetail: string;
}

/** The admin block — labels the server-derived `isAdmin`, never re-derives it. */
export interface AdminView {
  isAdmin: boolean;
  /** e.g. "Administrator" or "Standard user". */
  roleLabel: string;
  /** How `isAdmin` was derived (EDP-admin group membership). */
  derivation: string;
}

/** A read-only group membership, shown only when the session payload carries groups. */
export interface GroupView {
  id: string;
  label: string;
}

/** Expansion sections are honestly "not yet connected" until their backbone lands. */
export type ProfileSectionStatus = "not-connected";

/** One scaffolded expansion slot rendered as a clearly-labelled coming-soon state. */
export interface ProfileSectionView {
  id: string;
  label: string;
  description: string;
  status: ProfileSectionStatus;
  /** Constant UI label for the status, e.g. "Not yet connected". */
  statusLabel: string;
  /** Which backlog work wires this section up to real data. */
  wiredUpBy: string;
}

/** The complete view model the Profile screen renders. */
export interface ProfileViewModel {
  identity: IdentityView;
  admin: AdminView;
  /** Read-only group memberships; empty when the session payload carries none. */
  groups: GroupView[];
  hasGroups: boolean;
  /** The three scaffolded expansion slots, in display order. */
  sections: ProfileSectionView[];
}

/**
 * Future expansion inputs. Each is absent/`null` today, which drives its section
 * into the "not yet connected" state. They are typed as `unknown` on purpose:
 * this slice ships NO real access/waiver/request data (out of scope, issue #68),
 * and the presenter must never fabricate any.
 */
export interface ProfileInputs {
  user: UserProfile;
  /** Group memberships from the session payload, if present. Absent today. */
  groups?: GroupView[] | null;
  access?: unknown | null;
  waiver?: unknown | null;
  requests?: unknown | null;
}

/**
 * Principal ids that are NOT a real Databricks-forwarded identity:
 * - `dev-local-user` — the server's `DEV_FALLBACK_IDENTITY` (src/server/session.ts),
 *   returned in development when the platform forwards no signed-in user.
 * - the `seed-` prefix — the local-dev seed profile the memory adapter hands out
 *   when `/api/session` is unreachable (src/legacy/appData.js).
 *
 * Real SCIM account ids are opaque numeric/UUID strings and never match these,
 * so this is a safe, honest signal for the dev-fallback marker.
 */
export const DEV_FALLBACK_PRINCIPAL_ID = "dev-local-user";
const SEED_PRINCIPAL_PREFIX = "seed-";

/** True when a principal id is a known local/dev identity rather than a real forwarded one. */
export function isDevFallbackPrincipal(principalId: string): boolean {
  return principalId === DEV_FALLBACK_PRINCIPAL_ID || principalId.startsWith(SEED_PRINCIPAL_PREFIX);
}

/** Static definitions of the three expansion slots, in display order. */
const SECTION_DEFS: ReadonlyArray<
  Pick<ProfileSectionView, "id" | "label" | "description" | "wiredUpBy">
> = [
  {
    id: "access",
    label: "Access & permissions",
    description:
      "Grants and entitlements this principal holds across BEARS, SailPoint and Unity Catalog.",
    wiredUpBy: "#24 (request / provisioning store)",
  },
  {
    id: "waiver",
    label: "EIR stage",
    description:
      "Employee Identity Record (EIR) stage keyed to this principal, required for sensitive environments.",
    wiredUpBy: "#66 (attestation persistence)",
  },
  {
    id: "requests",
    label: "My requests",
    description:
      "This principal's onboarding / access requests, their lifecycle stage, and their service-level agreement (SLA) state.",
    wiredUpBy: "#24 / #25 (persistence backbone)",
  },
];

const NOT_CONNECTED_LABEL = "Not yet connected";

function presentIdentity(user: UserProfile): IdentityView {
  const isDevFallback = isDevFallbackPrincipal(user.principalId);
  return {
    displayName: user.name,
    email: user.email,
    principalId: user.principalId,
    isDevFallback,
    source: isDevFallback ? "local-dev-fallback" : "databricks-forwarded",
    sourceLabel: isDevFallback ? "Local dev fallback" : "Databricks-forwarded identity",
    sourceDetail: isDevFallback
      ? "Not a real Databricks-forwarded identity — a clearly-marked local development identity used when the platform forwards no signed-in user."
      : "Resolved server-side from your signed-in Databricks account.",
  };
}

function presentAdmin(user: UserProfile): AdminView {
  return {
    isAdmin: user.isAdmin,
    roleLabel: user.isAdmin ? "Administrator" : "Standard user",
    derivation: user.isAdmin
      ? "Server-derived from membership in the configured EDP-admin group."
      : "Server-derived: not a member of the configured EDP-admin group.",
  };
}

/** Every expansion section is honestly "not connected" this slice — never fabricated data. */
function presentSections(): ProfileSectionView[] {
  return SECTION_DEFS.map((def) => ({
    ...def,
    status: "not-connected",
    statusLabel: NOT_CONNECTED_LABEL,
  }));
}

/**
 * Map the resolved profile (+ future inputs) onto the view model the Profile
 * page renders. Pure: same inputs → same output, no I/O.
 */
export function presentProfile(inputs: ProfileInputs): ProfileViewModel {
  const { user } = inputs;
  const groups = inputs.groups ?? [];
  return {
    identity: presentIdentity(user),
    admin: presentAdmin(user),
    groups,
    hasGroups: groups.length > 0,
    sections: presentSections(),
  };
}
