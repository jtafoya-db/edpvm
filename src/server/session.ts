/**
 * The `/api/session` endpoint — the server-side identity seam the client reads.
 *
 * The UI is client-only, so SSR context alone can't replace the hardcoded seed
 * user. This endpoint resolves the REAL signed-in Databricks App identity
 * server-side (via the pure resolver in `identity.ts`) and returns a SANITIZED
 * {@link UserProfile} — principal id, username, email, display name and the
 * server-derived `isAdmin`. It NEVER returns the OBO token.
 *
 * Config comes from the server environment:
 * - `DATABRICKS_HOST`         — workspace host for the SCIM `/Me` call.
 * - `EDP_ADMIN_GROUP_ID`      — stable SCIM id of the EDP admin group. In the MVP
 *                               direct membership in it (workspace-visible) gives
 *                               every staff role: `isAdmin`, `isSafeguardsValidator` and
 *                               both onboarding reviewer roles (#226). Unset ⇒
 *                               nobody holds a staff role. Requires the admin group
 *                               be assigned to the app's workspace; account-wide
 *                               lookup would need the app service principal (out
 *                               of scope here). `EDP_SAFEGUARDS_VALIDATOR_GROUP_ID`,
 *                               `EDP_BUSINESS_OFFICE_GROUP_ID` and `EDP_CCB_GROUP_ID`
 *                               are reserved for a later role split and ignored.
 * - `EDP_DEV_GROUP_IDS`       — comma-separated group ids the LOCAL DEV fallback
 *                               is treated as a member of. Its staff roles come
 *                               from them exactly as anyone's do: every role if
 *                               they include `EDP_ADMIN_GROUP_ID`, none otherwise,
 *                               and none when no admin group is configured (#226).
 *                               Never applies to a real forwarded identity, and
 *                               ignored (with a warning) unless
 *                               EDP_IDENTITY_MODE=development AND NODE_ENV is
 *                               exactly `development`. (`EDP_DEV_REVIEWER_ROLES`
 *                               was removed by #226 and only warns.)
 * - `EDP_IDENTITY_MODE`       — `development` | `production`; defaults from
 *                               `NODE_ENV` (Databricks Apps run production).
 * - `EDP_IDENTITY_CACHE_TTL_MS` — how long one token's SCIM `/Me` answer is
 *                               reused (#168, `identity-cache.ts`). Default
 *                               60000, at most 300000 (clamped, with a
 *                               warning); `0` asks SCIM on every request, so
 *                               a role revocation applies immediately.
 *
 * Non-identity display fields (title/tenant/onboarding-lead) are stubbed from a
 * documented default until a profile table exists (ADR-0004, decision 3).
 */
import { eirSelfValidationFromEnv } from "./eir-test-mode.ts";
import { sampleAccessRequestsFromEnv } from "./sample-access-requests.ts";
import type { UserProfile } from "../data/types";
import type { SessionUser } from "./delta/registry.ts";
import { configuredSlaConfig } from "./sla-config.ts";
import { isPersonNameSource } from "../data/person-name.ts";
import {
  IdentityResolutionError,
  readForwardedHeaders,
  resolveIdentity,
  type FetchMe,
  type IdentityMode,
  type ResolvedIdentity,
} from "./identity";
import {
  createIdentityCache,
  identityCacheTtlFromEnv,
  type IdentityCache,
} from "./identity-cache.ts";

/**
 * Local-dev identity used only when forwarded headers are absent AND mode is
 * `development`. Clearly marked. Its staff roles come only from the admin
 * group, through `EDP_DEV_GROUP_IDS` (see `readDevGroupIds`).
 */
const DEV_FALLBACK_IDENTITY: ResolvedIdentity = {
  principalId: "dev-local-user",
  username: "local-dev",
  email: "local-dev@edp.invalid",
  displayName: "Local Dev (unauthenticated)",
  isAdmin: false,
  isDevFallback: true,
};

/**
 * Display-only profile fields not carried by identity. Stubbed until a profile
 * table lands (ADR-0004, decision 3 — principal id + username are the real data).
 */
