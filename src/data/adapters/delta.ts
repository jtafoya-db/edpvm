/**
 * The Delta adapter: the {@link DataStore} seam over the server's Delta API
 * (#76, ADR-0007).
 *
 * The browser never sends SQL and never says who's acting. Reads go to
 * allow-listed `GET /api/reads/<area>/<read>` endpoints and writes to
 * `POST /api/commands/<area>/<command>` (or, for #72's cart-request tables,
 * `POST /api/legacy-writes/<area>/<write>`); the server builds every statement,
 * runs it as the app's service principal, and takes the actor from the
 * session. See `src/server/delta/`.
 */
import {
  accessRequestConfigFromSla,
  DEFAULT_ACCESS_REQUEST_CONFIG,
} from "../access-requests/config";
import { createMemoryAccessRequestStore } from "../access-requests/memory";
import { sampleAccessRequests } from "../access-requests/seed";
import type { AccessStoreOptions } from "../datasets/default-stores";
import { DEFAULT_ROLE_DESCRIPTIONS } from "../datasets/role-descriptions";
import { DeltaApiError, readApiResponse, requestFailed } from "../api-response";
import { createDeltaTeamStores } from "./delta-teams";
import { fetchSessionProfile } from "../session";
import { cloneEffectiveSlaConfig, DEFAULT_EFFECTIVE_SLA_CONFIG } from "../sla-config";
import type { CatalogStore, DataStore, RequestStore, StatusStore } from "../store";
import type {
  AccessBundle,
  AccessRequest,
  BusinessDomain,
  DataAsset,
  MyAccess,
  OnboardingPersona,
  PipelineEntry,
  SourceSystem,
  Tenant,
  UserProfile,
  WaiverAttestation,
  RequestStatus,
} from "../types";
import type {
  OnboardingIntake,
  OnboardingRequest,
  OnboardingResubmission,
  OnboardingReviewDecision,
  OnboardingReviewerRole,
  OnboardingWriteIntent,
} from "../onboarding/types";
import { createDeltaEirRepository } from "../eir/delta-repository";
import {
  createDeltaEirDefinitionRepository,
  createDeltaEirFormSource,
} from "../eir/definition/delta-repository";
import { createDeltaPrivacyAcknowledgmentRepository } from "../privacy/delta-repository";
import type { GroupMembershipReader } from "../group-membership";

export {
  attestationToRow,
  requestToRows,
  rowToAttestation,
  rowsToRequest,
  type AccessRequestRow,
  type RequestItemRow,
  type RequestStepRow,
  type WaiverAttestationRow,
} from "../legacy-request-rows";

/** The command envelope the server accepts. It never names the actor. */
export interface CommandBody<P> {
  idempotencyKey: string;
  expectedVersion: number;
  payload: P;
}

/** How the adapter reaches the server. Tests inject a fake. */
export interface DeltaApiTransport {
  read<T>(area: string, name: string, query?: Record<string, string>): Promise<T>;
  command<T>(area: string, name: string, body: CommandBody<unknown>): Promise<T>;
  /**
   * #72's cart-request writes: the payload only. They have no idempotency key
   * or version check, so the server refuses those fields here.
   */
  legacyWrite<T>(area: string, name: string, payload: unknown): Promise<T>;
}

interface CatalogBootstrap {
  domains?: BusinessDomain[];
  datasets: DataAsset[];
  bundles: AccessBundle[];
  systems: SourceSystem[];
  personas: OnboardingPersona[];
  tenants: Tenant[] | null;
  tenantsError?: {
    code: string;
    message: string;
  };
}

interface RequestsStatusesBootstrap {
  requests: AccessRequest[];
  statuses: Record<string, RequestStatus>;
}

export { DeltaApiError } from "../api-response";

const SEEN_WATERMARKS_KEY = "edp.delta.seenWatermarks";
const MAX_WATERMARK_AREAS = 20;
const MAX_WATERMARK_VALUE_BYTES = 512;
const AREA_NAME = /^[a-z][a-z0-9-]*$/;
const WATERMARK_RE = /^wm1\.([0-9a-z]+)\.([0-9a-z]+)\.[0-9a-f]{64}$/;

