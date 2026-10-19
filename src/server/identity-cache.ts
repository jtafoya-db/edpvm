/**
 * A short-lived, per-token cache around the SCIM `/Me` call (#168).
 *
 * Every `/api/session`, read and command resolves identity, and a first page
 * load makes about a dozen of them with the same forwarded token. This keeps
 * one `/Me` answer per token for a short TTL and shares an in-flight lookup
 * between concurrent callers.
 *
 * What it guarantees:
 * - The key is a SHA-256 of the token (plus the workspace host). The raw token
 *   is never stored, so a different token never reuses an entry.
 * - Only an answer the resolver would accept is cached: one with a stable
 *   principal id. A failed `/Me`, or a 200 without a usable id, is not cached
 *   and the next call asks SCIM again.
 * - The TTL is capped at {@link MAX_IDENTITY_CACHE_TTL_MS}.
 * - Entries expire `ttlMs` after `/Me` answered; the size is bounded and the
 *   least recently used entry goes first.
 *
 * It caches the raw `/Me` answer only. Admin and reviewer roles are still
 * derived from it on every request, and the actor for a write is still the
 * identity resolved for that request's own token. A group change or role
 * revocation takes up to one TTL to show; a TTL of `0` makes it immediate.
 */
import {
  hasStablePrincipalId,
  missingPrincipalIdError,
  type FetchMe,
  type ScimMe,
} from "./identity";

export const DEFAULT_IDENTITY_CACHE_TTL_MS = 60_000;
/** The longest a `/Me` answer may be reused, whatever the env says. */
export const MAX_IDENTITY_CACHE_TTL_MS = 300_000;
export const DEFAULT_IDENTITY_CACHE_MAX_ENTRIES = 1_000;

export interface IdentityCacheOptions {
  /** How long a `/Me` answer is reused, capped at 5 minutes. `0` turns the cache off. */
  ttlMs?: number;
  maxEntries?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

export interface IdentityCache {
  /** Wrap a `/Me` fetch for one workspace host so repeat calls with a token share one answer. */
  wrap(fetchMe: FetchMe, scope: string): FetchMe;
  /** The stored keys (token hashes), for tests. */
  keys(): string[];
  clear(): void;
}

interface Entry {
  promise: Promise<ScimMe>;
  /** `Infinity` while the lookup is in flight. */
  expiresAt: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read `EDP_IDENTITY_CACHE_TTL_MS`. Unset, non-numeric or negative gives the
 * 60s default; `0` turns the cache off; anything over 5 minutes is clamped,
 * with a `warning` for the caller to log.
 */
export function identityCacheTtlFromEnv(raw: string | undefined): {
  ttlMs: number;
  warning?: string;
} {
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) return { ttlMs: DEFAULT_IDENTITY_CACHE_TTL_MS };
  if (value > MAX_IDENTITY_CACHE_TTL_MS) {
    return {
      ttlMs: MAX_IDENTITY_CACHE_TTL_MS,
      warning:
        `EDP_IDENTITY_CACHE_TTL_MS=${raw} is over the ${MAX_IDENTITY_CACHE_TTL_MS} ms maximum; ` +
        `using ${MAX_IDENTITY_CACHE_TTL_MS} ms.`,
    };
  }
  return { ttlMs: value };
}

/** The cache key for a token: never the token itself. */
export function identityCacheKey(scope: string, accessToken: string): Promise<string> {
  return sha256Hex(`${scope}\n${accessToken}`);
}

export function createIdentityCache(options: IdentityCacheOptions = {}): IdentityCache {
  const ttlMs = Math.min(
    MAX_IDENTITY_CACHE_TTL_MS,
    Math.max(0, options.ttlMs ?? DEFAULT_IDENTITY_CACHE_TTL_MS),
  );
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_IDENTITY_CACHE_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function makeRoom(): void {
    const time = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
  }

  return {
    wrap(fetchMe, scope) {
      if (ttlMs === 0) return fetchMe;
      return async (accessToken) => {
        const key = await identityCacheKey(scope, accessToken);
        const hit = entries.get(key);
        if (hit && hit.expiresAt > now()) {
          // Most recently used goes to the back of the eviction order.
          entries.delete(key);
          entries.set(key, hit);
          return hit.promise;
        }
        entries.delete(key);
        makeRoom();
        // Validate before caching, so a body the resolver would refuse isn't kept.
        const promise = fetchMe(accessToken).then((me) => {
          if (!hasStablePrincipalId(me)) throw missingPrincipalIdError();
          return me;
        });
        const entry: Entry = { promise, expiresAt: Infinity };
        entries.set(key, entry);
        entry.promise.then(
          () => {
            entry.expiresAt = now() + ttlMs;
          },
          () => {
            if (entries.get(key) === entry) entries.delete(key);
          },
        );
        return entry.promise;
      };
    },
    keys: () => [...entries.keys()],
    clear: () => entries.clear(),
  };
}
