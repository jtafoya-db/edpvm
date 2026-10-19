/**
 * Wires the Delta API from the server environment. Nothing here is a `VITE_*`
 * variable, so none of it reaches the browser bundle.
 *
 * - `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`:
 *   injected by Databricks Apps for the app's service principal (OAuth M2M).
 * - `DATABRICKS_WAREHOUSE_ID`: the app's `sql-warehouse` resource.
 * - `EDP_STORE_CATALOG`, `EDP_STORE_SCHEMA_PREFIX`: where the store lives.
 * - `EDP_APP_SURFACES`: `tenant,staff` (default) — which commands and reads
 *   this app mounts (ADR-0008 split).
 * - `EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS`, `EDP_SQL_READ_WAIT_TIMEOUT_SECONDS`,
 *   `EDP_SQL_COMMAND_POLL_INTERVAL_MS`, `EDP_SQL_READ_POLL_INTERVAL_MS`:
 *   optional Statement API async wait tuning. The client deadline stays 45 s.
 * - `EDP_PILOT_CONFIG_JSON`: the pilot initiative, datasets and owners to load
 *   (src/server/pilot-config.ts). Invalid, and the API refuses every request.
 * - `DATABRICKS_TOKEN`: local development only, instead of the client
 *   credentials; ignored when `NODE_ENV=production`.
 */
import { resolveSessionIdentity, toSessionUser } from "../session";
import { configuredSeed, PilotConfigError, type ConfiguredSeed } from "../pilot-config";
import { errorResponse, handleDeltaApiRequest, json, type DeltaApiDeps } from "./api.ts";
import { configuredDatasetsLoader, needsConfiguredDatasets } from "./areas/teams-seed.ts";
import { createAppRegistry } from "./areas/index.ts";
import type { AppSurface, CommandDefinition } from "./registry.ts";
import { createStoreNames } from "./sql-builder.ts";
import { createServicePrincipalTokenSource, createStatementExecutionClient } from "./sql-client.ts";
import { createDeltaSnapshotCache } from "./snapshot-cache.ts";
import { createTransactionRunner } from "./transaction.ts";
import { privacyAcknowledgmentGuard } from "../privacy-enforcement";
import { ACTIVE_PRIVACY_NOTICE } from "../../data/privacy/notice";

