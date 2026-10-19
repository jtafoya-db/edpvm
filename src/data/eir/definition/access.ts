/**
 * Who may do what with EIR definitions (#201, ADR-0008). The server enforces
 * these on every staff command and read; the Safeguards workspace uses them
 * only to decide which controls to show.
 *
 * - **Author** (validate, preview, publish, activate): the Safeguards
 *   validator role, held in the MVP by the EDP admin group
 *   (`EDP_ADMIN_GROUP_ID`, #226).
 * - **Read** (published versions and activation history): EDP staff and the
 *   Safeguards role.
 */
interface Roles {
  isAdmin?: boolean;
  isSafeguardsValidator?: boolean;
}

export const canAuthorEirDefinitions = (user: Roles | null | undefined): boolean =>
  user?.isSafeguardsValidator === true;

export const canReadEirDefinitions = (user: Roles | null | undefined): boolean =>
  user?.isAdmin === true || canAuthorEirDefinitions(user);
