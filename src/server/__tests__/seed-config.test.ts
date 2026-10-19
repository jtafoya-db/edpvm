import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSeedConfigRequest } from "../seed-config";

describe("handleSeedConfigRequest — seed configuration from env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured dataset owner SCIM ids, trimmed and de-duplicated", async () => {
    vi.stubEnv("EDP_SEED_DATASET_OWNER_IDS", " scim-1, scim-2,,scim-1 ");

    const response = handleSeedConfigRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ datasetOwnerIds: ["scim-1", "scim-2"] });
  });

  it("returns no owners when unset, so the seed keeps its sample owner", async () => {
    vi.stubEnv("EDP_SEED_DATASET_OWNER_IDS", "");

    expect(await handleSeedConfigRequest().json()).toEqual({ datasetOwnerIds: [] });
  });

  it("reads a platform-passed env object when process.env has no value", async () => {
    vi.stubEnv("EDP_SEED_DATASET_OWNER_IDS", "");

    const response = handleSeedConfigRequest({ EDP_SEED_DATASET_OWNER_IDS: "scim-9" });
    expect(await response.json()).toEqual({ datasetOwnerIds: ["scim-9"] });
  });
});
