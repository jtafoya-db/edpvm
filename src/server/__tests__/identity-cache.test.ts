import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchMe, ScimMe } from "../identity";
import {
  createIdentityCache,
  identityCacheKey,
  identityCacheTtlFromEnv,
  MAX_IDENTITY_CACHE_TTL_MS,
} from "../identity-cache";
import { resetSessionIdentityCacheForTests, resolveSessionIdentity } from "../session";

const HOST = "https://ws.example.databricks.com";
const TOKEN_A = "obo-token-A-SECRET";
const TOKEN_B = "obo-token-B-SECRET";

/** A `/Me` that answers with a principal named after the token it was given. */
function fakeMe() {
  return vi.fn<FetchMe>(async (token) => ({ id: `scim-${token}`, userName: token }));
}

function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe("identity cache — one SCIM /Me per token per TTL", () => {
  it("asks /Me once for repeat calls with the same token inside the TTL", async () => {
    const me = fakeMe();
    const fetchMe = createIdentityCache({ ttlMs: 60_000 }).wrap(me, HOST);

    for (let i = 0; i < 5; i++) expect((await fetchMe(TOKEN_A)).id).toBe(`scim-${TOKEN_A}`);
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight /Me between concurrent calls with the same token", async () => {
    let release!: (me: ScimMe) => void;
    const me = vi.fn<FetchMe>(() => new Promise((resolve) => (release = resolve)));
    const fetchMe = createIdentityCache().wrap(me, HOST);

    const calls = Promise.all([fetchMe(TOKEN_A), fetchMe(TOKEN_A), fetchMe(TOKEN_A)]);
    await vi.waitFor(() => expect(me).toHaveBeenCalled());
    release({ id: "scim-1" });

    expect((await calls).map((m) => m.id)).toEqual(["scim-1", "scim-1", "scim-1"]);
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("never gives one token's answer to a different token", async () => {
    const me = fakeMe();
    const fetchMe = createIdentityCache().wrap(me, HOST);

    const [a, b] = await Promise.all([fetchMe(TOKEN_A), fetchMe(TOKEN_B)]);
    expect(a.id).toBe(`scim-${TOKEN_A}`);
    expect(b.id).toBe(`scim-${TOKEN_B}`);
    expect((await fetchMe(TOKEN_B)).id).toBe(`scim-${TOKEN_B}`);
    expect(me).toHaveBeenCalledTimes(2);
    expect(me).toHaveBeenCalledWith(TOKEN_A);
    expect(me).toHaveBeenCalledWith(TOKEN_B);
  });

  it("asks /Me again once the TTL has passed", async () => {
    const time = clock();
    const me = fakeMe();
    const fetchMe = createIdentityCache({ ttlMs: 60_000, now: time.now }).wrap(me, HOST);

    await fetchMe(TOKEN_A);
    time.advance(59_999);
    await fetchMe(TOKEN_A);
    expect(me).toHaveBeenCalledTimes(1);
    time.advance(1);
    await fetchMe(TOKEN_A);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache a /Me failure", async () => {
    const me = vi
      .fn<FetchMe>()
      .mockRejectedValueOnce(new Error("SCIM down"))
      .mockResolvedValueOnce({ id: "scim-1" });
    const fetchMe = createIdentityCache().wrap(me, HOST);

    await expect(fetchMe(TOKEN_A)).rejects.toThrow("SCIM down");
    expect((await fetchMe(TOKEN_A)).id).toBe("scim-1");
    expect(me).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no id", { userName: "someone@example.test" }],
    ["an empty id", { id: "" }],
    ["a blank id", { id: "   " }],
    ["a non-string id", { id: 42 }],
    ["a null body", null],
  ])("doesn't cache a 200 /Me with %s; the next call asks again", async (_label, body) => {
    const me = vi
      .fn<FetchMe>()
      .mockResolvedValueOnce(body as ScimMe)
      .mockResolvedValueOnce({ id: "scim-1" });
    const cache = createIdentityCache();
    const fetchMe = cache.wrap(me, HOST);

    await expect(fetchMe(TOKEN_A)).rejects.toMatchObject({
      status: 502,
      message: "SCIM /Me returned no stable principal id.",
    });
    expect(cache.keys()).toEqual([]);
    expect((await fetchMe(TOKEN_A)).id).toBe("scim-1");
    await fetchMe(TOKEN_A);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("caps the TTL at 5 minutes", async () => {
    const time = clock();
    const me = fakeMe();
    const fetchMe = createIdentityCache({ ttlMs: 3_600_000, now: time.now }).wrap(me, HOST);
    await fetchMe(TOKEN_A);
    time.advance(MAX_IDENTITY_CACHE_TTL_MS);
    await fetchMe(TOKEN_A);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("stores a SHA-256 of the token, never the token itself", async () => {
    const cache = createIdentityCache();
    await cache.wrap(fakeMe(), HOST)(TOKEN_A);

    const keys = cache.keys();
    expect(keys).toEqual([await identityCacheKey(HOST, TOKEN_A)]);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keys)).not.toContain(TOKEN_A);
  });

  it("keeps a token's entries for different workspace hosts apart", async () => {
    const cache = createIdentityCache();
    const me = fakeMe();
    await cache.wrap(me, HOST)(TOKEN_A);
    await cache.wrap(me, "https://other.example.databricks.com")(TOKEN_A);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("holds at most maxEntries, dropping the least recently used", async () => {
    const me = fakeMe();
    const fetchMe = createIdentityCache({ maxEntries: 2 }).wrap(me, HOST);

    await fetchMe("t1");
    await fetchMe("t2");
    await fetchMe("t1"); // t1 is now the most recently used
    await fetchMe("t3"); // evicts t2
    await fetchMe("t1");
    expect(me.mock.calls.map(([token]) => token)).toEqual(["t1", "t2", "t3"]);
    await fetchMe("t2");
    expect(me).toHaveBeenCalledTimes(4);
  });

  it("asks /Me every time when the TTL is 0", async () => {
    const me = fakeMe();
    const fetchMe = createIdentityCache({ ttlMs: 0 }).wrap(me, HOST);
    await fetchMe(TOKEN_A);
    await fetchMe(TOKEN_A);
    expect(me).toHaveBeenCalledTimes(2);
  });
});

describe("EDP_IDENTITY_CACHE_TTL_MS", () => {
  it.each([
    [undefined, 60_000],
    ["", 60_000],
    ["abc", 60_000],
    ["-5", 60_000],
    ["0", 0],
    ["1500", 1_500],
    ["300000", 300_000],
  ])("reads %j as %d ms with no warning", (raw, ttlMs) => {
    expect(identityCacheTtlFromEnv(raw)).toEqual({ ttlMs });
  });

  it("clamps anything over 5 minutes and says so", () => {
    const { ttlMs, warning } = identityCacheTtlFromEnv("3600000");
    expect(ttlMs).toBe(300_000);
    expect(warning).toMatch(/EDP_IDENTITY_CACHE_TTL_MS=3600000 .*300000 ms/);
  });
});

describe("resolveSessionIdentity — the cached seam", () => {
  afterEach(() => {
    resetSessionIdentityCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function stubScim() {
    vi.stubEnv("DATABRICKS_HOST", HOST);
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const token = String(new Headers(init?.headers).get("authorization")).slice(7);
      return new Response(
        JSON.stringify({
          id: `scim-${token}`,
          userName: `${token}@example.test`,
          groups: token === TOKEN_A ? [{ value: "grp-admin" }] : [],
        }),
        { status: 200 },
      );
    });
  }

  const requestWith = (token: string) =>
    new Request("https://app.example/api/reads/catalog/datasets", {
      headers: { "x-forwarded-access-token": token },
    });

  /**
   * A staff first load of the legacy shell, 0 requests: `/api/session` once,
   * then 9 read endpoints, each resolving the caller (.polly/research/delta-perf.md).
   */
  async function firstLoad(token: string) {
    await Promise.all(Array.from({ length: 10 }, () => resolveSessionIdentity(requestWith(token))));
  }

  it("cuts a first page load from one SCIM /Me per endpoint to one", async () => {
    vi.stubEnv("EDP_IDENTITY_CACHE_TTL_MS", "0");
    const uncached = stubScim();
    await firstLoad(TOKEN_A);
    expect(uncached).toHaveBeenCalledTimes(10);

    resetSessionIdentityCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    const cached = stubScim();
    await firstLoad(TOKEN_A);
    expect(cached).toHaveBeenCalledTimes(1);
  });

  it("resolves each request as the person whose token it carries", async () => {
    const scim = stubScim();
    const a = await resolveSessionIdentity(requestWith(TOKEN_A));
    const b = await resolveSessionIdentity(requestWith(TOKEN_B));
    const a2 = await resolveSessionIdentity(requestWith(TOKEN_A));

    expect([a.principalId, a.isAdmin]).toEqual([`scim-${TOKEN_A}`, true]);
    expect([b.principalId, b.isAdmin]).toEqual([`scim-${TOKEN_B}`, false]);
    expect(a2.principalId).toBe(`scim-${TOKEN_A}`);
    expect(scim).toHaveBeenCalledTimes(2);
  });

  it("warns once when the configured TTL is clamped", async () => {
    vi.stubEnv("EDP_IDENTITY_CACHE_TTL_MS", "999999999");
    const scim = stubScim();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveSessionIdentity(requestWith(TOKEN_A));
    await resolveSessionIdentity(requestWith(TOKEN_A));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/clamp|maximum/);
    expect(scim).toHaveBeenCalledTimes(1);
  });

  it("doesn't keep a 200 /Me without a stable id for the token", async () => {
    vi.stubEnv("DATABRICKS_HOST", HOST);
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    const scim = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ userName: "x" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "scim-1" }), { status: 200 }));

    await expect(resolveSessionIdentity(requestWith(TOKEN_A))).rejects.toThrow(
      /no stable principal id/,
    );
    expect((await resolveSessionIdentity(requestWith(TOKEN_A))).principalId).toBe("scim-1");
    expect(scim).toHaveBeenCalledTimes(2);
  });

  it("asks SCIM again after a failed /Me rather than failing the next request", async () => {
    vi.stubEnv("DATABRICKS_HOST", HOST);
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    const scim = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "scim-1" }), { status: 200 }));

    await expect(resolveSessionIdentity(requestWith(TOKEN_A))).rejects.toThrow(/SCIM \/Me/);
    expect((await resolveSessionIdentity(requestWith(TOKEN_A))).principalId).toBe("scim-1");
    expect(scim).toHaveBeenCalledTimes(2);
  });
});
