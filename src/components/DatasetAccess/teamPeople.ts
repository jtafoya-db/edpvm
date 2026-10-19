// The team page's people (#114): one row per person, with their role, whether
// they own the dataset, and where their latest change stands on the change list.
import type { ChangeListEntry } from "@/data/change-list/types";
import { memberRecord } from "@/data/datasets/queries";
import { ownerIsPerson } from "@/data/datasets/ownership";
import {
  DATASET_ROLES,
  personId,
  type Dataset,
  type DatasetMember,
  type DatasetRoleName,
  type PersonContact,
} from "@/data/datasets/types";
import { useSavesUnder, type SaveView } from "@/data/optimistic-save";

/** Where a person's latest change stands: applied (or none), or waiting on EDP staff. */
export type PersonStatus =
  | { kind: "active" }
  | { kind: "pending-add"; entry: ChangeListEntry }
  | { kind: "pending-removal"; entry: ChangeListEntry };

export interface TeamPerson {
  key: string;
  person: PersonContact;
  /** Every role they hold here, highest first. One, under ADR-0007 decision 11. */
  roles: DatasetRoleName[];
  /** The role row an edit acts on (the highest), or `null` for someone already removed. */
  member: DatasetMember | null;
  isOwner: boolean;
  status: PersonStatus;
}

const rank = (role: DatasetRoleName) => DATASET_ROLES.indexOf(role);

/**
 * The dataset's people, in the order the store lists them, then anyone whose
 * removal EDP staff haven't applied yet. Owners hold the manager role, so they
 * are already among the members.
 */
export function teamPeople(
  dataset: Dataset,
  members: DatasetMember[],
  entries: ChangeListEntry[],
): TeamPerson[] {
  const own = entries.filter((e) => e.target.datasetId === dataset.id);
  const entriesOf = (key: string) => own.filter((e) => personId(e.target.person) === key);
  const byPerson = new Map<string, DatasetMember[]>();
  for (const member of members) {
    const key = personId(member.person);
    byPerson.set(key, [...(byPerson.get(key) ?? []), member]);
  }

  const people: TeamPerson[] = [...byPerson].map(([key, rows]) => {
    const held = [...rows].sort((a, b) => rank(b.role) - rank(a.role));
    const roles = held.map((m) => m.role);
    // The latest add for a role they hold: a role change lists remove-old, then add-new.
    const add = entriesOf(key)
      .reverse()
      .find((e) => e.kind === "add-member" && roles.includes(e.target.role));
    return {
      key,
      person: held[0]!.person,
      roles,
      member: held[0]!,
      isOwner: dataset.owners.some((o) => ownerIsPerson(o, held[0]!.person)),
      status: add && !add.applied ? { kind: "pending-add", entry: add } : { kind: "active" },
    };
  });

  const removed = new Map<string, ChangeListEntry>();
  for (const entry of own) {
    const key = personId(entry.target.person);
    if (byPerson.has(key)) continue;
    if (entry.kind === "remove-member") removed.set(key, entry);
    else removed.delete(key);
  }
  for (const [key, entry] of removed) {
    if (entry.applied) continue;
    people.push({
      key,
      person: entry.target.person,
      roles: [entry.target.role],
      member: null,
      isOwner: false,
      status: { kind: "pending-removal", entry },
    });
  }
  return people;
}

/** The KPI card filters: everyone, one role, or the people with a change waiting. */
export type TeamFilter = "everyone" | DatasetRoleName | "pending";

/** The unresolved save on a person's row: their own role, or the role an edit is moving it to. */
export function useRowSaves(datasetId: string) {
  const saves = useSavesUnder(`member:${datasetId}:`);
  return (person: TeamPerson): SaveView | undefined => {
    if (!person.member) return undefined;
    const key = memberRecord(datasetId, person.member.person.email, person.member.role);
    return [...saves]
      .reverse()
      .find(
        (save) =>
          (save.state === "saving" || save.state === "unconfirmed") &&
          (save.record === key ||
            (save.action === "edit-role" &&
              memberRecord(
                datasetId,
                (save.input as { email: string }).email,
                (save.input as { newRole: string }).newRole,
              ) === key)),
      );
  };
}

/** Whether a person's row shows under a filter. */
export function matchesFilter(
  person: TeamPerson,
  filter: TeamFilter,
  save: SaveView | undefined,
): boolean {
  if (filter === "everyone") return true;
  if (filter === "pending") return Boolean(save) || person.status.kind !== "active";
  if (!person.member) return false;
  return person.roles.includes(filter) || (filter === "manager" && person.isOwner);
}