function envValue(env: unknown, name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromProcess = proc?.env?.[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  if (env && typeof env === "object" && name in env) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

export class DeltaConfigError extends Error {}

export function readSurfaces(raw: string | undefined): AppSurface[] {
  const requested = (raw ?? "tenant,staff").split(",").map((s) => s.trim());
  const surfaces = (["tenant", "staff"] as const).filter((s) => requested.includes(s));
  if (!surfaces.length) throw new DeltaConfigError(`EDP_APP_SURFACES has no known surface: ${raw}`);
  return surfaces;
}

function envNumber(env: unknown, name: string): number | undefined {
  const raw = envValue(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new DeltaConfigError(`${name} must be a positive whole number.`);
  }
  return value;
}

/** Build the API's dependencies from env. Throws {@link DeltaConfigError} naming what's missing. */
export function deltaApiFromEnv(env: unknown): DeltaApiDeps {
  const missing = ["DATABRICKS_HOST", "DATABRICKS_WAREHOUSE_ID", "EDP_STORE_CATALOG"].filter(
    (name) => !envValue(env, name),
  );
  const production = envValue(env, "NODE_ENV") === "production";
  const devToken = production ? undefined : envValue(env, "DATABRICKS_TOKEN");
  const clientId = envValue(env, "DATABRICKS_CLIENT_ID");
  const clientSecret = envValue(env, "DATABRICKS_CLIENT_SECRET");
  if (!devToken && (!clientId || !clientSecret))
    missing.push("DATABRICKS_CLIENT_ID/DATABRICKS_CLIENT_SECRET");
  if (missing.length) {
    throw new DeltaConfigError(
      `The Delta backend isn't configured on the server: set ${missing.join(", ")}.`,
    );
  }
  const rawHost = envValue(env, "DATABRICKS_HOST")!;
  const host = (/^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`).replace(/\/+$/, "");
  const getToken = devToken
    ? async () => devToken
    : createServicePrincipalTokenSource({ host, clientId: clientId!, clientSecret: clientSecret! });
  const commandWaitTimeoutSeconds = envNumber(env, "EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS");
  const readWaitTimeoutSeconds = envNumber(env, "EDP_SQL_READ_WAIT_TIMEOUT_SECONDS");
  const commandPollIntervalMs = envNumber(env, "EDP_SQL_COMMAND_POLL_INTERVAL_MS");
  const readPollIntervalMs = envNumber(env, "EDP_SQL_READ_POLL_INTERVAL_MS");
  const snapshotPollIntervalMs = envNumber(env, "EDP_SNAPSHOT_POLL_INTERVAL_MS");
  const snapshotActiveWindowMs = envNumber(env, "EDP_SNAPSHOT_ACTIVE_WINDOW_MS");
  const snapshotMaxStaleMs = envNumber(env, "EDP_SNAPSHOT_MAX_STALE_MS");
  const client = createStatementExecutionClient({
    host,
    warehouseId: envValue(env, "DATABRICKS_WAREHOUSE_ID")!,
    getToken,
    ...(commandWaitTimeoutSeconds ? { commandWaitTimeoutSeconds } : {}),
    ...(readWaitTimeoutSeconds ? { readWaitTimeoutSeconds } : {}),
    ...(commandPollIntervalMs ? { commandPollIntervalMs } : {}),
    ...(readPollIntervalMs ? { readPollIntervalMs } : {}),
  });
  const names = createStoreNames(
    envValue(env, "EDP_STORE_CATALOG")!,
    envValue(env, "EDP_STORE_SCHEMA_PREFIX") ?? "",
  );
  const notice = ACTIVE_PRIVACY_NOTICE;
  const membershipCatalog =
    envValue(env, "EDP_MEMBERSHIP_CATALOG") ?? envValue(env, "EDP_STORE_CATALOG")!;
  const membershipSchema = envValue(env, "EDP_MEMBERSHIP_SCHEMA") ?? "membership";
  console.info(
    `[delta-config] membership snapshot=${membershipCatalog}.${membershipSchema} (server-only app-SP reads)`,
  );
  const registry = createAppRegistry(notice, {
    catalog: membershipCatalog,
    schema: membershipSchema,
  });
  const runner = createTransactionRunner({
    client,
    names,
    refusalCommand: () =>
      registry.findWrite("teams", "record-ownership-refusal") as
        CommandDefinition<{ datasetId: string }, unknown> | undefined,
  });
  const snapshotCache = createDeltaSnapshotCache({
    ...(snapshotPollIntervalMs ? { pollIntervalMs: snapshotPollIntervalMs } : {}),
    ...(snapshotActiveWindowMs ? { activeWindowMs: snapshotActiveWindowMs } : {}),
    ...(snapshotMaxStaleMs ? { maxStaleMs: snapshotMaxStaleMs } : {}),
  });
  return {
    registry,
    runner,
    names,
    requirePrivacyAcknowledgment: privacyAcknowledgmentGuard({ runner, names, notice }),
    snapshotCache,
    serves: readSurfaces(envValue(env, "EDP_APP_SURFACES")),
    resolveUser: async (request) => toSessionUser(await resolveSessionIdentity(request, env)),
  };
}

/** This deployment's configured datasets. Throws {@link DeltaConfigError} if the pilot configuration is invalid. */
export function configuredSeedFromEnv(env: unknown): ConfiguredSeed {
  try {
    return configuredSeed({
      pilotConfigJson: envValue(env, "EDP_PILOT_CONFIG_JSON"),
      schemaPrefix: envValue(env, "EDP_STORE_SCHEMA_PREFIX"),
      seedOwnerIds: envValue(env, "EDP_SEED_DATASET_OWNER_IDS"),
    });
  } catch (error) {
    if (error instanceof PilotConfigError) throw new DeltaConfigError(error.message);
    throw error;
  }
}

let cached: DeltaApiDeps | undefined;
let seed: ConfiguredSeed | undefined;
let loadConfiguredDatasets: (() => Promise<void>) | undefined;
let snapshotWarmupStarted = false;

/** Apply the configured real privacy guard outside the Delta router (EIR file endpoints). */
export async function requireConfiguredPrivacyAcknowledgment(
  user: Parameters<NonNullable<DeltaApiDeps["requirePrivacyAcknowledgment"]>>[0],
  env?: unknown,
): Promise<void> {
  cached ??= deltaApiFromEnv(env);
  await cached.requirePrivacyAcknowledgment(user);
}

/** The server entry's handler for `/api/commands/*` and `/api/reads/*`. */
export async function handleDeltaApi(request: Request, env?: unknown): Promise<Response> {
  try {
    cached ??= deltaApiFromEnv(env);
    seed ??= configuredSeedFromEnv(env);
  } catch (error) {
    if (error instanceof DeltaConfigError) {
      console.error(error.message);
      return json({ error: { code: "backend-not-configured", message: error.message } }, 503);
    }
    throw error;
  }
  if (!snapshotWarmupStarted) {
    snapshotWarmupStarted = true;
    void cached.snapshotCache
      ?.start(
        cached.runner.reader({ readId: "00000000-0000-4000-8000-000000000192" }),
        cached.names,
      )
      .catch((error) =>
        console.warn("[delta-snapshot] startup load failed; reads will use Delta fallback.", error),
      );
  }
  // The datasets and owners from deployment configuration, loaded once (#123).
  if (needsConfiguredDatasets(new URL(request.url).pathname)) {
    const { seed: datasets, source } = seed;
    loadConfiguredDatasets ??= configuredDatasetsLoader(() => datasets, {
      runner: cached.runner,
      names: cached.names,
      ...(source ? { source } : {}),
    });
    try {
      await loadConfiguredDatasets();
    } catch (error) {
      return errorResponse(error, "loading the configured datasets");
    }
  }
  return handleDeltaApiRequest(request, cached);
}
