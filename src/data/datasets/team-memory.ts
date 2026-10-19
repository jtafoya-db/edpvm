/**
 * In-memory implementation of {@link DatasetTeamStore} (#87). It works on the
 * same members, change list and datasets as the repositories in memory.ts,
 * which hands it that state, so team management and direct adds always see
 * each other's writes.
 *
 * Reads return clones and writes store clones, as in memory.ts. One action
 * stamps one time on everything it records.
 */
import { reconcileMembership } from "../change-list/reconciler";
import { reconcileRemovals } from "../change-list/removals";
import type {
  DatasetOwnerAddedReason,
  DatasetOwnerRemovedReason,
  DatasetRoleChangedReason,
  DatasetRoleRemovedReason,
  RemoveMemberEntry,
} from "../change-list/team-entries";
import type { AddMemberEntry, ChangeListEntry } from "../change-list/types";
import type { UserProfile } from "../types";
import { ActionRefusedError } from "./errors";
import { datasetGroupName, type GroupNamingConfig } from "./group-naming";
import { roleTakenMessage } from "./membership";
import {
  applyBinding,
  claimOwnership,
  findSameOwner,
  ownerHasEmail,
  ownerIsPerson,
  ownerPerson,
  ownerKey,
  ownerPrincipalId,
  type OwnerBindings,
  type TeamRowPerson,
} from "./ownership";
import type { RoleDescriptions } from "./role-descriptions";
import type { DatasetTeamStore, TeamEvent } from "./team-store";
import {
  DATASET_ROLES,
  isValidEmail,
  normalizeEmail,
  type Dataset,
  type DatasetMember,
  type DatasetOwner,
  type DatasetRoleName,
  type Initiative,
} from "./types";

