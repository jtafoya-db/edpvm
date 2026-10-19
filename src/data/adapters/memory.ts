/**
 * P1 in-memory adapter.
 *
 * A working implementation of the {@link DataStore} seam backed by a plain
 * snapshot of the prototype data (normally `window.AppData`, see
 * src/data/seed.ts). It lets the whole app run with no backend, and it is the
 * default the seam loads. Writes (createRequest) mutate an in-process copy so
 * a submitted request round-trips within the session; nothing is persisted
 * across reloads — that is the Delta adapter's job (adapters/delta.ts).
 *
 * Reads return CLONES and writes store CLONES, so a caller mutating a returned
 * object can never alter the store's state or the seed without going through a
 * repository write.
 */
import type { AppDataSnapshot } from "../types";
import type { AccessRequest, RequestStatus, WaiverAttestation } from "../types";
import type { CatalogStore, DataStore, RequestStore, StatusStore } from "../store";
import { fetchSessionProfile } from "../session";
import { createMemoryEirRepository, type EirClock, type EirRepository } from "../eir/repository";
import {
  createMemoryEirDefinitionRepository,
  eirDefinitionsForCurrentUser,
  memoryEirFormSource,
  type EirDefinitionRepository,
  type EirFormSource,
} from "../eir/definition/repository";
import { createDefaultAccessStores, type AccessStoreOptions } from "../datasets/default-stores";
import { createMemoryOnboardingStore } from "../onboarding/store";
import type { UserProfile } from "../types";
import {
  createMemoryPrivacyAcknowledgmentRepository,
  type MemoryPrivacyState,
} from "../privacy/repository";
import { ACTIVE_PRIVACY_NOTICE } from "../privacy/notice";
import type { PrivacyAcknowledgmentRepository } from "../privacy/repository";
import { createMemoryGroupMembershipReader } from "../group-membership";

/** Optional overrides for the dataset/change-list and onboarding repositories. Tests inject these. */
export interface MemoryStoreOptions extends AccessStoreOptions {
  /** Who is signed in; replaces `catalog.getUser()` (the real `/api/session` identity). */
  currentUser?: () => Promise<UserProfile>;
  clock?: EirClock;
  eirRepository?: EirRepository;
  /** EIR definitions (#201): on the server in the app, like EIRs; in memory otherwise. */
  eirDefinitions?: EirDefinitionRepository;
  eirForms?: EirFormSource;
  privacyAcknowledgmentRepository?: PrivacyAcknowledgmentRepository;
}

/** Deep copy so store state and the seed are isolated from callers. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Build an in-memory store from a snapshot. Catalog reads return copies of the
 * seed; request state lives in a mutable copy so createRequest round-trips.
 */
