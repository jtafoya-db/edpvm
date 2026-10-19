// Who sees the EDP Admin page (#159), and which of its sections. This decides
// only what the UI shows: every action inside a section is still checked by the
// store and the server, exactly as it was on the screen's old route.
import type { UserProfile } from "@/data/types";
import { canReadEirDefinitions } from "@/data/eir/definition/access";

export type EdpAdminSectionId =
  | "business-office"
  | "ccb"
  | "eir"
  | "eir-definitions"
  | "change-list"
  | "owner-reassignment"
  | "intake-editor";

type Who = Pick<UserProfile, "isAdmin" | "isSafeguardsValidator" | "onboardingReviewerRoles">;

export interface EdpAdminSection {
  id: EdpAdminSectionId;
  label: string;
  ariaLabel?: string;
  /** Whether this person can act on the section (the role that gates it). */
  canAct: (user: Who) => boolean;
}

/** The sections, in the order the page lists them. */
export const EDP_ADMIN_SECTIONS: readonly EdpAdminSection[] = [
  {
    id: "business-office",
    label: "Business & ROI review",
    canAct: (u) => u.onboardingReviewerRoles?.includes("business-office") ?? false,
  },
  {
    id: "ccb",
    label: "CCB inbox",
    ariaLabel: "CCB inbox (Change Control Board)",
    canAct: (u) => u.onboardingReviewerRoles?.includes("ccb") ?? false,
  },
  { id: "eir", label: "EIR validation", canAct: (u) => u.isSafeguardsValidator === true },
  { id: "change-list", label: "Change list", canAct: (u) => u.isAdmin === true },
  { id: "owner-reassignment", label: "Owner reassignment", canAct: (u) => u.isAdmin === true },
  { id: "intake-editor", label: "Intake form editor", canAct: (u) => u.isAdmin === true },
  // Safeguards author; EDP staff see the history (#201).
  { id: "eir-definitions", label: "EIR definitions", canAct: (u) => canReadEirDefinitions(u) },
];

export const EDP_ADMIN_ROUTE = { name: "edp-admin", section: "edp-admin" } as const;

export const EDP_ADMIN_NAV_ITEM = {
  id: EDP_ADMIN_ROUTE.name,
  label: "EDP Admin",
  section: EDP_ADMIN_ROUTE.section,
  staffOnly: true,
} as const;

/** The sections this person can act on; empty for anyone who isn't EDP staff. */
export function visibleSections(user: Who | null | undefined): EdpAdminSection[] {
  return user ? EDP_ADMIN_SECTIONS.filter((section) => section.canAct(user)) : [];
}

/** EDP staff, business office, CCB or safeguards validators: anyone with a section. */
export function isEdpStaff(user: Who | null | undefined): boolean {
  return visibleSections(user).length > 0;
}

interface Route {
  name: string;
  params?: { id?: string };
}

/**
 * The EDP Admin section an old staff hash route now lives at, or `null` to
 * leave the route alone. `#review/<role>` always moves. `#change-list` moves
 * for EDP staff only: dataset owners still follow "See the change list" links
 * to the read-only list there.
 */
export function redirectToEdpAdmin(
  route: Route,
  user: Who | null | undefined,
): { name: typeof EDP_ADMIN_ROUTE.name; params: { id: EdpAdminSectionId } } | null {
  if (route.name === "review") {
    const id = route.params?.id === "ccb" ? "ccb" : "business-office";
    return { name: EDP_ADMIN_ROUTE.name, params: { id } };
  }
  if (route.name === "change-list" && user?.isAdmin === true) {
    return { name: EDP_ADMIN_ROUTE.name, params: { id: "change-list" } };
  }
  return null;
}
