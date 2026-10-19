import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../adapters/memory";
import { makeNewRequest, makeSnapshot } from "./fixture";

describe("createMemoryStore — the in-memory adapter satisfies the seam contract", () => {
  it("reading the current privacy acknowledgment does not record one", async () => {
    const store = createMemoryStore(makeSnapshot());

    expect(await store.privacyAcknowledgments.current()).toBeNull();
    expect(await store.privacyAcknowledgments.history()).toEqual([]);
  });
  it("reads catalog reference data (list + get round-trip)", async () => {
    const store = createMemoryStore(makeSnapshot());

    expect(await store.catalog.listSystems()).toHaveLength(2);
    expect(await store.catalog.listDomains()).toHaveLength(2);
    expect(await store.catalog.listBundles()).toHaveLength(2);
    expect(await store.catalog.listDatasets()).toHaveLength(1);
    expect(await store.catalog.listPersonas()).toHaveLength(1);
    expect(await store.catalog.listTenants()).toHaveLength(1);

    const domain = await store.catalog.getDomain("individual-filing");
    expect(domain?.name).toBe("Individual Filing");
    const dataset = await store.catalog.getDataset("imf-account-balances");
    expect(dataset?.businessName).toBe("IMF Account Balance Snapshot");
    expect(await store.catalog.getBundle("nope")).toBeUndefined();
    expect((await store.catalog.getUser()).initials).toBe("TA");
  });

  it("returns copies so mutating a read cannot corrupt the store or seed", async () => {
    const seed = makeSnapshot();
    const store = createMemoryStore(seed);

    const first = await store.catalog.listDatasets();
    first[0]!.businessName = "MUTATED";
    const second = await store.catalog.listDatasets();
    expect(second[0]?.businessName).toBe("IMF Account Balance Snapshot");
    expect(seed.datasets[0]?.businessName).toBe("IMF Account Balance Snapshot");
  });

  it("reads requests and the pipeline", async () => {
    const store = createMemoryStore(makeSnapshot());

    const requests = await store.requests.listRequests();
    expect(requests.map((r) => r.id)).toEqual(["REQ-2038", "REQ-2052"]);
    expect((await store.requests.getRequest("REQ-2052"))?.status).toBe("Action needed");
    expect(await store.requests.getRequest("missing")).toBeUndefined();
    expect(await store.requests.listPipeline()).toHaveLength(1);
  });

  it("writes a new request and reads it back (round-trip)", async () => {
    const store = createMemoryStore(makeSnapshot());
    const created = await store.requests.createRequest(makeNewRequest());

    expect(created.id).toBe("REQ-9001");
    const list = await store.requests.listRequests();
    expect(list).toHaveLength(3);
    expect(list[0]?.id).toBe("REQ-9001"); // newest first
    expect((await store.requests.getRequest("REQ-9001"))?.title).toContain("Domain Consumer");
  });

  it("does not mutate the seed snapshot when writing", async () => {
    const seed = makeSnapshot();
    const store = createMemoryStore(seed);
    await store.requests.createRequest(makeNewRequest());

    expect(seed.requests).toHaveLength(2); // seed untouched
  });

  it("projects a request's status/timeline", async () => {
    const store = createMemoryStore(makeSnapshot());

    expect(await store.status.listStages()).toHaveLength(6);
    const status = await store.status.getRequestStatus("REQ-2052");
    expect(status).toMatchObject({
      requestId: "REQ-2052",
      status: "Action needed",
      overall: "Provisioning failed",
      stageIndex: 4,
    });
    expect(status?.subRequests.some((s) => s.status === "blocked")).toBe(true);
    expect(await store.status.getRequestStatus("missing")).toBeUndefined();

    const myAccess = await store.status.getMyAccess();
    expect(myAccess.domains).toEqual(["individual-filing"]);
  });
});
