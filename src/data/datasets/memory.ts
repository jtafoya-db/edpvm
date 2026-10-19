/**
 * In-memory implementation of the dataset, dataset-role and change-list
 * repositories. The memory adapter (adapters/memory.ts) mounts these on the
 * {@link DataStore}; state lasts for the session only, like the rest of it.
 *
 * Reads return clones and writes store clones, so callers can't alter state
 * except through a repository write.
 *
 * The seed loads on first use, because who owns the seeded dataset is
 * deployment configuration read from the server (see seed-config.ts). Group
 * names are checked against the loaded datasets then; a configuration that
 * makes names ambiguous rejects every call.
 */
import { reconcileMembership } from "../change-list/reconciler";
import type { ChangeListStore } from "../change-list/store";
import type { AddMemberEntry, ChangeListEntry } from "../change-list/types";
import type { UserProfile } from "../types";
import { ActionRefusedError } from "./errors";
import { validateGroupNames, validateGroupNaming, type GroupNamingConfig } from "./group-naming";
import { evaluateMemberAdd, roleTakenMessage } from "./membership";
import {
  canReadTeam,
  claimOwnership,
  isDatasetOwner,
  isViewersRow,
  type OwnerBindings,
  type TeamRowPerson,
} from "./ownership";
import { validateRoleDescriptions, type RoleDescriptions } from "./role-descriptions";
import type { DatasetRoleStore, DatasetStore } from "./store";
import { createMemoryTeamStore } from "./team-memory";
import type { DatasetTeamStore } from "./team-store";
import {
  DATASET_ROLES,
  INTAKE,
  isValidEmail,
  normalizeEmail,
  personId,
  type Dataset,
  type DatasetMember,
  type DatasetSeed,
  type DatasetWithMemberSummary,
  type Initiative,
} from "./types";

export interface MemoryAccessStoreConfig {
  /** Loads the seed. Called once, on first use. */
  loadSeed: () => Promise<DatasetSeed>;
  groupNaming: GroupNamingConfig;
  roleDescriptions: RoleDescriptions;
  /** Resolves the signed-in user; every write is attributed to them. */
  currentUser: () => Promise<UserProfile>;
  now: () => Date;
}

