/**
 * The `/api/seed-config` endpoint: deployment configuration for the in-memory
 * seed, which runs in the browser and can't read server env itself.
 *
 * - `EDP_SEED_DATASET_OWNER_IDS` — comma-separated SCIM ids to own the seeded
 *   dataset. Unset ⇒ the seed keeps its sample owner, which no real user signs
 *   in as. Set it per deployment (e.g. a preview's UAT reviewer); it names who
 *   owns sample data and never changes who the signed-in user is (ADR-0004).
 *
 * Returns ids only, no secrets.
 */

/** Read one env var, preferring `process.env`, then a platform-passed env object. */
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

/** Parse a comma-separated id list, dropping blanks and duplicates. */
export function parseOwnerIds(raw: string | undefined): string[] {
  const ids = (raw ?? "").split(",").map((id) => id.trim());
  return [...new Set(ids.filter((id) => id !== ""))];
}

/** Handle `GET /api/seed-config`. */
export function handleSeedConfigRequest(env?: unknown): Response {
  const body = { datasetOwnerIds: parseOwnerIds(envValue(env, "EDP_SEED_DATASET_OWNER_IDS")) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