interface StoredWatermarks {
  activePrincipal: string | null;
  byPrincipal: Record<string, Record<string, string>>;
}

function watermarkExpiresAt(value: string): number | undefined {
  const match = WATERMARK_RE.exec(value);
  if (!match) return undefined;
  const expiresAt = Number.parseInt(match[1]!, 36);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function watermarkIssuedAt(value: string): number {
  const match = WATERMARK_RE.exec(value);
  if (!match) return 0;
  const issuedAt = Number.parseInt(match[2]!, 36);
  return Number.isFinite(issuedAt) ? issuedAt : 0;
}

function isLiveWatermark(value: string, now = Date.now()): boolean {
  const expiresAt = watermarkExpiresAt(value);
  return expiresAt !== undefined && expiresAt > now;
}

function emptyStoredWatermarks(): StoredWatermarks {
  return { activePrincipal: null, byPrincipal: {} };
}

function normalizeWatermarkMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, string> = {};
  for (const [area, marker] of Object.entries(value as Record<string, unknown>)) {
    if (
      AREA_NAME.test(area) &&
      typeof marker === "string" &&
      marker.length > 0 &&
      marker.length <= MAX_WATERMARK_VALUE_BYTES &&
      isLiveWatermark(marker)
    ) {
      next[area] = marker;
    }
  }
  return next;
}

function readSeenWatermarks(): StoredWatermarks {
  try {
    const raw =
      typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(SEEN_WATERMARKS_KEY);
    if (!raw) return emptyStoredWatermarks();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyStoredWatermarks();
    const legacy = normalizeWatermarkMap(parsed);
    if (Object.keys(legacy).length) {
      return { activePrincipal: "legacy", byPrincipal: { legacy } };
    }
    const stored = parsed as Partial<StoredWatermarks>;
    const byPrincipal: Record<string, Record<string, string>> = {};
    for (const [principal, watermarks] of Object.entries(stored.byPrincipal ?? {})) {
      if (!principal || principal.length > 128) continue;
      byPrincipal[principal] = normalizeWatermarkMap(watermarks);
    }
    return {
      activePrincipal: typeof stored.activePrincipal === "string" ? stored.activePrincipal : null,
      byPrincipal,
    };
  } catch {
    return emptyStoredWatermarks();
  }
}

function writeSeenWatermarks(watermarks: StoredWatermarks): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(SEEN_WATERMARKS_KEY, JSON.stringify(watermarks));
  } catch {
    // Storage can be disabled; read-your-own-writes still works within this page load.
  }
}

function mergeSeenWatermarks(current: StoredWatermarks, body: unknown): StoredWatermarks {
  const watermarks = (body as { watermarks?: unknown } | undefined)?.watermarks;
  const principal = (body as { watermarkPrincipal?: unknown } | undefined)?.watermarkPrincipal;
  if (!watermarks || typeof watermarks !== "object") return current;
  if (typeof principal !== "string" || principal.length === 0 || principal.length > 128)
    return current;
  const existing = current.byPrincipal[principal] ?? {};
  const nextForPrincipal = { ...existing };
  for (const [area, marker] of Object.entries(watermarks as Record<string, unknown>)) {
    if (!AREA_NAME.test(area) || typeof marker !== "string" || marker.length === 0) continue;
    if (marker.length > MAX_WATERMARK_VALUE_BYTES) continue;
    if (!isLiveWatermark(marker)) continue;
    if (Object.keys(nextForPrincipal).length >= MAX_WATERMARK_AREAS && !(area in nextForPrincipal))
      continue;
    const old = nextForPrincipal[area];
    if (!old || watermarkIssuedAt(marker) >= watermarkIssuedAt(old)) {
      nextForPrincipal[area] = marker;
    }
  }
  const next = {
    activePrincipal: principal,
    byPrincipal: { ...current.byPrincipal, [principal]: nextForPrincipal },
  };
  writeSeenWatermarks(next);
  return next;
}

