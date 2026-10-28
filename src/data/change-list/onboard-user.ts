/**
 * The `onboard-user` change-list entry (#103, slice 103-B): EDP staff marked
 * an onboarding request's owner "not a Databricks user yet", so someone has
 * to onboard that person before standup can make them an owner.
 *
 * It's manual-only work, like every standup step (ADR-0008 decision 4): no
 * Apply job may ever run it, and it is outside any Apply allowlist. It is
 * initiative-wide, not on a dataset, so only EDP staff list it.
 *
 * One pending entry per person: the desired state is "this email is a
 * Databricks user", so a second request for the same email (on this
 * onboarding request or another) reuses the pending entry instead of listing
 * it again (ADR-0005 decision 6). Once it's marked applied, a later request
 * lists a new one.
 *
 * The shape is the target-plus-reason form #263 generalises entries to: a
 * typed target (the person, and the initiative that named them), never
 * executable instructions.
 */
import type { PersonContact } from "../datasets/types";

/** Why an onboard-user entry exists: staff found an owner isn't a Databricks user yet. */
export interface OwnerNotADatabricksUserReason {
  kind: "owner-not-a-databricks-user";
  /** The onboarding request that named the owner (`ONB-…`). */
  onboardingRequestId: string;
  /** SCIM id of the EDP staff member who asked. */
  requestedBy: string;
  requestedAt: string;
}

/** Onboard one person as a Databricks user. By hand only. */
export interface OnboardUserEntry {
  id: string;
  kind: "onboard-user";
  target: {
    /** Whom to onboard: the name and normalised email the provider gave. */
    person: PersonContact;
    /** The initiative that named them, as the onboarding request had it when listed. */
    initiative: { onboardingRequestId: string; name: string };
  };
  reason: OwnerNotADatabricksUserReason;
  /** SCIM id of whoever's action created the entry. */
  createdBy: string;
  createdAt: string;
  /** `null` while pending; who marked it applied and when, once applied. */
  applied: { by: string; at: string } | null;
}

/** What a request for onboarding lists, before the store gives it an ID. */
export interface OnboardUserRequest {
  person: PersonContact;
  initiative: OnboardUserEntry["target"]["initiative"];
  requestedBy: string;
  requestedAt: string;
}

/**
 * The change list as the memory onboarding store reaches it: the one way it
 * lists onboard-user entries and reads which are pending. The memory adapter
 * hands it the change list EDP staff see, so both stay one list.
 */
export interface OnboardUserEntries {
  /** The pending entry for this person's email, or a new one listed now. */
  list(request: OnboardUserRequest): OnboardUserEntry;
  /** Every pending (not applied) onboard-user entry. */
  pending(): OnboardUserEntry[];
}

/** {@link OnboardUserEntries} over an in-memory entry list and its `CL-` numbering. */
export function memoryOnboardUserEntries(
  entries: { kind: string }[],
  nextEntryId: () => string,
): OnboardUserEntries {
  const pending = () =>
    entries.filter(
      (entry): entry is OnboardUserEntry =>
        entry.kind === "onboard-user" && !(entry as OnboardUserEntry).applied,
    );
  return {
    pending: () => structuredClone(pending()),
    list(request) {
      const existing = pending().find(
        (entry) => entry.target.person.email === request.person.email,
      );
      if (existing) return structuredClone(existing);
      const entry: OnboardUserEntry = {
        id: nextEntryId(),
        kind: "onboard-user",
        target: { person: { ...request.person }, initiative: { ...request.initiative } },
        reason: {
          kind: "owner-not-a-databricks-user",
          onboardingRequestId: request.initiative.onboardingRequestId,
          requestedBy: request.requestedBy,
          requestedAt: request.requestedAt,
        },
        createdBy: request.requestedBy,
        createdAt: request.requestedAt,
        applied: null,
      };
      entries.push(entry);
      return structuredClone(entry);
    },
  };
}

/**
 * The versioned target payload a stored onboard-user row carries
 * (`change_list_entries.target_payload`): typed data the server built, never
 * instructions.
 */
export interface OnboardUserPayload {
  v: 1;
  person: { name: string; email: string };
  initiative: { onboardingRequestId: string; name: string };
}

export function onboardUserPayload(target: OnboardUserEntry["target"]): OnboardUserPayload {
  return {
    v: 1,
    person: { name: target.person.name, email: target.person.email },
    initiative: {
      onboardingRequestId: target.initiative.onboardingRequestId,
      name: target.initiative.name,
    },
  };
}

/** A stored payload read back, refusing any shape this version doesn't write. */
export function parseOnboardUserPayload(json: string | null | undefined): OnboardUserPayload {
  const value = JSON.parse(json ?? "null") as Partial<OnboardUserPayload> | null;
  if (
    value?.v !== 1 ||
    typeof value.person?.name !== "string" ||
    typeof value.person.email !== "string" ||
    typeof value.initiative?.onboardingRequestId !== "string" ||
    typeof value.initiative.name !== "string"
  ) {
    throw new Error("An onboard-user change-list entry has a target this version can't read.");
  }
  return value as OnboardUserPayload;
}