export function createMemoryStore(
  seed: AppDataSnapshot,
  options: MemoryStoreOptions = {},
): DataStore {
  // Request state is the only thing we mutate; keep it isolated from the seed.
  const requests: AccessRequest[] = clone(seed.requests);
  const attestations: WaiverAttestation[] = [];
  const eirFiles = new Map<string, Uint8Array>();

  const catalog: CatalogStore = {
    listSystems: async () => clone(seed.systems),
    getSystem: async (id) => clone(seed.systems.find((s) => s.id === id)),
    listDomains: async () => clone(seed.domains),
    getDomain: async (id) => clone(seed.domains.find((d) => d.id === id)),
    listBundles: async () => clone(seed.bundles),
    getBundle: async (id) => clone(seed.bundles.find((b) => b.id === id)),
    listDatasets: async () => clone(seed.datasets),
    getDataset: async (id) => clone(seed.datasets.find((d) => d.id === id)),
    listPersonas: async () => clone(seed.onboardingPersonas),
    listTenants: async () => clone(seed.tenants),
    // The current user is the REAL server-resolved identity (`/api/session`), not
    // the seed. `fetchSessionProfile` returns `null` ONLY when the endpoint is
    // unreachable at the network level, and throws on any HTTP error (so a
    // non-200 fails closed in every build).
    //
    // The seed is a LOCAL-DEV convenience, never a production fallback: in a
    // production/deployed build a network-unreachable `/api/session` FAILS CLOSED
    // (throws → the app surfaces an unauthenticated/error state) rather than
    // silently impersonating the admin seed user (ADR-0004 fail-closed posture).
    // In local dev (no server running) the seed profile is returned, but with
    // `isAdmin` forced false — the no-server fallback never grants admin.
    getUser: async () => {
      const profile = await fetchSessionProfile();
      if (profile) return profile;
      if (!import.meta.env.DEV) {
        throw new Error(
          "Identity unavailable: /api/session could not be reached in a production build. " +
            "Failing closed — refusing to fall back to the local seed user.",
        );
      }
      return { ...clone(seed.user), isAdmin: false };
    },
  };

  const requestStore: RequestStore = {
    listRequests: async () => clone(requests),
    getRequest: async (id) => clone(requests.find((r) => r.id === id)),
    createRequest: async (request) => {
      const stored = clone(request);
      requests.unshift(stored);
      return clone(stored);
    },
    transitionRequest: async (id, update) => {
      const index = requests.findIndex((request) => request.id === id);
      if (index < 0) throw new Error(`Request ${id} was not found.`);
      requests[index] = { ...requests[index]!, ...clone(update) };
      return clone(requests[index]!);
    },
    appendWaiverAttestation: async (attestation) => {
      const stored = clone(attestation);
      attestations.push(stored);
      return clone(stored);
    },
    listPipeline: async () => clone(seed.pipeline),
  };

  const status: StatusStore = {
    listStages: async () => clone(seed.STAGES),
    listRequestStatuses: async (): Promise<Record<string, RequestStatus>> => {
      const byId: Record<string, RequestStatus> = {};
      for (const request of requests) {
        byId[request.id] = {
          requestId: request.id,
          status: request.status,
          overall: request.overall,
          stageIndex: request.stageIndex,
          stages: clone(seed.STAGES),
          subRequests: clone(request.subRequests),
        };
      }
      return byId;
    },
    getRequestStatus: async (id): Promise<RequestStatus | undefined> => {
      const request = requests.find((r) => r.id === id);
      if (!request) return undefined;
      return {
        requestId: request.id,
        status: request.status,
        overall: request.overall,
        stageIndex: request.stageIndex,
        stages: clone(seed.STAGES),
        subRequests: clone(request.subRequests),
      };
    },
    getMyAccess: async () => clone(seed.myAccess),
  };

  if (options.currentUser) catalog.getUser = options.currentUser;

  const access = createDefaultAccessStores(catalog.getUser, options);
  const definitions = createMemoryEirDefinitionRepository(
    options.clock ? { clock: options.clock } : {},
  );
  const eir =
    options.eirRepository ??
    createMemoryEirRepository({
      ...(options.clock ? { clock: options.clock } : {}),
      definitions: definitions.definitions,
      ...(options.slaConfig
        ? {
            validityDays: options.slaConfig.eirValidityDays,
            reviewSlaBusinessDays: options.slaConfig.stages["eir-validation"],
            dueSoonThresholdBusinessDays: options.slaConfig.dueSoonThresholdBusinessDays,
            holidays: options.slaConfig.holidays,
          }
        : {}),
      fileStorage: {
        write: async (path, bytes) => {
          eirFiles.set(path, clone(bytes));
        },
      },
    });
  const privacyState: MemoryPrivacyState = { acknowledgments: [] };
  const privacyForCurrentUser = async () => {
    const user = await catalog.getUser();
    return createMemoryPrivacyAcknowledgmentRepository({
      state: privacyState,
      identity: { principalId: user.principalId, displayName: user.name, actorApp: "tenant" },
    });
  };
  const memoryPrivacyAcknowledgments = {
    notice: ACTIVE_PRIVACY_NOTICE,
    current: async () => (await privacyForCurrentUser()).current(),
    acknowledge: async (
      displayedNotice: Parameters<PrivacyAcknowledgmentRepository["acknowledge"]>[0],
    ) => (await privacyForCurrentUser()).acknowledge(displayedNotice),
    history: async () => (await privacyForCurrentUser()).history(),
  };
  const privacyAcknowledgments =
    options.privacyAcknowledgmentRepository ?? memoryPrivacyAcknowledgments;

  // The onboarding repository resolves the signed-in user itself (never from the caller).
  const onboarding = createMemoryOnboardingStore({
    currentUser: catalog.getUser,
    now: options.now ?? (() => new Date()),
    ...(options.slaConfig ? { slaConfig: options.slaConfig } : {}),
  });

  const currentPerson = async () => {
    const user = await catalog.getUser();
    return { ...user, displayName: user.name };
  };
  const eirDefinitions =
    options.eirDefinitions ?? eirDefinitionsForCurrentUser(definitions, currentPerson);
  const eirForms = options.eirForms ?? memoryEirFormSource(definitions.forms);

  return {
    groupMemberships: createMemoryGroupMembershipReader([], async () =>
      (await catalog.getUser()).isAdmin
        ? { edpStaff: true }
        : { edpStaff: false, domains: [], datasetTags: [] },
    ),
    catalog,
    requests: requestStore,
    status,
    eir,
    eirDefinitions,
    eirForms,
    privacyAcknowledgments,
    ...access,
    onboarding,
  };
}
