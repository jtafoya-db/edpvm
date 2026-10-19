/**
 * Who owns a dataset (ADR-0005, ADR-0006), shared by the store and the screens.
 *
 * Owners named at intake are matched on the signed-in user's SCIM id. Owners
 * added in the app are named by email. An email is matched only against the
 * session's email, which the server resolves from SCIM
 * (src/server/identity.ts); no email a caller supplies is ever used.
 *
 * The first ownership-protected action a session takes through an email-added
 * owner binds that email to the session's SCIM id in the store's
 * {@link OwnerBindings}. A binding covers the email on every dataset and is
 * never deleted: removing the owner, re-adding them and EDP-staff
 * reassignment all reuse it. From then on rights follow the bound SCIM id,
 * and the same email under another SCIM id is refused and flagged. Rebinding
 * an email isn't supported (ADR-0006). Actions are always attributed to the
 * SCIM id. A member's dataset role, even manager, never makes someone an owner.
 *
 * Reads don't bind. Screens use the pure {@link isDatasetOwner} only to decide
 * what to show; the store decides what's allowed.
 */
import type { UserProfile } from "../types";
import { ActionRefusedError } from "./errors";
import { normalizeEmail, type Dataset, type DatasetOwner } from "./types";

type DisplaySession = {
  principalId: UserProfile["principalId"] | null | undefined;
  email: UserProfile["email"] | null | undefined;
};
type AuthenticatedSession = Pick<UserProfile, "principalId" | "email">;

/** An email bound to the SCIM id that first acted as an owner through it. */
export interface OwnerBinding {
  principalId: string;
  at: string;
}

/** Normalised email → binding. Entries are added, never removed or replaced. */
export type OwnerBindings = Map<string, OwnerBinding>;

/** How the signed-in user relates to one of the dataset's owners. */
export type OwnerMatch =
  /** Matched by SCIM id: named at intake, or a bound email. */
  | { kind: "principal"; owner: DatasetOwner }
  /** Matched by session email on an owner whose email isn't bound yet. */
  | { kind: "email"; owner: DatasetOwner }
  /** The session email matches an owner whose email is bound to another SCIM id. */
  | { kind: "mismatch"; owner: DatasetOwner }
  | { kind: "none" };

/**
 * The owner's SCIM id: from intake, or the binding of their email. Screens
 * pass no bindings and rely on the owner record, which the store keeps in
 * step with the binding.
 */
export function ownerPrincipalId(
  owner: DatasetOwner,
  bindings?: OwnerBindings,
): string | undefined {
  if (owner.principalId) return owner.principalId;
  const bound = owner.email ? bindings?.get(owner.email) : undefined;
  return bound?.principalId ?? (owner.matchedPrincipalId || undefined);
}

/** Match the session to an owner. Pure: binding is {@link claimOwnership}'s job. */
export function matchOwner(
  dataset: Pick<Dataset, "owners">,
  user: DisplaySession,
  bindings?: OwnerBindings,
): OwnerMatch {
  if (user.principalId) {
    const byId = dataset.owners.find((o) => ownerPrincipalId(o, bindings) === user.principalId);
    if (byId) return { kind: "principal", owner: byId };
  }
  const email = user.email ? normalizeEmail(user.email) : "";
  const byEmail = email ? dataset.owners.find((o) => o.email === email) : undefined;
  if (!byEmail) return { kind: "none" };
  return ownerPrincipalId(byEmail, bindings) === undefined
    ? { kind: "email", owner: byEmail }
    : { kind: "mismatch", owner: byEmail };
}

/** True when the signed-in user is one of the dataset's owners (no mismatch). For display. */
export function isDatasetOwner(
  dataset: Pick<Dataset, "owners">,
  user: DisplaySession,
  bindings?: OwnerBindings,
): boolean {
  const match = matchOwner(dataset, user, bindings);
  return match.kind === "principal" || match.kind === "email";
}

/** The person on a team row: a member's contact, or a team event's. */
export type TeamRowPerson = { email?: string | null; principalId?: string | null };

/**
 * Who may see a dataset's team (#257): its owners and EDP staff (decision of
 * 2026-10-18 on #115). Anyone else, whatever dataset role they hold, sees only
 * their own rows ({@link isViewersRow}) and no member counts. Like every read,
 * it matches owners without binding.
 */
export function canReadTeam(
  dataset: Pick<Dataset, "owners">,
  user: DisplaySession & { isAdmin: boolean },
  bindings?: OwnerBindings,
): boolean {
  return user.isAdmin || isDatasetOwner(dataset, user, bindings);
}

/**
 * True when a team row is the signed-in user's own: by SCIM id, or by the
 * session's email. A row with no person on record is no one's (fails closed).
 */
export function isViewersRow(
  person: TeamRowPerson | null | undefined,
  user: DisplaySession,
): boolean {
  if (!person) return false;
  if (user.principalId && person.principalId === user.principalId) return true;
  const email = user.email ? normalizeEmail(user.email) : "";
  return email !== "" && person.email === email;
}

/** Copy an existing binding of the owner's email onto the owner record. */
export function applyBinding(owner: DatasetOwner, bindings: OwnerBindings): void {
  const bound = owner.email ? bindings.get(owner.email) : undefined;
  if (bound) {
    owner.matchedPrincipalId = bound.principalId;
    owner.matchedAt = bound.at;
  }
}

