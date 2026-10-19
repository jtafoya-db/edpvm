/**
 * In-memory implementation of the access-request repository, mounted next to
 * the dataset repositories by default-stores.ts. State lasts for the session
 * only; the capability registry declares that as `access-request-persistence`.
 *
 * Approval doesn't record anything itself: it calls the dataset-role store's
 * direct add as the approving owner, so the role, its change-list entry and
 * every refusal (not an owner, initiative not active) are exactly a direct
 * add's.
 */
import { ActionRefusedError } from "../datasets/errors";
import { isDatasetOwner } from "../datasets/ownership";
import type { DatasetRoleStore, DatasetStore } from "../datasets/store";
import { isValidEmail, normalizeEmail, type Dataset } from "../datasets/types";
import { newDisplayCode } from "../display-codes";
import type { UserProfile } from "../types";
import { validateAccessRequestConfig, type AccessRequestConfig } from "./config";
import { samePrincipal } from "./ownership";
import { accessRequestSla } from "./sla";
import type { HolidayCalendar } from "../sla";
import type { AccessRequestStore } from "./store";
import type { DatasetAccessRequest } from "./types";

export interface MemoryAccessRequestStoreConfig {
  datasets: DatasetStore;
  datasetRoles: DatasetRoleStore;
  /** Resolves the signed-in user; every action is attributed to them. */
  currentUser: () => Promise<UserProfile>;
  now: () => Date;
  /** Requestable roles and the SLA target (access-request-config.json). */
  settings: AccessRequestConfig;
  /** Draws a new request's ID; a random display code (`AR-7K3QFD`) by default. */
  newRequestId?: () => string;
  holidays?: HolidayCalendar;
  /** Open requests to start from (sample data; see seed.ts). */
  seed?: SeededAccessRequest[];
}

/** An open request as seeded: the store assigns its id and status. */
export type SeededAccessRequest = Pick<
  DatasetAccessRequest,
  "datasetId" | "role" | "reason" | "requester" | "requestedAt"
>;