/** The state memory.ts shares with this store. Arrays are mutated in place. */
export interface MemoryTeamState {
  seeded: () => Promise<{ initiatives: Initiative[]; datasets: Dataset[] }>;
  members: DatasetMember[];
  entries: ChangeListEntry[];
  nextEntryId: () => string;
  /** Owner email bindings (ADR-0006): shared with memory.ts, never deleted. */
  ownerBindings: OwnerBindings;
  /** The signed-in user; refuses one with no SCIM id. */
  actor: () => Promise<UserProfile>;
  /** Which of a dataset's team rows the signed-in user may read (#257). */
  teamScope: (datasetId: string) => Promise<(person: TeamRowPerson) => boolean>;
  naming: GroupNamingConfig;
  roles: RoleDescriptions;
  now: () => Date;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryTeamStore(state: MemoryTeamState): DatasetTeamStore {
  const { members, entries, naming, roles } = state;
  const events: TeamEvent[] = [];

  const stamp = () => state.now().toISOString();

  async function load(datasetId: string) {
    const { initiatives, datasets } = await state.seeded();
    const dataset = datasets.find((d) => d.id === datasetId);
    if (!dataset) throw new ActionRefusedError("not-found", `No dataset ${datasetId}.`);
    const user = await state.actor();
    return { initiatives, datasets, dataset, user };
  }

  function claim(loaded: Awaited<ReturnType<typeof load>>): boolean {
    return claimOwnership(loaded.dataset, loaded.user, state.ownerBindings, loaded.datasets, stamp);
  }

  /** The dataset, if the signed-in user owns it. */
  async function asOwner(datasetId: string, action: string) {
    const loaded = await load(datasetId);
    if (!claim(loaded)) {
      throw new ActionRefusedError(
        "not-owner",
        `Only an owner of ${loaded.dataset.name} can ${action}.`,
      );
    }
    return loaded;
  }

  /** The dataset, if the signed-in user owns it or is EDP staff. */
  async function asOwnerOrStaff(datasetId: string, action: string) {
    const loaded = await load(datasetId);
    // The binding check runs for EDP staff too: staff can't act through an
    // owner email that's bound to someone else, and never rebind one.
    if (!claim(loaded) && !loaded.user.isAdmin) {
      throw new ActionRefusedError(
        "not-owner",
        `Only an owner of ${loaded.dataset.name}, or EDP staff, can ${action}.`,
      );
    }
    return loaded;
  }

  function requireActive(dataset: Dataset, initiatives: Initiative[]) {
    const initiative = initiatives.find((i) => i.id === dataset.initiativeId);
    if (initiative?.stage !== "active") {
      throw new ActionRefusedError(
        "not-active",
        `${dataset.name} can't change roles until its initiative is active.`,
      );
    }
  }

  function requireRole(role: string): asserts role is DatasetRoleName {
    if (!(DATASET_ROLES as readonly string[]).includes(role)) {
      throw new ActionRefusedError(
        "invalid",
        `Unknown dataset role ${JSON.stringify(role)}; expected ${DATASET_ROLES.join(", ")}.`,
      );
    }
  }

  function findMember(dataset: Dataset, email: string, role: DatasetRoleName): DatasetMember {
    const member = members.find(
      (m) => m.datasetId === dataset.id && m.person.email === email && m.role === role,
    );
    if (!member) {
      throw new ActionRefusedError(
        "not-found",
        `${email} doesn't hold ${roles.roles[role].label} on ${dataset.name}.`,
      );
    }
    return member;
  }

  /** ADR-0005: every dataset owner holds the manager role, so it can't be taken away. */
  function guardOwnerManager(dataset: Dataset, member: DatasetMember) {
    if (member.role === "manager" && dataset.owners.some((o) => ownerIsPerson(o, member.person))) {
      throw new ActionRefusedError(
        "owner-holds-manager",
        `${member.person.name} is an owner of ${dataset.name}, and every owner holds the manager role. ` +
          "Remove them as an owner first.",
      );
    }
  }

  function removeEntries(
    datasets: Dataset[],
    dataset: Dataset,
    reason: RemoveMemberEntry["reason"],
    user: UserProfile,
    at: string,
  ): RemoveMemberEntry[] {
    return reconcileRemovals({
      datasetId: dataset.id,
      datasets,
      members,
      naming,
      changeList: entries,
    }).map((target) => ({
      id: state.nextEntryId(),
      kind: "remove-member" as const,
      target: clone(target),
      grants: [...roles.roles[target.role].grants],
      reason: clone(reason),
      createdBy: user.principalId,
      createdAt: at,
      applied: null,
    }));
  }

  function addEntries(
    datasets: Dataset[],
    member: DatasetMember,
    reason: AddMemberEntry["reason"],
    user: UserProfile,
    at: string,
  ): AddMemberEntry[] {
    return reconcileMembership({
      datasets,
      members: [member],
      naming,
      roles,
      actual: [],
      changeList: entries,
    }).map((m) => ({
      id: state.nextEntryId(),
      kind: "add-member" as const,
      target: { group: m.group, person: clone(m.person), datasetId: m.datasetId, role: m.role },
      grants: [...m.grants],
      reason: clone(reason),
      createdBy: user.principalId,
      createdAt: at,
      applied: null,
    }));
  }

  /** Remove one role and work out its remove-member entry for the role's group. */
  function dropRole(
    datasets: Dataset[],
    dataset: Dataset,
    member: DatasetMember,
    reason: DatasetRoleRemovedReason | DatasetOwnerRemovedReason,
    user: UserProfile,
    at: string,
  ): ChangeListEntry[] {
    members.splice(members.indexOf(member), 1);
    return removeEntries(datasets, dataset, reason, user, at);
  }

  /**
   * Remove a former owner's manager role and always list its remove-member
   * entry, naming the person by email if known, else by SCIM id. The
   * membership may predate the app (standup), so the entry doesn't depend on
   * an add having been listed.
   */
  function dropOwnerManager(
    datasets: Dataset[],
    dataset: Dataset,
    owner: DatasetOwner,
    user: UserProfile,
    at: string,
  ): ChangeListEntry[] {
    const reason: DatasetOwnerRemovedReason = {
      kind: "dataset-owner-removed",
      datasetId: dataset.id,
      removedBy: user.principalId,
      removedAt: at,
    };
    const person: DatasetMember["person"] = { name: owner.displayName, email: owner.email ?? "" };
    if (!owner.email) person.principalId = ownerPrincipalId(owner, state.ownerBindings)!;
    const record = members.find(
      (m) => m.datasetId === dataset.id && m.role === "manager" && ownerIsPerson(owner, m.person),
    );
    if (record) members.splice(members.indexOf(record), 1);
    return [
      {
        id: state.nextEntryId(),
        kind: "remove-member",
        target: {
          group: datasetGroupName(naming, dataset, "manager"),
          person: clone(record?.person ?? person),
          datasetId: dataset.id,
          role: "manager",
        },
        grants: [...roles.roles.manager.grants],
        reason,
        createdBy: user.principalId,
        createdAt: at,
        applied: null,
      },
    ];
  }

  function record(event: TeamEvent, created: ChangeListEntry[]) {
    entries.push(...created);
    events.push(event);
    return clone(created);
  }

  return {
    changeMemberRole: async (input) => {
      const { initiatives, datasets, dataset, user } = await asOwner(
        input.datasetId,
        "change members' roles",
      );
      requireRole(input.role);
      requireRole(input.newRole);
      requireActive(dataset, initiatives);
      const member = findMember(dataset, normalizeEmail(input.email), input.role);
      if (input.newRole === input.role) {
        return { member: clone(member), changed: false, entries: [] };
      }
      guardOwnerManager(dataset, member);
      if (
        members.some(
          (m) =>
            m.datasetId === dataset.id &&
            m.person.email === member.person.email &&
            m.role === input.newRole,
        )
      ) {
        throw new ActionRefusedError(
          "duplicate",
          `${member.person.name} already holds ${roles.roles[input.newRole].label} on ${dataset.name}. ` +
            `Remove their ${roles.roles[input.role].label} role instead.`,
        );
      }

      const at = state.now().toISOString();
      member.role = input.newRole;
      member.roleChangedBy = user.principalId;
      member.roleChangedAt = at;
      const reason: DatasetRoleChangedReason = {
        kind: "dataset-role-changed",
        datasetId: dataset.id,
        from: input.role,
        to: input.newRole,
        changedBy: user.principalId,
        changedAt: at,
      };
      const created: ChangeListEntry[] = removeEntries(datasets, dataset, reason, user, at);
      created.push(...addEntries(datasets, member, reason, user, at));
      const listed = record(
        {
          datasetId: dataset.id,
          kind: "role-changed",
          person: clone(member.person),
          from: input.role,
          to: input.newRole,
          by: user.principalId,
          at,
          entryIds: created.map((e) => e.id),
        },
        created,
      );
      return { member: clone(member), changed: true, entries: listed };
    },

    removeMember: async (input) => {
      const { datasets, dataset, user } = await asOwner(input.datasetId, "remove members");
      requireRole(input.role);
      const member = findMember(dataset, normalizeEmail(input.email), input.role);
      guardOwnerManager(dataset, member);

      const at = state.now().toISOString();
      const reason: DatasetRoleRemovedReason = {
        kind: "dataset-role-removed",
        datasetId: dataset.id,
        role: member.role,
        removedBy: user.principalId,
        removedAt: at,
      };
      const created = dropRole(datasets, dataset, member, reason, user, at);
      const listed = record(
        {
          datasetId: dataset.id,
          kind: "member-removed",
          person: clone(member.person),
          role: member.role,
          by: user.principalId,
          at,
          entryIds: created.map((e) => e.id),
        },
        created,
      );
      return { removed: clone(member), entries: listed };
    },

    addOwner: async (input) => {
      const { datasets, dataset, user } = await asOwnerOrStaff(input.datasetId, "add owners");
      const name = input.name.trim();
      if (!name) throw new ActionRefusedError("invalid", "Enter the new owner's name.");
      const email = normalizeEmail(input.email);
      if (!isValidEmail(email)) {
        throw new ActionRefusedError(
          "invalid",
          `Enter an email address in the format name@example.gov (got ${JSON.stringify(input.email.trim())}).`,
        );
      }
      // One person, one owner record: the same email, or an email bound to
      // the SCIM id of someone who already owns the dataset (ADR-0006).
      const same = findSameOwner(dataset, { email }, state.ownerBindings);
      if (same) {
        throw new ActionRefusedError(
          "duplicate",
          same.email === email
            ? `${email} is already an owner of ${dataset.name}.`
            : `${email} is already an owner of ${dataset.name}, as ${same.displayName}.`,
        );
      }
      // One role per person per dataset (ADR-0007 decision 11): the owner's
      // manager role can't be a second role for someone who already holds one.
      const otherRole = members.find(
        (m) => m.datasetId === dataset.id && m.person.email === email && m.role !== "manager",
      );
      if (otherRole) {
        throw new ActionRefusedError(
          "duplicate",
          roleTakenMessage(name, roles.roles[otherRole.role].label, dataset.name),
        );
      }

      const at = state.now().toISOString();
      const owner: DatasetOwner = {
        displayName: name,
        email,
        addedBy: user.principalId,
        addedAt: at,
      };
      // A re-added email keeps its binding: only the SCIM id it's bound to can act (ADR-0006).
      applyBinding(owner, state.ownerBindings);
      dataset.owners.push(owner);
      // ADR-0005: every dataset owner holds the manager role on their dataset.
      let manager = members.find(
        (m) => m.datasetId === dataset.id && m.person.email === email && m.role === "manager",
      );
      if (!manager) {
        manager = {
          datasetId: dataset.id,
          person: { name, email },
          role: "manager",
          addedBy: user.principalId,
          addedAt: at,
        };
        members.push(manager);
      }
      const reason: DatasetOwnerAddedReason = {
        kind: "dataset-owner-added",
        datasetId: dataset.id,
        addedBy: user.principalId,
        addedAt: at,
      };
      const created = addEntries(datasets, manager, reason, user, at);
      const listed = record(
        {
          datasetId: dataset.id,
          kind: "owner-added",
          person: { name, email },
          by: user.principalId,
          at,
          entryIds: created.map((e) => e.id),
        },
        created,
      );
      return { dataset: clone(dataset), entries: listed };
    },

    removeOwner: async (input) => {
      const { datasets, dataset, user } = await asOwnerOrStaff(input.datasetId, "remove owners");
      const wanted = input.owner.trim();
      const index = dataset.owners.findIndex(
        (o) => ownerKey(o) === wanted || ownerHasEmail(o, normalizeEmail(wanted)),
      );
      if (index < 0) {
        throw new ActionRefusedError("not-found", `${wanted} isn't an owner of ${dataset.name}.`);
      }
      const owner = dataset.owners[index]!;
      // Remove the person, not just one record: a person on record twice (by
      // SCIM id and by an email bound to it) loses every record at once, and
      // counts once toward the last-owner rule.
      const person = ownerPerson(owner, state.ownerBindings);
      const records = dataset.owners.filter((o) => ownerPerson(o, state.ownerBindings) === person);
      const people = new Set(dataset.owners.map((o) => ownerPerson(o, state.ownerBindings)));
      if (people.size === 1) {
        throw new ActionRefusedError(
          "last-owner",
          `${owner.displayName} is the last owner of ${dataset.name}, and a dataset can't be left without one. ` +
            "Add another owner first.",
        );
      }

      if (records.some((o) => !o.email && !ownerPrincipalId(o, state.ownerBindings))) {
        throw new ActionRefusedError(
          "invalid",
          `${owner.displayName} has no email or SCIM id on record, so EDP staff couldn't act on ` +
            "removing them from the manager group. Ask EDP staff to fix the owner record first.",
        );
      }

      const at = state.now().toISOString();
      // The manager role comes with ownership, so it goes with it (ADR-0005),
      // for every owner, intake owners included. Their other roles stay, and
      // so does their email's SCIM binding (ADR-0006).
      const created: ChangeListEntry[] = [];
      for (const r of records) {
        dataset.owners.splice(dataset.owners.indexOf(r), 1);
        created.push(...dropOwnerManager(datasets, dataset, r, user, at));
      }
      const listed = record(
        {
          datasetId: dataset.id,
          kind: "owner-removed",
          person: { name: owner.displayName, email: owner.email ?? null },
          by: user.principalId,
          at,
          entryIds: created.map((e) => e.id),
        },
        created,
      );
      return { dataset: clone(dataset), entries: listed };
    },

    listTeamEvents: async (datasetId) => {
      const visible = await state.teamScope(datasetId);
      return clone(events.filter((e) => e.datasetId === datasetId && visible(e.person)));
    },
  };
}
