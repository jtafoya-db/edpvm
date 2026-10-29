import { normalizeEmail } from "../datasets/types";
import { isMembershipEntry, type ChangeListEntry, type MembershipEntry } from "./types";

function samePerson(a: MembershipEntry, b: MembershipEntry): boolean {
  const aId = a.target.person.principalId?.trim();
  const bId = b.target.person.principalId?.trim();
  if (aId && bId) return aId === bId;

  const aEmail = normalizeEmail(a.target.person.email ?? "");
  const bEmail = normalizeEmail(b.target.person.email ?? "");
  return Boolean(aEmail && bEmail && aEmail === bEmail);
}

function replaces(earlier: MembershipEntry, later: MembershipEntry): boolean {
  return (
    earlier.kind !== later.kind &&
    earlier.target.datasetId === later.target.datasetId &&
    earlier.target.group === later.target.group &&
    earlier.target.role === later.target.role &&
    samePerson(earlier, later)
  );
}

/** Add the immutable entries' derived supersession state, oldest first. */
export function applySupersession(entries: ChangeListEntry[]): ChangeListEntry[] {
  return entries.map((entry, index) => {
    if (entry.applied || !isMembershipEntry(entry)) return entry;
    const later = entries
      .slice(index + 1)
      .find(
        (candidate): candidate is ChangeListEntry & MembershipEntry =>
          isMembershipEntry(candidate) && replaces(entry, candidate),
      );
    return later ? { ...entry, supersededBy: later.id } : entry;
  });
}
