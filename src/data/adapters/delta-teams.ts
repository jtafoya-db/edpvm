/**
 * The dataset, dataset-role, team and change-list repositories on Delta
 * (#123): the {@link DataStore} seam over the server's `initiatives`,
 * `teams` and `change-list` reads and commands
 * (src/server/delta/areas/teams.ts).
 *
 * - **Same refusals as the memory store.** The server's codes are the
 *   {@link RefusalCode}s, raised here as {@link ActionRefusedError}.
 * - **Ownership is checked by the server, in the command (ADR-0006).** A
 *   team write is one request: no `teams/ownership` read first (#140). The
 *   command refuses a non-owner, and records a mismatch's refusal itself. An
 *   owner's first action is answered `claim-required`: the adapter binds the
 *   email (`teams/bind-email`) and resends the same key once. `claimOwnership`
 *   still reads `teams/ownership`, for callers that ask for it.
 * - **The version the screen read.** Reads remember each record's row ID and
 *   version; a write sends that version, so a change someone else made in
 *   between is refused ("This changed since you opened it").
 * - **One key per intent.** Screens may pass a browser-minted idempotency key
 *   for a confirmed save intent. Otherwise the adapter mints one for that call.
 */
import type { ChangeListStore } from "../change-list/store";
import type { AddMemberEntry, ChangeListEntry } from "../change-list/types";
import { ActionRefusedError, type RefusalCode } from "../datasets/errors";
import { ownerHasEmail, ownerKey } from "../datasets/ownership";
import type { RoleDescriptions } from "../datasets/role-descriptions";
import type { DatasetRoleStore, DatasetStore } from "../datasets/store";
import type { DatasetTeamStore, TeamEvent } from "../datasets/team-store";
import {
  DATASET_ROLES,
  isValidEmail,
  normalizeEmail,
  type Dataset,
  type DatasetMember,
  type DatasetWithMemberSummary,
  type Initiative,
} from "../datasets/types";
import { DeltaApiError, type DeltaApiTransport } from "./delta";
import type {
  MemberChangeWire,
  MemberRemovedWire,
  OwnerChangeWire,
  OwnershipStatus,
  RecordRef,
  WireDataset,
  WireDatasetWithMemberSummary,
  WireEntry,
  WireMember,
} from "./teams-wire";

const REFUSALS: readonly RefusalCode[] = [
  "not-owner",
  "not-edp-staff",
  "not-found",
  "not-active",
  "invalid",
  "already-applied",
  "superseded",
  "duplicate",
  "last-owner",
  "owner-holds-manager",
  "owner-mismatch",
];

export interface DeltaTeamStoresConfig {
  api: DeltaApiTransport;
  /** What each role grants: configuration, the same the server snapshots into entries. */
  roleDescriptions: RoleDescriptions;
  newKey?: () => string;
}

export interface DeltaTeamStores {
  datasets: DatasetStore;
  datasetRoles: DatasetRoleStore;
  datasetTeam: DatasetTeamStore;
  changeList: ChangeListStore;
}

/** Map a server refusal to the store's error; anything else is passed on. */
function refusal(error: unknown): unknown {
  if (error instanceof DeltaApiError && error.code === "idempotency-key-reused") {
    return new ActionRefusedError(
      "invalid",
      "This change was already submitted. Refresh to see the latest.",
    );
  }
  if (error instanceof DeltaApiError && (REFUSALS as readonly string[]).includes(error.code)) {
    return new ActionRefusedError(error.code as RefusalCode, error.message);
  }
  return error;
}

/** No answer at all, or an answer that says the outcome is open: safe to resend the same key. */
function resendable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof DeltaApiError &&
    (error.code === "outcome-unknown" || [502, 503, 504].includes(error.status))
  );
}

const strip = <T extends { ref: RecordRef }>({ ref: _ref, ...rest }: T): Omit<T, "ref"> => rest;
const stripDataset = ({ ref: _ref, owners, ...rest }: WireDataset): Dataset => ({
  ...rest,
  owners: owners.map(strip),
});
const stripDatasetSummary = ({
  ref: _ref,
  owners,
  ...rest
}: WireDatasetWithMemberSummary): DatasetWithMemberSummary => ({
  ...rest,
  owners: owners.map(strip),
});

const memberKey = (datasetId: string, email: string, role: string) =>
  `member\u0000${datasetId}\u0000${email}\u0000${role}`;

