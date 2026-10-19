/**
 * One role per person per dataset (ADR-0007 decision 11), as a pure decision
 * shared by the in-memory store (datasets/memory.ts) and the Delta commands
 * (src/server/delta/areas/teams.ts), so both enforce it identically.
 *
 * A person is matched by their normalised email, which is how every app-added
 * member is keyed. Adding a role a person already holds is an idempotent
 * repeat (records nothing); adding a *different* role is refused — a role
 * switch goes through change-member-role, not a second add — so a dataset
 * never holds two rows for the same person.
 */
import type { DatasetRoleName } from "./types";

export type MemberAddDecision =
  /** The person holds no role here yet: add it. */
  | { kind: "add" }
  /** The person already holds this exact role: a repeat that records nothing. */
  | { kind: "repeat" }
  /** The person already holds a different role: refuse; switch it instead. */
  | { kind: "role-taken"; held: DatasetRoleName };

/**
 * Decide what adding `role` means for a person who already holds `heldRoles`
 * on the dataset (the roles of every member row that matches their email).
 */
export function evaluateMemberAdd(
  heldRoles: readonly DatasetRoleName[],
  role: DatasetRoleName,
): MemberAddDecision {
  if (heldRoles.includes(role)) return { kind: "repeat" };
  const held = heldRoles[0];
  if (held !== undefined) return { kind: "role-taken", held };
  return { kind: "add" };
}

/** The refusal message both backends use when a second role is added to one person. */
export function roleTakenMessage(name: string, heldLabel: string, datasetName: string): string {
  return (
    `${name} already holds ${heldLabel} on ${datasetName}. A person can hold only one role on a ` +
    `dataset; change it with "change role" instead of adding a second.`
  );
}
