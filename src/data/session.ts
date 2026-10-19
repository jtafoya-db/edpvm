/**
 * Client read of the server-resolved session identity (`/api/session`).
 *
 * The UI is client-only, so it learns WHO the user is by fetching this endpoint,
 * which resolves the real Databricks App identity server-side (see
 * `src/server/session.ts`). The seam's `getUser()` consumes this; the profile is
 * sanitized (no token) and its `isAdmin` is server-derived.
 *
 * Error posture matters for honesty:
 * - A NETWORK failure (no server at all — unit tests / SSR) returns `null` so the
 *   caller can fall back to the local dev seed.
 * - An HTTP ERROR status (e.g. 401 in a misconfigured deployed app) THROWS, so the
 *   app surfaces an error instead of silently impersonating the seed user.
 * - The proxy's sign-in page, or any other non-JSON answer, THROWS the shared
 *   client's typed error (#189), never a JSON parse error.
 */
import { readApiResponse } from "./api-response";
import type { UserProfile } from "./types";

/** GET `/api/session`. Returns the profile, `null` when no server is reachable, or throws on an HTTP error. */
export async function fetchSessionProfile(): Promise<UserProfile | null> {
  let response: Response;
  try {
    response = await fetch("/api/session", { headers: { accept: "application/json" } });
  } catch {
    // No reachable server (local unit tests / SSR without a running endpoint).
    return null;
  }
  return readApiResponse<UserProfile>(
    response,
    { write: false },
    `/api/session responded ${response.status}`,
  );
}
