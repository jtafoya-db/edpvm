/**
 * Sample access requests on Delta, a PR preview's test data only (#312).
 *
 * On Delta, access requests still live in one tab's memory (the
 * `access-request-persistence` stub), but approving one adds the member and
 * lists the change-list entry in Delta. The samples
 * (`src/data/access-requests/seed.ts`) target `ds-refund-anomaly-scores`, so
 * if a real dataset has that ID, its owner would see sample requesters and
 * approving one would write a real member. Production must never have them.
 *
 * Fail closed, as the EIR self-decision test mode does
 * (`src/server/eir-test-mode.ts`): samples exist only when BOTH hold, both
 * checked on the server.
 * 1. `EDP_SAMPLE_ACCESS_REQUESTS` is exactly `true`: no trimming, no case
 *    folding, so ` true ` or `True` is off.
 *    The bundle sets it from `sample_access_requests`, `"false"` on every
 *    target: a preview deploy asks with `--var sample_access_requests=true`.
 *    Any other value is off, and an unexpected one (not
 *    `true`, `false` or empty) logs a warning.
 * 2. The store's schema prefix is a PR preview's (`edp_vm_pr<N>_`). Production
 *    has no prefix, so a flag set there by mistake still does nothing.
 *
 * The server is the gate. The teams area refuses, with a generic error, to add
 * a sample requester as a member or owner, or to list an add-member change
 * for one, unless sample mode is on for the store it writes to
 * (`sampleAccessRequestsForStore`). So a browser that seeds samples it
 * shouldn't, for whatever reason, still can't approve one into real data.
 *
 * `/api/session` carries `sampleAccessRequests: true` when it's on, and the
 * browser's Delta store then seeds the samples; off, the profile has no trace
 * of it and the store seeds none. That's for the screens only. The memory
 * backend (local development) keeps its samples: it writes nothing real.
 */
import { PREVIEW_SCHEMA_PREFIX } from "./eir-test-mode.ts";
import type { StoreNames } from "./delta/sql-builder.ts";

export const SAMPLE_ACCESS_REQUESTS_ENV = "EDP_SAMPLE_ACCESS_REQUESTS";

const warned = new Set<string>();
const warnOnce = (message: string) => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[access-requests] ${message}`);
};

/** Whether samples are on, from the flag's raw value and the store's schema prefix. */
export function sampleAccessRequestsAllowed(
  flag: string | undefined,
  schemaPrefix: string | undefined,
  warn: (message: string) => void = warnOnce,
): boolean {
  const value = flag ?? "";
  if (value !== "true") {
    if (value !== "" && value !== "false") {
      warn(
        `${SAMPLE_ACCESS_REQUESTS_ENV} is ${JSON.stringify(flag)}; only "true" turns on sample access requests, so there are none.`,
      );
    }
    return false;
  }
  if (!PREVIEW_SCHEMA_PREFIX.test(schemaPrefix ?? "")) {
    warn(
      `${SAMPLE_ACCESS_REQUESTS_ENV} is "true" but the store isn't a PR preview's (schema prefix ${JSON.stringify(schemaPrefix ?? "")}); there are no sample access requests.`,
    );
    return false;
  }
  return true;
}

/** One env var's raw value: `process.env` first (the app), then the platform env object. */
function readEnv(env: unknown, name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromProcess = proc?.env?.[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  if (env && typeof env === "object" && name in env) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Whether samples are on for this app, from its env (the session uses this). */
export function sampleAccessRequestsFromEnv(env?: unknown): boolean {
  return sampleAccessRequestsAllowed(
    readEnv(env, SAMPLE_ACCESS_REQUESTS_ENV),
    readEnv(env, "EDP_STORE_SCHEMA_PREFIX"),
  );
}

/**
 * Whether samples are on for the store a command writes to: the flag from env,
 * and that store's own prefix (not a second reading of the env). The teams
 * area's gate uses this.
 */
export function sampleAccessRequestsForStore(names: StoreNames): boolean {
  return sampleAccessRequestsAllowed(
    readEnv(undefined, SAMPLE_ACCESS_REQUESTS_ENV),
    names.schemaPrefix,
  );
}
