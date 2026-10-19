/**
 * Who owns an onboarding request's initiative and datasets (#103, slice
 * 103-A), worked out the same way by both backends.
 *
 * Myself is the signed-in session, resolved by the server from SCIM `/Me`:
 * the browser sends only `{ kind: "self" }` (or `self: true` on a dataset
 * owner) and the server fills the name, email and principal itself. That is
 * what counts as verified. Someone else is a name and an email the provider
 * typed: the email is checked for format, stored normalised, and the owner is
 * not verified. Email is display and matching data, never an actor key, and
 * nothing here writes an email binding (ADR-0006).
 *
 * Every rule about an owner's verification lives here, so a later resolver
 * (staff matching in 103-B, owner resolution in code in #249) changes this
 * module and not the screens.
 */
import type {
  DatasetOwnerContact,
  InitiativeOwner,
  InitiativeOwnerChoice,
  OnboardingIntake,
  OwnerVerification,
} from "./types.ts";

/** The signed-in person Myself resolves to, from the server-resolved session. */
export interface OwnerSession {
  principalId: string;
  name: string;
  email: string;
}

/** An email as owners are stored and compared: trimmed, lower-case (ADR-0006 decision 1). */
export function normalizeOwnerEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * The initiative owner answer, with only the fields its kind takes: anything
 * else the browser put on it (a principal, a name on Myself) is dropped.
 * Undefined when there's no answer.
 */
export function normalizeInitiativeOwner(
  choice: InitiativeOwnerChoice | undefined,
): InitiativeOwnerChoice | undefined {
  if (choice?.kind === "self") return { kind: "self" };
  if (choice?.kind === "someone-else") {
    return {
      kind: "someone-else",
      name: typeof choice.name === "string" ? choice.name.trim() : "",
      email: normalizeOwnerEmail(choice.email),
    };
  }
  return undefined;
}

/** The initiative owner to store for an answer: Myself from the session, Someone else as typed. */
export function initiativeOwnerFor(
  choice: InitiativeOwnerChoice | undefined,
  session: OwnerSession,
): InitiativeOwner | null {
  const owner = normalizeInitiativeOwner(choice);
  if (!owner) return null;
  return owner.kind === "self"
    ? {
        kind: "self",
        name: session.name,
        email: normalizeOwnerEmail(session.email),
        principalId: session.principalId,
        verification: "verified",
      }
    : { ...owner, principalId: null, verification: "not-verified" };
}

/** The answer a stored initiative owner reads back as, so a resubmission can send it again. */
export function initiativeOwnerChoice(
  owner: InitiativeOwner | null,
): InitiativeOwnerChoice | undefined {
  if (!owner) return undefined;
  return owner.kind === "self"
    ? { kind: "self" }
    : { kind: "someone-else", name: owner.name, email: owner.email };
}

/** A dataset owner contact with Myself filled in from the session; any other is left as given. */
export function withSessionOwner(
  owner: DatasetOwnerContact,
  session: OwnerSession,
): DatasetOwnerContact {
  if (owner.self !== true) {
    const { self: _self, ...contact } = owner;
    return contact;
  }
  return {
    ...(owner.id ? { id: owner.id } : {}),
    self: true,
    name: session.name,
    email: normalizeOwnerEmail(session.email),
  };
}

/** The intake with every dataset owner picked as Myself filled in from the session. */
export function withSessionOwners(
  intake: OnboardingIntake,
  session: OwnerSession,
): OnboardingIntake {
  return {
    ...intake,
    datasets: intake.datasets.map((dataset) => ({
      ...dataset,
      owners: dataset.owners.map((owner) => withSessionOwner(owner, session)),
    })),
  };
}

/** The principal a dataset owner contact is stored with: the session's for Myself, else none. */
export function ownerPrincipalId(owner: DatasetOwnerContact, session: OwnerSession): string | null {
  return owner.self === true ? session.principalId : null;
}

/**
 * A stored dataset owner's verification: verified when its principal is the
 * provider's own, which only Myself sets.
 */
export function ownerVerificationFor(
  principalId: string | null | undefined,
  providerId: string,
): OwnerVerification {
  return principalId && principalId === providerId ? "verified" : "not-verified";
}

/** Each dataset owner contact's verification, by its ID, for an intake whose Myself owners carry `self`. */
export function ownerVerificationOf(intake: OnboardingIntake): Record<string, OwnerVerification> {
  return Object.fromEntries(
    intake.datasets.flatMap((dataset) =>
      dataset.owners.flatMap((owner) =>
        owner.id ? [[owner.id, owner.self === true ? "verified" : "not-verified"] as const] : [],
      ),
    ),
  );
}

/** The initiative owner as the change record and the intake package name it. */
export function initiativeOwnerText(
  owner: InitiativeOwner | InitiativeOwnerChoice | null | undefined,
): string {
  if (!owner) return "";
  if (owner.kind === "self") {
    return "name" in owner ? `Myself (${owner.name}, ${owner.email})` : "Myself";
  }
  return `${owner.name.trim()} (${normalizeOwnerEmail(owner.email)})`;
}
