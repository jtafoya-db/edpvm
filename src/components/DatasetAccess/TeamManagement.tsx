/**
 * Team management on the dataset team page (#87): an owner edits or removes
 * a member's role in the Edit access panel (#114) and manages owners. A role
 * grants a fixed set of access (role-descriptions.json); there's nothing to
 * set per member.
 * Every write goes through the store, which refuses what this screen hides.
 * Each surface lives in its own file; this re-exports them for the page.
 */
export { EditAccess } from "./MemberRolePanels";
export { OwnersPanel } from "./OwnersPanel";
export { TeamHistory } from "./TeamHistory";