/**
 * The store's ownership check, run before every ownership-protected action.
 *
 * - If the session's email is already bound to a different SCIM id, and this
 *   dataset has an owner record with that email, or the person it's bound to
 *   owns the dataset, or the session otherwise matches an owner, it refuses
 *   (`owner-mismatch`) and flags the record. That applies to EDP staff too.
 * - On any owner match, by SCIM id or by email, it binds the session's
 *   server-resolved email to the session's SCIM id if that email isn't bound
 *   yet, and copies the binding onto every owner record with that email, on
 *   every dataset. So a real owner's first action closes their email to
 *   anyone else, even if they're on record by SCIM id only.
 *
 * Returns whether the user is an owner. Mutates `datasets` and `bindings`.
 */
export function claimOwnership(
  dataset: Dataset,
  user: AuthenticatedSession,
  bindings: OwnerBindings,
  datasets: Dataset[],
  now: () => string,
): boolean {
  const claim = evaluateClaim(dataset, user, bindings);
  if (claim.kind === "mismatch") {
    if (claim.flagged) claim.flagged.mismatch = { principalId: user.principalId, at: now() };
    throw new ActionRefusedError("owner-mismatch", ownerMismatchMessage(dataset, user));
  }
  if (claim.kind === "none") return false;
  if (claim.bindEmail) {
    bindings.set(claim.bindEmail, { principalId: user.principalId, at: now() });
    for (const d of datasets) {
      for (const owner of d.owners)
        if (owner.email === claim.bindEmail) applyBinding(owner, bindings);
    }
  }
  return true;
}

/** What {@link claimOwnership} would do, without doing it. */
export type OwnershipClaim =
  /** Refused: the session's email is bound to someone else. `flagged` is the record to flag. */
  | { kind: "mismatch"; flagged: DatasetOwner | undefined }
  | { kind: "none" }
  /** An owner. `bindEmail` is the session email to bind first, if it isn't bound yet. */
  | { kind: "owner"; owner: DatasetOwner; bindEmail: string | undefined };

/**
 * The ADR-0006 rules behind {@link claimOwnership}, as a pure decision, so
 * the in-memory store and the Delta commands (src/server/delta/areas/teams.ts)
 * apply exactly the same ones.
 */
export function evaluateClaim(
  dataset: Pick<Dataset, "owners">,
  user: AuthenticatedSession,
  bindings: OwnerBindings,
): OwnershipClaim {
  const email = user.email ? normalizeEmail(user.email) : "";
  const match = matchOwner(dataset, user, bindings);
  const bound = email ? bindings.get(email) : undefined;
  if (bound && bound.principalId !== user.principalId) {
    // The email belongs to someone else. Refuse if it bears on this dataset:
    // a record with that email, the person it's bound to owns it, or the
    // session matches an owner some other way.
    const record =
      dataset.owners.find((o) => o.email === email) ??
      dataset.owners.find((o) => ownerPrincipalId(o, bindings) === bound.principalId);
    if (record || match.kind !== "none") {
      return { kind: "mismatch", flagged: record ?? ("owner" in match ? match.owner : undefined) };
    }
  }
  if (match.kind === "mismatch") return { kind: "mismatch", flagged: match.owner };
  if (match.kind === "none") return { kind: "none" };
  return { kind: "owner", owner: match.owner, bindEmail: email && !bound ? email : undefined };
}

/** Why a session whose email is bound to another SCIM id can't act as an owner. */
export function ownerMismatchMessage(
  dataset: Pick<Dataset, "name">,
  user: Pick<UserProfile, "email"> | { email: string | null | undefined },
): string {
  return (
    `${normalizeEmail(user.email ?? "")} is bound to a different account than the one you're signed ` +
    `in with, so it can't act as an owner of ${dataset.name}. Ask EDP staff to check the ownership.`
  );
}

/**
 * The owner record on this dataset that is the same person as `candidate`:
 * the same email, the same SCIM id, or an email bound to that SCIM id (in
 * either direction). One person, one owner record per dataset.
 */
export function findSameOwner(
  dataset: Pick<Dataset, "owners">,
  candidate: { email?: string; principalId?: string },
  bindings: OwnerBindings,
): DatasetOwner | undefined {
  const email = candidate.email ? normalizeEmail(candidate.email) : undefined;
  const principalId =
    candidate.principalId ?? (email ? bindings.get(email)?.principalId : undefined);
  return dataset.owners.find(
    (o) =>
      (email !== undefined && o.email === email) ||
      (principalId !== undefined && ownerPrincipalId(o, bindings) === principalId),
  );
}

/** Who an owner record stands for: their SCIM id if known, else their email, else their name. */
export function ownerPerson(owner: DatasetOwner, bindings: OwnerBindings): string {
  const principalId = ownerPrincipalId(owner, bindings);
  if (principalId) return `scim:${principalId}`;
  return owner.email ? `email:${owner.email}` : `name:${owner.displayName}`;
}

/**
 * The id an owner is removed by: their SCIM id if known (named or bound),
 * otherwise their email, otherwise (a record with neither) their name.
 */
export function ownerKey(owner: DatasetOwner): string {
  return owner.principalId ?? owner.matchedPrincipalId ?? owner.email ?? owner.displayName;
}

/** True when this owner is this member's person: same email, or same SCIM id for an intake owner. */
export function ownerIsPerson(
  owner: DatasetOwner,
  person: { email: string; principalId?: string },
): boolean {
  if (person.email) return ownerHasEmail(owner, person.email);
  return person.principalId !== undefined && owner.principalId === person.principalId;
}

/** True when this owner is the person with this (normalised) email. */
export function ownerHasEmail(owner: DatasetOwner, email: string): boolean {
  return owner.email !== undefined && owner.email === email;
}