function seenHeader(current: StoredWatermarks): {
  current: StoredWatermarks;
  header: string | undefined;
} {
  const stored = readSeenWatermarks();
  const activePrincipal = current.activePrincipal ?? stored.activePrincipal;
  if (!activePrincipal) return { current: stored, header: undefined };
  const active = normalizeWatermarkMap({
    ...(stored.byPrincipal[activePrincipal] ?? {}),
    ...(current.byPrincipal[activePrincipal] ?? {}),
  });
  const merged = {
    activePrincipal,
    byPrincipal: { ...stored.byPrincipal, ...current.byPrincipal, [activePrincipal]: active },
  };
  writeSeenWatermarks(merged);
  const entries = Object.entries(active).slice(0, MAX_WATERMARK_AREAS);
  if (!entries.length) return { current: merged, header: undefined };
  return {
    current: merged,
    header: entries.map(([area, marker]) => `${area}=${encodeURIComponent(marker)}`).join(","),
  };
}

/** The real transport: same-origin `fetch` to the app server, read by {@link readApiResponse}. */
export function httpTransport(
  request: typeof fetch = (...args) => fetch(...args),
): DeltaApiTransport {
  let memorySeenWatermarks = readSeenWatermarks();
  async function send<T>(url: string, init: RequestInit): Promise<T> {
    const kind = { write: init.method !== "GET" };
    let response: Response;
    try {
      response = await request(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw requestFailed(kind);
    }
    const body = await readApiResponse<T>(response, kind, "The app couldn't do that. Try again.");
    memorySeenWatermarks = mergeSeenWatermarks(memorySeenWatermarks, body);
    return body;
  }
  return {
    read: (area, name, query) => {
      const search = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
      const seen = seenHeader(memorySeenWatermarks);
      memorySeenWatermarks = seen.current;
      return send(`/api/reads/${area}/${name}${search}`, {
        method: "GET",
        headers: seen.header ? { "x-edp-seen": seen.header } : {},
      });
    },
    command: (area, name, body) =>
      send(`/api/commands/${area}/${name}`, { method: "POST", body: JSON.stringify(body) }),
    legacyWrite: (area, name, payload) =>
      send(`/api/legacy-writes/${area}/${name}`, {
        method: "POST",
        body: JSON.stringify({ payload }),
      }),
  };
}

export interface DeltaStoreConfig {
  transport?: DeltaApiTransport;
  /** The ordered stage labels of #72's cart request (the prototype's `STAGES`). */
  stages?: () => string[];
  /**
   * The business domain list. It's configuration, the same in every mode: the
   * checked-in seed the memory adapter uses (and `src/data/tags.ts` reads),
   * until the governed domain tag (#102) replaces it. Nothing loads #72's
   * `catalog.domains` table, so reading it left the onboarding wizard's
   * required Target domain list empty on Delta.
   */
  domains?: () => BusinessDomain[];
  /**
   * Overrides for the signed-in user, the clock, role descriptions and the
   * in-memory access requests (see the end of {@link createDeltaStore}).
   * Tests inject these.
   */
  accessStores?: AccessStoreOptions & { currentUser?: () => Promise<UserProfile> };
}

/**
 * The signed-in user. Delta mode has no seed user to fall back to, so an
 * unreachable `/api/session` fails closed.
 */
async function sessionUser(): Promise<UserProfile> {
  const profile = await fetchSessionProfile();
  if (!profile) {
    throw new Error(
      "[delta] Identity unavailable: /api/session could not be reached. Refusing to attribute the action.",
    );
  }
  return profile;
}

export function createDeltaStore(config: DeltaStoreConfig = {}): DataStore {
  const api = config.transport ?? httpTransport();
  const stages = config.stages ?? (() => []);
  let catalogBootstrap: Promise<CatalogBootstrap> | null = null;
  let requestsStatusesBootstrap: Promise<RequestsStatusesBootstrap> | null = null;
  const configuredCurrentUser = config.accessStores?.currentUser ?? sessionUser;
  let currentUserPromise: Promise<UserProfile> | null = null;
  const currentUser = (): Promise<UserProfile> => {
    if (currentUserPromise) return currentUserPromise;
    const promise = configuredCurrentUser().catch((error) => {
      if (currentUserPromise === promise) currentUserPromise = null;
      throw error;
    });
    currentUserPromise = promise;
    return currentUserPromise;
  };
  const readCatalogBootstrap = () => {
    if (catalogBootstrap) return catalogBootstrap;
    const promise = api
      .read<CatalogBootstrap>("catalog", "bootstrap")
      .then((bootstrap) => ({
        ...bootstrap,
        domains: structuredClone(config.domains ? config.domains() : (bootstrap.domains ?? [])),
      }))
      .finally(() => {
        if (catalogBootstrap === promise) catalogBootstrap = null;
      });
    catalogBootstrap = promise;
    return catalogBootstrap;
  };
  const withStages = (status: RequestStatus): RequestStatus => ({
    ...status,
    stages: stages(),
  });
  const readRequestsStatusesBootstrap = () => {
    if (requestsStatusesBootstrap) return requestsStatusesBootstrap;
    const promise = api
      .read<RequestsStatusesBootstrap>("requests", "statuses")
      .then((bootstrap) => ({
        requests: bootstrap.requests,
        statuses: Object.fromEntries(
          Object.entries(bootstrap.statuses).map(([id, status]) => [id, withStages(status)]),
        ),
      }))
      .finally(() => {
        if (requestsStatusesBootstrap === promise) requestsStatusesBootstrap = null;
      });
    requestsStatusesBootstrap = promise;
    return requestsStatusesBootstrap;
  };
  const clearRequestsStatusesBootstrap = () => {
    requestsStatusesBootstrap = null;
  };

  // Reference data is small; single gets filter the allow-listed list reads.
  const find =
    <T extends { id: string }>(list: () => Promise<T[]>) =>
    async (id: string) =>
      (await list()).find((item) => item.id === id);
  const listSystems = () => readCatalogBootstrap().then((bootstrap) => bootstrap.systems);
  const listDomains = async (): Promise<BusinessDomain[]> =>
    structuredClone(config.domains ? config.domains() : []);
  const listBundles = () => readCatalogBootstrap().then((bootstrap) => bootstrap.bundles);
  const listDatasets = () => readCatalogBootstrap().then((bootstrap) => bootstrap.datasets);

  /**
   * A staff-only read every screen loads (the pipeline, the tenant
   * financials). The server decides from the caller's session: it refuses
   * anyone else with 403 before any SQL, and an app that doesn't serve the
   * staff surface answers 404. Either is an empty list, not an error. The
   * staff hint reuses the shell's shared session read, so first load doesn't
   * add another `/api/session` trip just to avoid non-staff fan-out.
   */
  const isEmptyStaffSurfaceError = (error: unknown) =>
    error instanceof DeltaApiError &&
    (error.status === 403 || (error.status === 404 && error.code === "not-found"));
  const staffOnly =
    <T>(area: string, name: string) =>
    async (): Promise<T[]> => {
      try {
        return await api.read<T[]>(area, name);
      } catch (error) {
        if (isEmptyStaffSurfaceError(error)) return [];
        throw error;
      }
    };
  const whenStaff = async <T>(read: () => Promise<T[]>): Promise<T[]> => {
    const staff = await currentUser().then(
      (user) => user.isAdmin,
      () => undefined,
    );
    if (staff === false) return [];
    try {
      return await read();
    } catch (error) {
      if (isEmptyStaffSurfaceError(error)) return [];
      throw error;
    }
  };
  const listBootstrapTenants = async (): Promise<Tenant[]> => {
    const inFlight = catalogBootstrap;
    // The staff check may resolve after other catalog hooks already started
    // bootstrap; reuse that still in-flight read, but do not resurrect a
    // completed one because later query refetches must hit the server.
    return whenStaff(() =>
      (inFlight ?? readCatalogBootstrap()).then((bootstrap) => {
        if (bootstrap.tenantsError) {
          throw new DeltaApiError(500, bootstrap.tenantsError.code, bootstrap.tenantsError.message);
        }
        return bootstrap.tenants ?? [];
      }),
    );
  };

  const catalog: CatalogStore = {
    listSystems,
    getSystem: find(listSystems),
    listDomains,
    getDomain: find(listDomains),
    listBundles,
    getBundle: find(listBundles),
    listDatasets,
    getDataset: find(listDatasets),
    listPersonas: () => readCatalogBootstrap().then((bootstrap) => bootstrap.personas),
    listTenants: listBootstrapTenants,
    getUser: currentUser,
  };

  const getRequest = async (id: string) =>
    (await api.read<AccessRequest | null>("requests", "access-requests", { id })) ?? undefined;

  const requests: RequestStore = {
    listRequests: () =>
      readRequestsStatusesBootstrap().then((bootstrap) => structuredClone(bootstrap.requests)),
    getRequest,
    // The server sets the requester from the session; the body never names it.
    createRequest: async (request) => {
      const { requesterPrincipalId: _id, requesterUsername: _name, ...payload } = request;
      const created = (
        await api.legacyWrite<{ result: AccessRequest }>("requests", "create-request", payload)
      ).result;
      clearRequestsStatusesBootstrap();
      return created;
    },
    transitionRequest: async (id, update) => {
      const transitioned = (
        await api.legacyWrite<{ result: AccessRequest }>("requests", "transition-request", {
          id,
          ...update,
        })
      ).result;
      clearRequestsStatusesBootstrap();
      return transitioned;
    },
    // The server sets the attestor from the session.
    appendWaiverAttestation: async (value: WaiverAttestation) => {
      const {
        attestorPrincipalId: _id,
        attestorUsername: _name,
        supersededAt: _s,
        ...payload
      } = value;
      return (
        await api.legacyWrite<{ result: WaiverAttestation }>(
          "requests",
          "append-waiver-attestation",
          payload,
        )
      ).result;
    },
    listPipeline: () => whenStaff(staffOnly<PipelineEntry>("requests", "pipeline")),
  };

  const status: StatusStore = {
    listStages: async () => stages(),
    listRequestStatuses: () =>
      readRequestsStatusesBootstrap().then((bootstrap) => structuredClone(bootstrap.statuses)),
    getRequestStatus: async (id) => {
      const statuses = await status.listRequestStatuses();
      return statuses[id];
    },
    getMyAccess: () => api.read<MyAccess>("access", "my-access"),
  };

  // Datasets, dataset roles, team management and the change list are on
  // Delta (#123). Access requests (#91) aren't yet: they stay in this tab's
  // memory (`access-request-persistence`, stub), on top of the Delta stores,
  // so an approval adds the member in Delta exactly as a direct add does.
  const actionCurrentUser = config.accessStores?.currentUser ?? currentUser;
  const now = config.accessStores?.now ?? (() => new Date());
  const slaConfig = cloneEffectiveSlaConfig(
    config.accessStores?.slaConfig ?? DEFAULT_EFFECTIVE_SLA_CONFIG,
  );
  const teams = createDeltaTeamStores({
    api,
    roleDescriptions: config.accessStores?.roleDescriptions ?? DEFAULT_ROLE_DESCRIPTIONS,
  });
  const access = {
    ...teams,
    accessRequests: createMemoryAccessRequestStore({
      datasets: teams.datasets,
      datasetRoles: teams.datasetRoles,
      currentUser: actionCurrentUser,
      now,
      settings:
        config.accessStores?.accessRequestConfig ??
        accessRequestConfigFromSla(DEFAULT_ACCESS_REQUEST_CONFIG, slaConfig),
      holidays: slaConfig.holidays,
      seed: config.accessStores?.datasetSeed ? [] : sampleAccessRequests(now()),
    }),
  };

  // One intent, one idempotency key: the key comes from the caller (made when
  // the person confirms), so a retry or a double click that slips through
  // replays the first write instead of making a second one.
  const command = async <P, R>(
    name: string,
    expectedVersion: number,
    payload: P,
    intent?: OnboardingWriteIntent,
  ): Promise<R> =>
    (
      await api.command<{ result: R }>("onboarding", name, {
        idempotencyKey: intent?.key ?? crypto.randomUUID(),
        expectedVersion,
        payload,
      })
    ).result;

  const currentVersion = async (id: string): Promise<number> => {
    const current = await api.read<OnboardingRequest | null>("onboarding", "request", { id });
    if (!current) throw new Error("Onboarding request not found.");
    return current.version;
  };

  // A screen's intent carries the version the person confirmed against: that's
  // the command's expected version, sent as is, with no read first. The server
  // refuses it (409) if the record has moved on, and a retry of the same intent
  // sends the same key and version, so a write that committed replays.
  //
  // Without one (a caller that didn't see the record), read the current
  // version. The server hashes the version into the command, so a retry of the
  // intent must send the version its first attempt used, or a write that did
  // commit would be refused as a reused key; a refusal (4xx) is final for that
  // attempt, so the version is forgotten and a retry reads the current one.
  const intentVersions = new Map<string, number>();
  const recordCommand = async <P>(
    name: string,
    id: string,
    payload: P,
    intent: OnboardingWriteIntent | undefined,
  ): Promise<OnboardingRequest> => {
    if (intent?.version !== undefined) {
      return command<P, OnboardingRequest>(name, intent.version, payload, intent);
    }
    const known = intent ? intentVersions.get(intent.key) : undefined;
    const version = known ?? (await currentVersion(id));
    if (intent) intentVersions.set(intent.key, version);
    try {
      return await command<P, OnboardingRequest>(name, version, payload, intent);
    } catch (error) {
      if (intent && error instanceof DeltaApiError && error.status >= 400 && error.status < 500)
        intentVersions.delete(intent.key);
      throw error;
    }
  };

  const onboarding = {
    submit: (intake: OnboardingIntake, intent?: OnboardingWriteIntent) =>
      command<{ intake: OnboardingIntake }, OnboardingRequest>("submit", 0, { intake }, intent),
    get: async (id: string) =>
      (await api.read<OnboardingRequest | null>("onboarding", "request", { id })) ?? undefined,
    listMine: () => api.read<OnboardingRequest[]>("onboarding", "mine"),
    listInbox: (role: OnboardingReviewerRole) =>
      api.read<OnboardingRequest[]>("onboarding", "inbox", { role }),
    decide: (id: string, decision: OnboardingReviewDecision, intent?: OnboardingWriteIntent) =>
      recordCommand("decide", id, { requestId: id, decision }, intent),
    resubmit: (id: string, resubmission: OnboardingResubmission, intent?: OnboardingWriteIntent) =>
      recordCommand("resubmit", id, { requestId: id, resubmission }, intent),
    withdraw: (
      id: string,
      input: { note?: string | undefined } = {},
      intent?: OnboardingWriteIntent,
    ) => recordCommand("withdraw", id, { requestId: id, note: input.note }, intent),
  };

  // EIRs are on Delta (#126): `eir/*` commands and reads, PDFs on the volume.
  const eir = createDeltaEirRepository({ transport: api });
  // EIR definitions (#201): staff `eir-definitions/*`, and the employee's form.
  const eirDefinitions = createDeltaEirDefinitionRepository({ transport: api });
  const eirForms = createDeltaEirFormSource({ transport: api });
  const privacyAcknowledgments = createDeltaPrivacyAcknowledgmentRepository({ transport: api });
  const groupMemberships: GroupMembershipReader = {
    listMemberships: (options) =>
      api.read(
        "membership",
        "memberships",
        options?.includeRemoved ? { includeRemoved: "true" } : {},
      ),
    listHistory: (options) =>
      api.read("membership", "history", {
        ...(options?.limit === undefined ? {} : { limit: String(options.limit) }),
        ...(options?.cursor === undefined
          ? {}
          : {
              cursorVersion: String(options.cursor.commitVersion),
              cursorGroupId: options.cursor.groupId,
              cursorUserId: options.cursor.userId,
            }),
      }),
    latestRun: () => api.read("membership", "latest-run"),
  };
  return {
    groupMemberships,
    catalog,
    requests,
    status,
    eir,
    eirDefinitions,
    eirForms,
    privacyAcknowledgments,
    ...access,
    onboarding,
  };
}