const PROFILE_DEFAULTS = {
  title: "EDP User",
  tenant: "IRS Enterprise Data Platform",
  isOnboardingLead: false,
} as const;

/** Read one env var, preferring the node `process.env`, then a platform-passed env object. */
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

/** Normalize a workspace host into an origin (add scheme, strip trailing slash). */
function normalizeHost(host: string): string {
  const withScheme = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return withScheme.replace(/\/+$/, "");
}

function resolveMode(env: unknown): IdentityMode {
  const explicit = envValue(env, "EDP_IDENTITY_MODE");
  if (explicit === "production" || explicit === "development") return explicit;
  return envValue(env, "NODE_ENV") === "production" ? "production" : "development";
}

/** Build the real SCIM `/Me` fetch against the workspace host. */
function makeScimFetchMe(host: string): FetchMe {
  return async (accessToken) => {
    const response = await fetch(`${host}/api/2.0/preview/scim/v2/Me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new IdentityResolutionError(
        `SCIM /Me request failed (${response.status}).`,
        response.status === 401 || response.status === 403 ? 401 : 502,
      );
    }
    return (await response.json()) as Awaited<ReturnType<FetchMe>>;
  };
}

let identityCache: { ttlMs: number; cache: IdentityCache } | undefined;

/** The process-wide `/Me` cache, rebuilt if the configured TTL changes. */
function sessionIdentityCache(env: unknown): IdentityCache {
  const { ttlMs, warning } = identityCacheTtlFromEnv(envValue(env, "EDP_IDENTITY_CACHE_TTL_MS"));
  if (identityCache?.ttlMs !== ttlMs) {
    if (warning) console.warn(`[identity] ${warning}`);
    identityCache = { ttlMs, cache: createIdentityCache({ ttlMs }) };
  }
  return identityCache.cache;
}

/** Forget every cached `/Me` answer. Tests only. */
export function resetSessionIdentityCacheForTests(): void {
  identityCache = undefined;
}

/**
 * Initials from a person's display name (first letters of the first two
 * words). None for an email, username or placeholder fallback: the avatar
 * shows a neutral glyph rather than letters of an identifier.
 */
function initialsOf(identity: ResolvedIdentity): string {
  if (!isPersonNameSource(identity.nameSource)) return "";
  const { displayName } = identity;
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || displayName.slice(0, 2)).toUpperCase();
}

function supportEmailFromEnv(env?: unknown): string | undefined {
  const email = envValue(env, "EDP_EIR_SUPPORT_EMAIL")?.trim();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/** Map the resolved identity onto the client-facing (sanitized) UserProfile. */
function toUserProfile(identity: ResolvedIdentity, env?: unknown): UserProfile {
  const supportEmail = supportEmailFromEnv(env);
  return {
    principalId: identity.principalId,
    name: identity.displayName,
    ...(identity.givenName ? { givenName: identity.givenName } : {}),
    ...(identity.familyName ? { familyName: identity.familyName } : {}),
    ...(identity.nameSource ? { nameSource: identity.nameSource } : {}),
    initials: initialsOf(identity),
    email: identity.email,
    isAdmin: identity.isAdmin,
    isSafeguardsValidator: identity.isSafeguardsValidator ?? false,
    onboardingReviewerRoles: identity.onboardingReviewerRoles ?? [],
    title: PROFILE_DEFAULTS.title,
    tenant: PROFILE_DEFAULTS.tenant,
    isOnboardingLead: PROFILE_DEFAULTS.isOnboardingLead,
    slaConfig: configuredSlaConfig(),
    ...(supportEmail ? { supportEmail } : {}),
    // Only a validator on a PR preview with the flag on sees the mode: no trace otherwise.
    ...(identity.isSafeguardsValidator && eirSelfValidationFromEnv(env)
      ? { eirSelfDecisionTestMode: true }
      : {}),
    // Only a PR preview with the switch on has sample access requests (#312).
    ...(sampleAccessRequestsFromEnv(env) ? { sampleAccessRequests: true } : {}),
  };
}

/**
 * The groups the local dev fallback identity counts as a member of. A positive
 * allowlist: honoured only when the identity mode is `development` AND
 * NODE_ENV, trimmed and lower-cased, is exactly `development`. Anything else
 * (unset, empty, `production` in any casing, `staging`, `test`, …) ignores the
 * setting and logs a warning.
 */
function readDevGroupIds(env: unknown, mode: IdentityMode): string[] {
  if (envValue(env, "EDP_DEV_REVIEWER_ROLES") !== undefined) {
    console.warn(
      "[/api/session] EDP_DEV_REVIEWER_ROLES was removed (#226) and grants nothing: " +
        "set EDP_DEV_GROUP_IDS to include EDP_ADMIN_GROUP_ID instead.",
    );
  }
  const raw = envValue(env, "EDP_DEV_GROUP_IDS");
  if (raw === undefined) return [];
  const nodeEnv = (envValue(env, "NODE_ENV") ?? "").trim().toLowerCase();
  if (mode !== "development" || nodeEnv !== "development") {
    console.warn(
      "[/api/session] EDP_DEV_GROUP_IDS is set but ignored: it applies only when " +
        "EDP_IDENTITY_MODE=development and NODE_ENV=development.",
    );
    return [];
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Resolve the signed-in person for a request, server-side. Shared by
 * `/api/session` and the Delta command and read API, which takes the actor
 * from here and never from a request body. Throws
 * {@link IdentityResolutionError} when there is no identity.
 */
export async function resolveSessionIdentity(
  request: Request,
  env?: unknown,
): Promise<ResolvedIdentity> {
  const headers = readForwardedHeaders(request.headers);
  const mode = resolveMode(env);
  const adminGroupId = envValue(env, "EDP_ADMIN_GROUP_ID");

  // A host is only required once we actually have a token to exchange at SCIM.
  let fetchMe: FetchMe;
  if (headers.accessToken?.trim()) {
    const host = envValue(env, "DATABRICKS_HOST");
    if (!host) {
      throw new IdentityResolutionError(
        "DATABRICKS_HOST is not configured; cannot resolve identity via SCIM /Me.",
        500,
      );
    }
    const origin = normalizeHost(host);
    fetchMe = sessionIdentityCache(env).wrap(makeScimFetchMe(origin), origin);
  } else {
    // No token: resolver takes the dev-fallback (development) or throws (production).
    fetchMe = async () => {
      throw new IdentityResolutionError("Unreachable: no token to exchange.", 500);
    };
  }

  const config = {
    mode,
    devFallback: DEV_FALLBACK_IDENTITY,
    devFallbackGroupIds: readDevGroupIds(env, mode),
    ...(adminGroupId ? { adminGroupId } : {}),
  };

  return resolveIdentity({ headers, fetchMe, config });
}

/** The resolved identity as the command, read and EIR definition APIs see it. */
export function toSessionUser(identity: ResolvedIdentity): SessionUser {
  return {
    principalId: identity.principalId,
    displayName: identity.displayName,
    email: identity.email,
    isAdmin: identity.isAdmin,
    onboardingReviewerRoles: identity.onboardingReviewerRoles ?? [],
    isSafeguardsValidator: identity.isSafeguardsValidator ?? false,
  };
}

/**
 * Handle `GET /api/session`: resolve the real identity server-side and return
 * the sanitized profile. `env` is the platform env object (Cloudflare worker
 * binding); `process.env` takes precedence for the node-server (Databricks App) target.
 */
export async function handleSessionRequest(request: Request, env?: unknown): Promise<Response> {
  try {
    const identity = await resolveSessionIdentity(request, env);
    return jsonResponse(toUserProfile(identity, env));
  } catch (error) {
    const status = error instanceof IdentityResolutionError ? error.status : 502;
    const message = error instanceof Error ? error.message : "Failed to resolve identity.";
    console.error("[/api/session] identity resolution failed:", message);
    return jsonResponse({ error: message }, status);
  }
}

/** Resolve a request to the sanitized profile for other authenticated server endpoints. */
export async function resolveSessionProfile(request: Request, env?: unknown): Promise<UserProfile> {
  return toUserProfile(await resolveSessionIdentity(request, env), env);
}
