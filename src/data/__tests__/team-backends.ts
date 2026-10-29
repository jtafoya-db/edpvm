/**
 * The two backends the dataset-team and change-list contract tests run on:
 *
 * - `memory`: the memory adapter, as the app runs in local development;
 * - `delta`: the Delta adapter end to end — its real HTTP transport, the
 *   server's API router, the transaction runner and the teams area — over
 *   a SQLite fake warehouse built from the real DDL
 *   (src/server/delta/__tests__/sqlite-warehouse.ts). The configured
 *   datasets are loaded the way the server loads them, before the first
 *   request to these areas.
 *
 * Both must give the same results.
 */
import { createDeltaStore, httpTransport } from "../adapters/delta";
import { createMemoryStore, type MemoryStoreOptions } from "../adapters/memory";
import { DEFAULT_DATASET_SEED } from "../datasets/seed";
import type { DataStore } from "../store";
import type { UserProfile } from "../types";
import { errorResponse, handleDeltaApiRequest, type DeltaApiDeps } from "../../server/delta/api.ts";
import { registerTeamsArea } from "../../server/delta/areas/teams.ts";
import {
  configuredDatasetsLoader,
  needsConfiguredDatasets,
} from "../../server/delta/areas/teams-seed.ts";
import { createRegistry, type CommandDefinition } from "../../server/delta/registry.ts";
import { createStoreNames } from "../../server/delta/sql-builder.ts";
import { createTransactionRunner, type TransactionRunner } from "../../server/delta/transaction.ts";
import {
  createSqliteWarehouse,
  type SqliteWarehouse,
} from "../../server/delta/__tests__/sqlite-warehouse.ts";
import { makeSnapshot } from "./fixture";

export const BACKENDS = ["memory", "delta"] as const;
export type Backend = (typeof BACKENDS)[number];

export type TeamStoreOptions = Pick<
  MemoryStoreOptions,
  | "currentUser"
  | "now"
  | "datasetSeed"
  | "groupNaming"
  | "roleDescriptions"
  | "groupMembershipReader"
>;

export interface DeltaHarness {
  store: DataStore;
  warehouse: SqliteWarehouse;
  runner: TransactionRunner;
  /** Call the real test API directly when a contract needs its HTTP status. */
  fetch: typeof fetch;
  /** Every API request the browser side made, as `METHOD /path`. */
  requests: string[];
}

/**
 * A Delta store for one signed-in user. Pass another harness's `warehouse`
 * for a second browser session on the same store.
 */
export function createDeltaHarness(
  options: TeamStoreOptions & {
    warehouse?: SqliteWarehouse;
    /** The browser seeds the samples (what `/api/session` would say). */
    sampleAccessRequests?: boolean;
    /** The server's own sample mode; off by default, as for this store's empty prefix. */
    serverSampleAccessRequests?: boolean;
  },
): DeltaHarness {
  const now = options.now ?? (() => new Date());
  const warehouse = options.warehouse ?? createSqliteWarehouse({ now });
  const names = createStoreNames("edp_test", "");
  const registry = createRegistry();
  registerTeamsArea(registry, {
    ...(options.serverSampleAccessRequests ? { sampleAccessRequests: () => true } : {}),
    ...(options.groupNaming ? { groupNaming: options.groupNaming } : {}),
    ...(options.roleDescriptions ? { roleDescriptions: options.roleDescriptions } : {}),
    ...(options.groupMembershipReader
      ? { groupMembershipReader: options.groupMembershipReader, now }
      : {}),
  });
  const runner = createTransactionRunner({
    client: warehouse.client,
    names,
    now,
    sleep: async () => undefined,
    refusalCommand: () =>
      registry.findWrite("teams", "record-ownership-refusal") as
        CommandDefinition<{ datasetId: string }, unknown> | undefined,
  });
  const currentUser = options.currentUser ?? (async () => makeSnapshot().user);
  const deps: DeltaApiDeps = {
    registry,
    runner,
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => {
      const user: UserProfile = await currentUser();
      return {
        principalId: user.principalId,
        displayName: user.name,
        email: user.email ?? "",
        isAdmin: user.isAdmin,
        onboardingReviewerRoles: [],
      };
    },
    requirePrivacyAcknowledgment: async () => undefined,
  };
  const load = configuredDatasetsLoader(() => options.datasetSeed ?? DEFAULT_DATASET_SEED, {
    runner,
    names,
    ...(options.groupNaming ? { groupNaming: options.groupNaming } : {}),
  });
  const requests: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const request = new Request(new URL(url, "http://edp.test"), init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    if (needsConfiguredDatasets(new URL(request.url).pathname)) {
      try {
        await load();
      } catch (error) {
        return errorResponse(error, "loading the configured datasets");
      }
    }
    return handleDeltaApiRequest(request, deps);
  }) as typeof fetch;
  const store = createDeltaStore({
    transport: httpTransport(fetchImpl),
    accessStores: {
      currentUser,
      now,
      ...(options.sampleAccessRequests ? { sampleAccessRequests: true } : {}),
      ...(options.roleDescriptions ? { roleDescriptions: options.roleDescriptions } : {}),
    },
  });
  return { store, warehouse, runner, fetch: fetchImpl, requests };
}

/** A store on the given backend, with the same options either way. */
export function createTeamStore(backend: Backend, options: TeamStoreOptions): DataStore {
  return backend === "memory"
    ? createMemoryStore(makeSnapshot(), options)
    : createDeltaHarness(options).store;
}
