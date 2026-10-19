import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryStore } from "../adapters/memory";
import { fetchSessionProfile } from "../session";
import { makeSnapshot } from "./fixture";
import type { UserProfile } from "../types";

/** A resolved-profile Response for /api/session. */
function sessionResponse(profile: Partial<UserProfile>, status = 200): Response {
  return new Response(JSON.stringify(profile), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchSessionProfile — transport contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the profile on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sessionResponse({ principalId: "p1", isAdmin: false }),
    );
    const profile = await fetchSessionProfile();
    expect(profile?.principalId).toBe("p1");
  });

  it("returns null ONLY on a network-level failure (no reachable server)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await fetchSessionProfile()).toBeNull();
  });

  it("THROWS on a non-200 (never silently null) so callers fail closed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sessionResponse({}, 403));
    await expect(fetchSessionProfile()).rejects.toThrow(/403/);
  });

  it("THROWS 'sign-in expired' on a 401 or the proxy's sign-in page, never a parse error (#189)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sessionResponse({}, 401));
    await expect(fetchSessionProfile()).rejects.toMatchObject({ code: "session-expired" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!DOCTYPE html><html>Sign in</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(fetchSessionProfile()).rejects.toMatchObject({
      code: "session-expired",
      message: "Your sign-in has expired. Reload the page to sign in again.",
    });
  });
});

describe("memory adapter getUser — fail-closed vs local-dev fallback", () => {
  // The fixture seed is an admin (isAdmin:true). It must NEVER be handed out in
  // a production build when /api/session cannot be reached.
  beforeEach(() => {
    expect(makeSnapshot().user.isAdmin).toBe(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("PRODUCTION + network-unreachable /api/session → fails closed (throws), never the admin seed", async () => {
    vi.stubEnv("DEV", false);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const store = createMemoryStore(makeSnapshot());
    await expect(store.catalog.getUser()).rejects.toThrow(/production build/i);
  });

  it("PRODUCTION + non-200 /api/session → fails closed (throws), never the admin seed", async () => {
    vi.stubEnv("DEV", false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sessionResponse({}, 500));

    const store = createMemoryStore(makeSnapshot());
    await expect(store.catalog.getUser()).rejects.toThrow();
  });

  it("DEVELOPMENT + no server → falls back to the seed profile but NON-admin (isAdmin false)", async () => {
    vi.stubEnv("DEV", true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const store = createMemoryStore(makeSnapshot());
    const user = await store.catalog.getUser();

    expect(user.initials).toBe("TA"); // the seed profile (developer convenience)
    expect(user.isAdmin).toBe(false); // but the no-server fallback never grants admin
  });

  it("resolves the REAL server identity when /api/session answers (no fallback)", async () => {
    vi.stubEnv("DEV", false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sessionResponse({ principalId: "real-1", name: "Real User", initials: "RU", isAdmin: true }),
    );

    const store = createMemoryStore(makeSnapshot());
    const user = await store.catalog.getUser();

    expect(user.principalId).toBe("real-1");
    expect(user.initials).toBe("RU");
    expect(user.isAdmin).toBe(true); // server-derived, honored
  });
});