export function createDeltaTeamStores(config: DeltaTeamStoresConfig): DeltaTeamStores {
  const { api } = config;
  const newKey = config.newKey ?? (() => globalThis.crypto.randomUUID());
  /** Row ID and version of what a screen last read, by record. */
  const refs = new Map<string, RecordRef>();

  function rememberMember(member: WireMember) {
    refs.set(memberKey(member.datasetId, member.person.email, member.role), member.ref);
  }
  function rememberEntries(entries: WireEntry[]) {
    for (const entry of entries) refs.set(`entry\u0000${entry.id}`, entry.ref);
  }

  async function read<T>(area: string, name: string, query?: Record<string, string>): Promise<T> {
    try {
      return await api.read<T>(area, name, query);
    } catch (error) {
      throw refusal(error);
    }
  }

  async function command<T>(
    area: string,
    name: string,
    payload: unknown,
    expectedVersion = 0,
    idempotencyKey = newKey(),
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await api.command<{ result: T }>(area, name, {
          idempotencyKey,
          expectedVersion,
          payload,
        });
        return outcome.result;
      } catch (error) {
        if (attempt < 3 && resendable(error)) continue;
        throw refusal(error);
      }
    }
  }

  /**
   * A protected team command, sent straight away: the server checks ownership
   * inside the command (and records a mismatch itself), so there's no
   * ownership read first. That read cost a warehouse round trip on every team
   * write. The one thing the command can't do is an owner's first action,
   * which binds their email (ADR-0006) in its own commit: the server answers
   * `claim-required`, and this binds then resends the same key once.
   */
  async function ownerCommand<T>(
    datasetId: string,
    name: string,
    payload: unknown,
    expectedVersion = 0,
    idempotencyKey = newKey(),
  ): Promise<T> {
    try {
      return await command<T>("teams", name, payload, expectedVersion, idempotencyKey);
    } catch (error) {
      if (!(error instanceof DeltaApiError && error.code === "claim-required")) throw error;
      await command("teams", "bind-email", { datasetId });
      return command<T>("teams", name, payload, expectedVersion, idempotencyKey);
    }
  }

  /**
   * The memory store's claimOwnership: bind the session's email on its first
   * protected action, or record and refuse a mismatch. True for an owner.
   */
  async function claim(datasetId: string): Promise<boolean> {
    const { status, message } = await read<{ status: OwnershipStatus; message?: string }>(
      "teams",
      "ownership",
      { datasetId },
    );
    if (status === "bind") await command("teams", "bind-email", { datasetId });
    if (status === "mismatch") {
      await command("teams", "record-ownership-refusal", { datasetId });
      throw new ActionRefusedError(
        "owner-mismatch",
        message ?? "Ask EDP staff to check the ownership.",
      );
    }
    return status === "owner" || status === "bind";
  }

  async function listDatasets(query?: Record<string, string>): Promise<WireDataset[]> {
    const datasets = await read<WireDataset[]>("initiatives", "datasets", query);
    for (const dataset of datasets) {
      for (const owner of dataset.owners) refs.set(`owner\u0000${owner.ref.id}`, owner.ref);
    }
    return datasets;
  }

  async function listMembers(datasetId: string): Promise<WireMember[]> {
    const members = await read<WireMember[]>("teams", "members", { datasetId });
    for (const member of members) rememberMember(member);
    return members;
  }

  async function listDatasetSummaries(): Promise<WireDatasetWithMemberSummary[]> {
    const datasets = await read<WireDatasetWithMemberSummary[]>(
      "initiatives",
      "dataset-member-summaries",
    );
    for (const dataset of datasets) {
      for (const owner of dataset.owners) refs.set(`owner\u0000${owner.ref.id}`, owner.ref);
    }
    return datasets;
  }

  /** The version the screen read for one of a person's roles; a fresh read if it read none. */
  async function memberVersion(datasetId: string, email: string, role: string): Promise<number> {
    const key = memberKey(datasetId, normalizeEmail(email), role);
    if (!refs.has(key)) await listMembers(datasetId).catch(() => []);
    return refs.get(key)?.version ?? 0;
  }

  function memberResult(result: MemberChangeWire) {
    rememberMember(result.member);
    rememberEntries(result.entries);
    return {
      member: strip(result.member),
      entries: result.entries.map(strip) as ChangeListEntry[],
    };
  }

  function ownerResult(result: OwnerChangeWire) {
    for (const owner of result.dataset.owners) refs.set(`owner\u0000${owner.ref.id}`, owner.ref);
    rememberEntries(result.entries);
    return {
      dataset: stripDataset(result.dataset),
      entries: result.entries.map(strip) as ChangeListEntry[],
    };
  }

  async function listEntries(): Promise<WireEntry[]> {
    const entries = await read<WireEntry[]>("change-list", "entries");
    rememberEntries(entries);
    return entries;
  }

  const datasets: DatasetStore = {
    listInitiatives: () => read<Initiative[]>("initiatives", "initiatives"),
    listDatasets: async () => (await listDatasets()).map(stripDataset),
    listDatasetSummaries: async () => (await listDatasetSummaries()).map(stripDatasetSummary),
    getDataset: async (id) => {
      const [dataset] = await listDatasets({ id });
      return dataset ? stripDataset(dataset) : undefined;
    },
    claimOwnership: (datasetId) => claim(datasetId),
  };

  const datasetRoles: DatasetRoleStore = {
    listMembers: async (datasetId) => (await listMembers(datasetId)).map(strip),
    addMember: async (input) => {
      // The memory store's checks, in its order, so a bad add binds nothing.
      const name = input.name.trim();
      if (!name) throw new ActionRefusedError("invalid", "Enter the name of the person to add.");
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
      try {
        const result = await ownerCommand<MemberChangeWire>(
          input.datasetId,
          "add-member",
          {
            datasetId: input.datasetId,
            name,
            email,
            role: input.role,
          },
          0,
          input.idempotencyKey,
        );
        const { member, entries } = memberResult(result);
        return { member, created: true, entries: entries as AddMemberEntry[] };
      } catch (error) {
        if (!(error instanceof DeltaApiError && error.code === "already-holds-role")) throw error;
        // A repeat records nothing: answer with the role they already hold.
        const existing = (await listMembers(input.datasetId)).find(
          (m) => m.person.email === email && m.role === input.role,
        );
        if (!existing) throw error;
        return { member: strip(existing) as DatasetMember, created: false, entries: [] };
      }
    },
    describeRoles: async () => structuredClone(config.roleDescriptions),
  };

  const datasetTeam: DatasetTeamStore = {
    changeMemberRole: async (input) => {
      const expected = await memberVersion(input.datasetId, input.email, input.role);
      try {
        const result = await ownerCommand<MemberChangeWire>(
          input.datasetId,
          "change-member-role",
          {
            datasetId: input.datasetId,
            email: input.email,
            role: input.role,
            newRole: input.newRole,
          },
          expected,
          input.idempotencyKey,
        );
        refs.delete(memberKey(input.datasetId, normalizeEmail(input.email), input.role));
        return { ...memberResult(result), changed: true };
      } catch (error) {
        if (!(error instanceof DeltaApiError && error.code === "unchanged")) throw error;
        const member = (await listMembers(input.datasetId)).find(
          (m) => m.person.email === normalizeEmail(input.email) && m.role === input.role,
        );
        if (!member) throw error;
        return { member: strip(member) as DatasetMember, changed: false, entries: [] };
      }
    },
    removeMember: async (input) => {
      const expected = await memberVersion(input.datasetId, input.email, input.role);
      const result = await ownerCommand<MemberRemovedWire>(
        input.datasetId,
        "remove-member",
        { datasetId: input.datasetId, email: input.email, role: input.role },
        expected,
        input.idempotencyKey,
      );
      refs.delete(memberKey(input.datasetId, normalizeEmail(input.email), input.role));
      rememberEntries(result.entries);
      return {
        removed: strip(result.removed) as DatasetMember,
        entries: result.entries.map(strip) as ChangeListEntry[],
      };
    },
    addOwner: async (input) => {
      return ownerResult(
        await ownerCommand<OwnerChangeWire>(
          input.datasetId,
          "add-owner",
          {
            datasetId: input.datasetId,
            name: input.name,
            email: input.email,
          },
          0,
          input.idempotencyKey,
        ),
      );
    },
    removeOwner: async (input) => {
      // The named owner record's version, from the dataset as last read.
      const wanted = input.owner.trim();
      const [dataset] = await listDatasets({ id: input.datasetId }).catch(() => []);
      const owner = dataset?.owners.find(
        (o) => ownerKey(o) === wanted || ownerHasEmail(o, normalizeEmail(wanted)),
      );
      const expected = owner ? (refs.get(`owner\u0000${owner.ref.id}`)?.version ?? 0) : 0;
      return ownerResult(
        await ownerCommand<OwnerChangeWire>(
          input.datasetId,
          "remove-owner",
          { datasetId: input.datasetId, owner: input.owner },
          expected,
          input.idempotencyKey,
        ),
      );
    },
    listTeamEvents: (datasetId) => read<TeamEvent[]>("teams", "events", { datasetId }),
  };

  const changeList: ChangeListStore = {
    listEntries: async () => (await listEntries()).map(strip) as ChangeListEntry[],
    markApplied: async (entryId, options) => {
      if (!refs.has(`entry\u0000${entryId}`)) await listEntries().catch(() => []);
      const ref = refs.get(`entry\u0000${entryId}`);
      try {
        // An unknown entry still goes to the server, so a non-staff caller hears "EDP staff only" first.
        const entry = await command<WireEntry>(
          "change-list",
          "mark-applied",
          { entryId: ref?.id ?? "00000000-0000-4000-8000-000000000000" },
          ref?.version ?? 0,
          options?.idempotencyKey,
        );
        rememberEntries([entry]);
        return strip(entry) as ChangeListEntry;
      } catch (error) {
        if (error instanceof ActionRefusedError && error.code === "not-found") {
          throw new ActionRefusedError("not-found", `No change-list entry ${entryId}.`);
        }
        throw error;
      }
    },
  };

  return { datasets, datasetRoles, datasetTeam, changeList };
}