/** Stored without `sla`, which depends on when it's read. */
type StoredRequest = Omit<DatasetAccessRequest, "sla">;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryAccessRequestStore(
  config: MemoryAccessRequestStoreConfig,
): AccessRequestStore {
  const settings = validateAccessRequestConfig(clone(config.settings));
  // A display code, as on Delta once access requests move there (#124;
  // ADR-0007 decision 2, amended 2026-10-10). Unique in this store.
  const issued = new Set<string>();
  const nextId = (): string => {
    const id = (config.newRequestId ?? (() => newDisplayCode("AR")))();
    if (issued.has(id)) return nextId();
    issued.add(id);
    return id;
  };
  const requests: StoredRequest[] = (config.seed ?? []).map((seeded) => ({
    ...clone(seeded),
    id: nextId(),
    status: "requested",
    outcome: null,
    changeListEntryIds: [],
  }));

  async function actor(): Promise<UserProfile> {
    const user = await config.currentUser();
    if (!user.principalId) {
      throw new ActionRefusedError("invalid", "The signed-in user has no SCIM principal id.");
    }
    return user;
  }

  function view(request: StoredRequest): DatasetAccessRequest {
    return {
      ...clone(request),
      sla:
        request.status === "requested"
          ? accessRequestSla(request.requestedAt, config.now(), settings.sla, config.holidays)
          : null,
    };
  }

  async function dataset(id: string): Promise<Dataset> {
    const found = await config.datasets.getDataset(id);
    if (!found) throw new ActionRefusedError("not-found", `No dataset ${id}.`);
    return found;
  }

  /** An open request the signed-in user owns the dataset for, and didn't make. */
  async function decidable(id: string) {
    const request = requests.find((r) => r.id === id);
    if (!request) throw new ActionRefusedError("not-found", `No access request ${id}.`);
    const user = await actor();
    const target = await dataset(request.datasetId);
    // Both repositories must resolve the same signed-in person from catalog.getUser();
    // the shared dataset store owns the binding and mismatch authorization.
    if (!(await config.datasets.claimOwnership(request.datasetId))) {
      throw new ActionRefusedError(
        "not-owner",
        `Only an owner of ${target.name} can decide requests for it.`,
      );
    }
    if (samePrincipal(request.requester.principalId, user.principalId)) {
      throw new ActionRefusedError("invalid", "You can't decide your own access request.");
    }
    if (request.status !== "requested") {
      throw new ActionRefusedError("invalid", `${request.id} is already ${request.status}.`);
    }
    return { request, user };
  }

  return {
    describeSettings: async () => clone(settings),

    listMine: async () => {
      const user = await actor();
      return requests
        .filter((r) => samePrincipal(r.requester.principalId, user.principalId))
        .reverse()
        .map(view);
    },

    listInbox: async () => {
      const user = await actor();
      const owned = new Set(
        (await config.datasets.listDatasets())
          .filter((d) => isDatasetOwner(d, user))
          .map((d) => d.id),
      );
      return requests.filter((r) => owned.has(r.datasetId)).map(view);
    },

    submit: async (input) => {
      const reason = input.reason.trim();
      if (!reason) {
        throw new ActionRefusedError("invalid", "Say why you need this role.");
      }
      if (!settings.requestableRoles.includes(input.role)) {
        throw new ActionRefusedError(
          "invalid",
          `You can't request ${JSON.stringify(input.role)}; you can ask for ${settings.requestableRoles.join(" or ")}. ${settings.nonRequestableNote}`.trim(),
        );
      }
      const target = await dataset(input.datasetId);
      const user = await actor();
      const email = normalizeEmail(user.email ?? "");
      if (!isValidEmail(email)) {
        throw new ActionRefusedError(
          "invalid",
          "Your signed-in account has no email address, and dataset roles are recorded by email.",
        );
      }
      if (isDatasetOwner(target, user)) {
        throw new ActionRefusedError(
          "invalid",
          `You own ${target.name}. Owners add people, themselves included, on its team page.`,
        );
      }
      const initiative = (await config.datasets.listInitiatives()).find(
        (i) => i.id === target.initiativeId,
      );
      if (initiative?.stage !== "active") {
        throw new ActionRefusedError(
          "not-active",
          `${target.name} can't take members until its initiative is active.`,
        );
      }
      const members = await config.datasetRoles.listMembers(target.id);
      if (members.some((m) => m.person.email === email && m.role === input.role)) {
        throw new ActionRefusedError(
          "invalid",
          `You already hold the ${input.role} role on ${target.name}.`,
        );
      }
      const open = requests.find(
        (r) =>
          samePrincipal(r.requester.principalId, user.principalId) &&
          r.datasetId === target.id &&
          r.role === input.role &&
          r.status === "requested",
      );
      if (open) {
        throw new ActionRefusedError(
          "invalid",
          `You already asked for ${input.role} on ${target.name} (${open.id}).`,
        );
      }

      const request: StoredRequest = {
        id: nextId(),
        datasetId: target.id,
        role: input.role,
        reason,
        requester: {
          principalId: user.principalId,
          name: user.name?.trim() || email,
          email,
        },
        status: "requested",
        requestedAt: config.now().toISOString(),
        outcome: null,
        changeListEntryIds: [],
      };
      requests.push(request);
      return view(request);
    },

    approve: async (id, options) => {
      const { request, user } = await decidable(id);
      // claimOwnership runs above and again in addMember. The operation is
      // idempotent, and the second check keeps the direct-add guard intact.
      const added = await config.datasetRoles.addMember({
        datasetId: request.datasetId,
        name: request.requester.name,
        email: request.requester.email,
        role: request.role,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      request.status = "active";
      request.outcome = {
        by: user.principalId,
        // A new add shares its timestamp with the request, so the two line up.
        at: added.created ? added.member.addedAt : config.now().toISOString(),
        note: null,
      };
      request.changeListEntryIds = added.entries.map((e) => e.id);
      return { request: view(request), added };
    },

    reject: async (id, note) => {
      const { request, user } = await decidable(id);
      request.status = "rejected";
      request.outcome = {
        by: user.principalId,
        at: config.now().toISOString(),
        note: note?.trim() || null,
      };
      return view(request);
    },

    withdraw: async (id) => {
      const user = await actor();
      // Someone else's request is reported as unknown rather than revealed.
      const request = requests.find(
        (r) => r.id === id && samePrincipal(r.requester.principalId, user.principalId),
      );
      if (!request) throw new ActionRefusedError("not-found", `No access request ${id}.`);
      if (request.status !== "requested") {
        throw new ActionRefusedError("invalid", `${request.id} is already ${request.status}.`);
      }
      request.status = "withdrawn";
      request.outcome = { by: user.principalId, at: config.now().toISOString(), note: null };
      return view(request);
    },
  };
}
