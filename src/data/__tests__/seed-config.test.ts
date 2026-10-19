import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSeedOwnerIds } from "../datasets/seed-config";

describe("fetchSeedOwnerIds reads only the server's JSON (#189)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the configured owner ids", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ datasetOwnerIds: ["123", ""] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await fetchSeedOwnerIds()).toEqual(["123"]);
  });

  it("falls back to the seed's own owner for the proxy's sign-in page or a gateway page", async () => {
    for (const status of [200, 502]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("<!DOCTYPE html><html>Sign in</html>", {
          status,
          headers: { "content-type": "text/html" },
        }),
      );
      expect(await fetchSeedOwnerIds()).toBeNull();
    }
  });
});
