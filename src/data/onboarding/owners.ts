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
 * EDP staff match an owner who isn't Myself by entering the principal they
 * found by hand (103-B), or mark them not a Databricks user yet. A staff
 * match is recorded as entered by staff and not verified: the app has no user
 * directory to check it against, and it writes no ADR-0006 email binding.
 *
 * Every rule about an owner's verification and match lives here, both
 * backends call it, so a later resolver (owner resolution in code from a user
 * directory, #249) replaces this module's staff-match rules and not the
 * stores or the screens.
 */
import type {
  DatasetOwnerContact,
  InitiativeOwner,
  InitiativeOwnerChoice,
  OnboardingIntake,
  OnboardingOwnerMatch,
  OnboardingRequestStage,
  OwnerMatchedBy,
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
 * A stored owner's verification: verified when Myself set its principal,
 * never when staff entered it. A row from before staff matching has no
 * source; then only Myself could have stored the provider's own principal.
 */
export function ownerVerificationFor(
  principalId: string | null | undefined,
  providerId: string,
  source?: OwnerMatchSource | null,
): OwnerVerification {
  return matchSourceFor(principalId, providerId, source) === "self" ? "verified" : "not-verified";
}

// ---- staff matching (103-B) -------------------------------------------------

/** The owner ID that stands for the initiative owner; a dataset owner contact has its own. */
export const INITIATIVE_OWNER_ID = "initiative";

/** How an owner's principal was recorded: Myself (`self`) or entered by EDP staff (`staff`). */
export type OwnerMatchSource = "self" | "staff";

/** An owner's match as a store keeps it. Nothing set is an unmatched owner. */
export interface OwnerMatchRecord {
  principalId: string | null;
  source: OwnerMatchSource | null;
  /** Who entered a staff match, and when; null for Myself and for no match. */
  by: { principalId: string; name: string; at: string } | null;
}

export const NO_MATCH: OwnerMatchRecord = { principalId: null, source: null, by: null };

/** The match Myself stores: the signed-in session's principal. */
export function selfMatch(session: Pick<OwnerSession, "principalId">): OwnerMatchRecord {
  return { principalId: session.principalId, source: "self", by: null };
}

/** A stored match's source, reading a row from before staff matching (no source) as Myself. */
export function matchSourceFor(
  principalId: string | null | undefined,
  providerId: string,
  source: OwnerMatchSource | null | undefined,
): OwnerMatchSource | null {
  if (!principalId) return null;
  if (source) return source;
  return principalId === providerId ? "self" : null;
}

/** A refusal both backends give with the same code; `status` is the HTTP status on Delta. */
export interface OwnerMatchProblem {
  code: string;
  message: string;
  status: 400 | 404 | 409;
}

/**
 * Databricks principal IDs are numeric (GovCloud `/Me` included, #143), so a
 * staff-entered one is digits only, at most 20 of them. That's a format check,
 * not a check that the ID is a workspace user: the app can't read a directory.
 */
const PRINCIPAL_ID = /^[0-9]{1,20}$/;

/** Whether a staff-entered principal ID (trimmed) has the format a Databricks principal ID has. */
export function isPrincipalIdFormat(value: string): boolean {
  return PRINCIPAL_ID.test(value.trim());
}

/** A staff-entered principal ID as stored: trimmed. */
export function normalizePrincipalId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Staff can match owners and request onboarding while a request is at a review stage. */
export function ownerMatchStageOpen(stage: OnboardingRequestStage): boolean {
  return stage === "business-roi-review" || stage === "ccb";
}

/** One owner a staff match or onboarding request can name, as either store has it. */
export interface OwnerMatchSubject {
  ownerId: string;
  role: OnboardingOwnerMatch["role"];
  datasetId: string | null;
  name: string;
  email: string;
  match: OwnerMatchRecord;
}

/** Why staff can't match this owner to this principal, or null when they can. */
export function staffMatchProblem(
  subject: OwnerMatchSubject | undefined,
  principalId: string,
): OwnerMatchProblem | null {
  if (!subject) return OWNER_NOT_FOUND;
  if (subject.match.source === "self") return OWNER_VERIFIED;
  if (!isPrincipalIdFormat(principalId)) {
    return {
      code: "invalid-principal-id",
      message: "A Databricks principal ID is digits only, up to 20 of them.",
      status: 400,
    };
  }
  return null;
}

/** Why staff can't request onboarding for this owner, or null when they can. */
export function onboardingRequestProblem(
  subject: OwnerMatchSubject | undefined,
): OwnerMatchProblem | null {
  if (!subject) return OWNER_NOT_FOUND;
  if (subject.match.source === "self") return OWNER_VERIFIED;
  if (subject.match.principalId) {
    return {
      code: "owner-matched",
      message: `${subject.name} is already matched to a Databricks principal.`,
      status: 409,
    };
  }
  return null;
}

const OWNER_NOT_FOUND: OwnerMatchProblem = {
  code: "owner-not-found",
  message: "That owner isn't on this onboarding request.",
  status: 404,
};
const OWNER_VERIFIED: OwnerMatchProblem = {
  code: "owner-verified",
  message: "This owner is the provider's own signed-in account (Myself); there's nothing to match.",
  status: 409,
};

/** A staff match as stored. */
export function staffMatch(
  principalId: string,
  staff: { principalId: string; name: string },
  at: string,
): OwnerMatchRecord {
  return {
    principalId,
    source: "staff",
    by: { principalId: staff.principalId, name: staff.name, at },
  };
}

/**
 * The match a kept owner carries through a resubmission: Myself from the
 * session; a staff match while the provider leaves the owner's email as it
 * was; otherwise none, since a changed email is a different person.
 */
export function resubmittedMatch(
  stored: { email: string; match: OwnerMatchRecord } | undefined,
  next: { email: string; self: boolean },
  session: Pick<OwnerSession, "principalId">,
): OwnerMatchRecord {
  if (next.self) return selfMatch(session);
  if (
    stored?.match.source === "staff" &&
    normalizeOwnerEmail(stored.email) === normalizeOwnerEmail(next.email)
  ) {
    return stored.match;
  }
  return NO_MATCH;
}

/** The pending onboard-user entries a match read needs: each one's ID and person's email. */
export interface PendingOnboarding {
  entryId: string;
  email: string;
}

/**
 * Every owner with their match state: matched when a principal is recorded;
 * else onboarding requested when an onboard-user entry for their email is
 * pending; else unmatched.
 */
export function ownerMatchesFor(
  subjects: readonly OwnerMatchSubject[],
  pending: readonly PendingOnboarding[],
): OnboardingOwnerMatch[] {
  return subjects.map((subject) => {
    const email = normalizeOwnerEmail(subject.email);
    const matched = Boolean(subject.match.principalId);
    const entry = matched ? undefined : pending.find((item) => item.email === email);
    const by = subject.match.by;
    const matchedBy: OwnerMatchedBy | null = !matched
      ? null
      : subject.match.source === "staff" && by
        ? { kind: "staff", principalId: by.principalId, name: by.name, at: by.at }
        : { kind: "self" };
    return {
      ownerId: subject.ownerId,
      role: subject.role,
      datasetId: subject.datasetId,
      name: subject.name,
      email,
      state: matched ? "matched" : entry ? "onboarding-requested" : "unmatched",
      principalId: matched ? subject.match.principalId : null,
      matchedBy,
      onboardingEntryId: entry?.entryId ?? null,
    };
  });
}

/**
 * A request as its provider reads it (tenant-app reads and the provider's own
 * writes): each owner's match state and whether it was Myself or EDP staff,
 * and nothing else. The principal staff entered, who entered it and when, and
 * the change-list entry stay on EDP staff's reads (#103, 103-B review).
 */
export function stateOnlyOwners<
  T extends { ownerMatches: OnboardingOwnerMatch[]; initiativeOwner: InitiativeOwner | null },
>(request: T): T {
  return {
    ...request,
    ownerMatches: request.ownerMatches.map((owner) => ({
      ...owner,
      principalId: null,
      matchedBy: owner.matchedBy ? { kind: owner.matchedBy.kind } : null,
      onboardingEntryId: null,
    })),
    // Myself's principal is the provider's own; a staff-entered one isn't theirs to read.
    initiativeOwner:
      request.initiativeOwner && request.initiativeOwner.kind !== "self"
        ? { ...request.initiativeOwner, principalId: null }
        : request.initiativeOwner,
  };
}

/** One dataset owner as standup (#89) reads it to create the dataset's ownership. */
export interface StandupOwner {
  datasetId: string;
  ownerEmail: string;
  /** The recorded principal; null while the owner is unmatched. */
  principalId: string | null;
  /** True for an unmatched owner: their dataset's ownership can't be created until they're matched. */
  blocking: boolean;
}

/** The dataset owners standup reads from a request: matched IDs, and the owners blocking it. */
export function ownersForStandup(request: {
  ownerMatches: readonly OnboardingOwnerMatch[];
}): StandupOwner[] {
  return request.ownerMatches
    .filter((owner) => owner.role === "dataset" && owner.datasetId)
    .map((owner) => ({
      datasetId: owner.datasetId!,
      ownerEmail: owner.email,
      principalId: owner.principalId,
      blocking: owner.principalId === null,
    }));
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
