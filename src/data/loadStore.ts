/**
 * The seam entry point: `loadStore()` returns the active {@link DataStore}.
 *
 * Callers ask for "the store" and never learn which backend answers. P1 uses
 * the in-memory adapter (seeded from window.AppData); setting
 * `VITE_DATA_BACKEND=delta` selects the Delta adapter, which talks to the
 * server's command and read API (#76). This
 * is the one place a future phase flips to make the whole app Delta-backed.
 */
import { createDeltaStore, httpTransport, type DeltaStoreConfig } from "./adapters/delta";
import { createMemoryStore } from "./adapters/memory";
import { fetchSessionProfile } from "./session";
import { readAppDataSeed } from "./seed";
import type { DataStore } from "./store";
import { createDeltaEirRepository } from "./eir/delta-repository";
import {
  createDeltaEirDefinitionRepository,
  createDeltaEirFormSource,
} from "./eir/definition/delta-repository";
import { createDeltaPrivacyAcknowledgmentRepository } from "./privacy/delta-repository";
import type { UserProfile } from "./types";

export type DataBackend = "memory" | "delta";

let singleton: Promise<DataStore> | null = null;

/**
 * The Delta adapter needs no warehouse, catalog or credentials in the
 * browser: the server holds them (`src/server/delta/config.ts`). The cart's
 * stage labels and the business domain list come from the prototype seed,
 * as in memory mode: they're configuration, not records. Sample access
 * requests only when the session says, exactly, that this preview has them
 * (#312); anything else, none.
 */
function readDeltaConfig(profile: UserProfile | null): DeltaStoreConfig {
  return {
    stages: () => readAppDataSeed().STAGES,
    domains: () => readAppDataSeed().domains,
    accessStores: {
      ...(profile ? { currentUser: async () => profile } : {}),
      ...(profile?.slaConfig ? { slaConfig: profile.slaConfig } : {}),
      ...(profile?.sampleAccessRequests === true ? { sampleAccessRequests: true } : {}),
    },
  };
}

/**
 * Which backend the seam is configured to use. Unset/empty defaults to
 * `memory`; any other explicit value is a configuration error and throws
 * clearly rather than silently serving seed data.
 */
export function activeBackend(): DataBackend {
  const raw = import.meta.env["VITE_DATA_BACKEND"];
  if (raw === undefined || raw === "") return "memory";
  if (raw === "memory" || raw === "delta") return raw;
  throw new Error(
    `Unsupported VITE_DATA_BACKEND=${JSON.stringify(raw)}; expected "memory" or "delta".`,
  );
}

/** Return the process-wide store singleton, constructing it on first use. */
async function buildStore(): Promise<DataStore> {
  const profile = await fetchSessionProfile();
  if (!profile && !import.meta.env.DEV) {
    throw new Error(
      "Identity unavailable: /api/session could not be reached in a production build. " +
        "Failing closed — refusing to build the store from local defaults.",
    );
  }
  const currentUser = profile ? { currentUser: async () => profile } : {};
  const slaConfig = profile?.slaConfig ? { slaConfig: profile.slaConfig } : {};
  return activeBackend() === "delta"
    ? createDeltaStore(readDeltaConfig(profile))
    : createMemoryStore(readAppDataSeed(), {
        ...currentUser,
        ...slaConfig,
        // EIRs persist on the server in every mode, as since #98: on Delta now (#126).
        eirRepository: createDeltaEirRepository({ transport: httpTransport() }),
        // So are their definitions (#201).
        eirDefinitions: createDeltaEirDefinitionRepository({ transport: httpTransport() }),
        eirForms: createDeltaEirFormSource({ transport: httpTransport() }),
        privacyAcknowledgmentRepository: createDeltaPrivacyAcknowledgmentRepository({
          transport: httpTransport(),
        }),
      });
}

export function loadStore(): Promise<DataStore> {
  if (singleton) return singleton;
  singleton = buildStore().catch((error) => {
    singleton = null;
    throw error;
  });
  return singleton;
}

/** Test hook: drop the memoized store so the next loadStore() rebuilds it. */
export function resetStoreForTests(): void {
  singleton = null;
}
