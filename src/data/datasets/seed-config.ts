/**
 * Client read of the seed configuration served by `/api/seed-config`
 * (src/server/seed-config.ts).
 *
 * The in-memory adapter runs in the browser, but who owns the seeded dataset
 * is deployment configuration (`EDP_SEED_DATASET_OWNER_IDS`), so it's read
 * from the server. A preview can name its UAT reviewer as the owner with no
 * code change and no impersonation: the reviewer still signs in as themselves.
 */
import { readApiResponse } from "../api-response";

/**
 * The configured owner SCIM ids, or `null` when none are configured or the
 * endpoint can't be read. `null` means "use the seed's own owner", a sample
 * principal no real user signs in as, so a failure never grants ownership.
 */
export async function fetchSeedOwnerIds(): Promise<string[] | null> {
  try {
    const response = await fetch("/api/seed-config", { headers: { accept: "application/json" } });
    // Any answer that isn't the server's OK JSON (#189) is a failure: `null`.
    const body = await readApiResponse<{ datasetOwnerIds?: unknown } | null>(
      response,
      { write: false },
      "The seed configuration couldn't be read.",
    );
    const configured = body?.datasetOwnerIds;
    const ids = Array.isArray(configured)
      ? configured.filter((id): id is string => typeof id === "string" && id !== "")
      : [];
    return ids.length > 0 ? ids : null;
  } catch {
    // No reachable server (unit tests, local dev without the server).
    return null;
  }
}