export interface MemoryAccessStores {
  datasets: DatasetStore;
  datasetRoles: DatasetRoleStore;
  datasetTeam: DatasetTeamStore;
  changeList: ChangeListStore;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryAccessStores(config: MemoryAccessStoreConfig): MemoryAccessStores {
  const naming = validateGroupNaming(clone(config.groupNaming));
  const roles = validateRoleDescriptions(clone(config.roleDescriptions));
  let loaded: Promise<{ initiatives: Initiative[]; datasets: Dataset[] }> | null = null;
  /** The seeded initiatives and datasets, loaded and checked once. */
  function seeded() {
    loaded ??= config.loadSeed().then((seed) => {
      const datasets = clone(seed.datasets);
      validateGroupNames(naming, datasets);
      // ADR-0005: every owner holds the manager role. Standup puts intake
      // owners in the manager group, outside the app, so the seed records
      // their role without listing it. An owner with no email is identified
      // by SCIM id.
      const at = config.now().toISOString();
      for (const dataset of datasets) {
        for (const owner of dataset.owners) {
          const person: DatasetMember["person"] = {
            name: owner.displayName,
            email: owner.email ?? "",
          };
          if (!owner.email && owner.principalId) person.principalId = owner.principalId;
          members.push({
            datasetId: dataset.id,
            person,
            role: "manager",
            addedBy: INTAKE,
            addedAt: at,
          });
        }
      }
      return { initiatives: clone(seed.initiatives), datasets };
    });
    return loaded;
  }
  const members: DatasetMember[] = [];
  const entries: ChangeListEntry[] = [];
  let nextEntry = 1;
  // ADR-0006: email → SCIM id bindings for owners added by email. Never deleted.
  const ownerBindings: OwnerBindings = new Map();
  const nextEntryId = () => `CL-${String(nextEntry++).padStart(4, "0")}`;

  async function summarizeDatasets(): Promise<DatasetWithMemberSummary[]> {
    const { datasets } = await seeded();
    const user = await config.currentUser();
    return clone(
      datasets.map((dataset) => {
        const datasetMembers = members.filter((m) => m.datasetId === dataset.id);
        const viewerRoles = datasetMembers
          .filter((m) => isViewersRow(m.person, user))
          .map((m) => m.role);
        // #257: the counts are the team's size, so only those who may see the team get them.
        if (!canReadTeam(dataset, user, ownerBindings)) {
          return {
            ...dataset,
            memberSummary: { totalMembers: null, roleCounts: null, viewerRoles },
          };
        }
        const roleCounts = Object.fromEntries(DATASET_ROLES.map((role) => [role, 0])) as Record<
          (typeof DATASET_ROLES)[number],
          number
        >;
        for (const member of datasetMembers) roleCounts[member.role] += 1;
        return {
          ...dataset,
          memberSummary: {
            totalMembers: new Set(datasetMembers.map((m) => personId(m.person))).size,
            roleCounts,
            viewerRoles,
          },
        };
      }),
    );
  }

  /**
   * Which of one dataset's team rows the signed-in user may read (#257): all
   * of them for its owners and EDP staff, otherwise only their own.
   */
  async function teamScope(datasetId: string): Promise<(person: TeamRowPerson) => boolean> {
    const { datasets } = await seeded();
    const user = await config.currentUser();
    const dataset = datasets.find((d) => d.id === datasetId);
    if (dataset && canReadTeam(dataset, user, ownerBindings)) return () => true;
    return (person) => isViewersRow(person, user);
  }

  /** The signed-in user's SCIM id. Refuses an identity with no stable id. */
  async function actor(): Promise<UserProfile> {
    const user = await config.currentUser();
    if (!user.principalId) {
      throw new ActionRefusedError("invalid", "The signed-in user has no SCIM principal id.");
    }
    return user;
  }

  const datasetStore: DatasetStore = {
    listInitiatives: async () => clone((await seeded()).initiatives),
    listDatasets: async () => clone((await seeded()).datasets),
    listDatasetSummaries: summarizeDatasets,
    getDataset: async (id) => clone((await seeded()).datasets.find((d) => d.id === id)),
    claimOwnership: async (id) => {
      const { datasets } = await seeded();
      const dataset = datasets.find((candidate) => candidate.id === id);
      if (!dataset) throw new ActionRefusedError("not-found", `No dataset ${id}.`);
      const user = await actor();
      return claimOwnership(dataset, user, ownerBindings, datasets, () =>
        config.now().toISOString(),
      );
    },
  };

  const datasetRoles: DatasetRoleStore = {
    listMembers: async (datasetId) => {
      const visible = await teamScope(datasetId);
      return clone(members.filter((m) => m.datasetId === datasetId && visible(m.person)));
    },
    addMember: async (input) => {
      const { initiatives, datasets } = await seeded();
      const name = input.name.trim();
      if (!name) {
        throw new ActionRefusedError("invalid", "Enter the name of the person to add.");
      }
      const email = normalizeEmail(input.email);
      if (!isValidEmail(email)) {
        throw new ActionRefusedError(
          "invalid",
          `Enter an email address in the format name@example.gov (got ${JSON.stringify(input.email.trim())}).`,
        );
      }
      if (!(DATASET_ROLES as readonly string[]).includes(input.role)) {
        throw new ActionRefusedError(
          "invalid",
          `Unknown dataset role ${JSON.stringify(input.role)}; expected ${DATASET_ROLES.join(", ")}.`,
        );
      }
      const dataset = datasets.find((d) => d.id === input.datasetId);
      if (!dataset) {
        throw new ActionRefusedError("not-found", `No dataset ${input.datasetId}.`);
      }
      const user = await actor();
      if (
        !claimOwnership(dataset, user, ownerBindings, datasets, () => config.now().toISOString())
      ) {
        throw new ActionRefusedError(
          "not-owner",
          `Only an owner of ${dataset.name} can add people to it.`,
        );
      }
      const initiative = initiatives.find((i) => i.id === dataset.initiativeId);
      if (initiative?.stage !== "active") {
        throw new ActionRefusedError(
          "not-active",
          `${dataset.name} can't take members until its initiative is active.`,
        );
      }

      // One role per person per dataset (ADR-0007 decision 11): a repeat of
      // the role they hold records nothing, a different role is refused.
      const held = members.filter((m) => m.datasetId === dataset.id && m.person.email === email);
      const decision = evaluateMemberAdd(
        held.map((m) => m.role),
        input.role,
      );
      if (decision.kind === "role-taken") {
        throw new ActionRefusedError(
          "duplicate",
          roleTakenMessage(name, roles.roles[decision.held].label, dataset.name),
        );
      }
      // One action, one timestamp: the role and its entries share it.
      const at = config.now().toISOString();
      const existing = held.find((m) => m.role === input.role);
      const member: DatasetMember = existing ?? {
        datasetId: dataset.id,
        person: { name, email },
        role: input.role,
        addedBy: user.principalId,
        addedAt: at,
      };
      if (!existing) members.push(member);

      const created: AddMemberEntry[] = reconcileMembership({
        datasets,
        members: [member],
        naming,
        roles,
        actual: [],
        changeList: entries,
      }).map((m) => ({
        id: nextEntryId(),
        kind: "add-member",
        target: {
          group: m.group,
          person: m.person,
          datasetId: m.datasetId,
          role: m.role,
        },
        grants: m.grants,
        reason: m.reason,
        createdBy: user.principalId,
        createdAt: at,
        applied: null,
      }));
      entries.push(...created);

      return { member: clone(member), created: !existing, entries: clone(created) };
    },
    describeRoles: async () => clone(roles),
  };

  const changeList: ChangeListStore = {
    // EDP staff's work list. Anyone else sees only entries for datasets they
    // own (display match: a read never binds), as on Delta.
    listEntries: async () => {
      const { datasets } = await seeded();
      const user = await config.currentUser();
      if (user.isAdmin) return clone(entries);
      const owned = new Set(
        datasets.filter((d) => isDatasetOwner(d, user, ownerBindings)).map((d) => d.id),
      );
      return clone(entries.filter((e) => owned.has(e.target.datasetId)));
    },
    markApplied: async (entryId) => {
      await seeded();
      const user = await actor();
      if (!user.isAdmin) {
        throw new ActionRefusedError("not-edp-staff", "Only EDP staff can mark changes applied.");
      }
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) {
        throw new ActionRefusedError("not-found", `No change-list entry ${entryId}.`);
      }
      if (entry.applied) {
        throw new ActionRefusedError(
          "already-applied",
          `${entry.id} was already marked applied by ${entry.applied.by} at ${entry.applied.at}.`,
        );
      }
      entry.applied = { by: user.principalId, at: config.now().toISOString() };
      return clone(entry);
    },
  };

  const datasetTeam = createMemoryTeamStore({
    seeded,
    members,
    entries,
    nextEntryId,
    ownerBindings,
    actor,
    teamScope,
    naming,
    roles,
    now: config.now,
  });

  return { datasets: datasetStore, datasetRoles, datasetTeam, changeList };
}
