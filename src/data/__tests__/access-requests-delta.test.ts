// Access requests aren't persisted in Delta yet. In Delta mode they run on the
// in-memory repository (the `access-request-persistence` stub), on top of the
// Delta dataset and dataset-role stores (#123), so an approval adds the member
// in Delta exactly as a direct add does. The full request behaviour is
// covered by access-requests.test.ts through the memory adapter. These tests
// pin the boundary: approval writes the member and entry through the Delta
// API, the request itself never reaches it, and it fails closed without an
// identity.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeltaStore, type DeltaApiTransport } from "../adapters/delta";
import {
  DATASET_ID,
  OWNER,
  STRANGER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "./dataset-fixture";
import { createDeltaHarness } from "./team-backends";

function silentTransport(): DeltaApiTransport {
  return { read: vi.fn(), command: vi.fn(), legacyWrite: vi.fn() };
}

describe("Delta adapter: access requests are an in-memory stub over the Delta team stores", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits in memory, and the approval adds the member and lists the entry in Delta", async () => {
    let me = STRANGER;
    const { store, warehouse } = createDeltaHarness({
      currentUser: async () => me,
      now: makeClock().now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });

    const request = await store.accessRequests.submit({
      datasetId: DATASET_ID,
      role: "developer",
      reason: "Build the scoring job",
    });
    me = OWNER;
    expect((await store.accessRequests.listInbox()).map((r) => r.id)).toEqual([request.id]);
    const { added } = await store.accessRequests.approve(request.id);
    expect(added.entries).toHaveLength(1);
    expect(await store.changeList.listEntries()).toHaveLength(1);

    expect(
      warehouse.query(
        `SELECT role, person_email FROM "teams__dataset_members" WHERE source = 'app'`,
      ),
    ).toEqual([{ role: "developer", person_email: STRANGER.email }]);
    // The request itself has no table yet: nothing names one.
    expect(warehouse.statements.some((s) => /access_requests/.test(s))).toBe(false);
  });

  it("fails closed when /api/session can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    // The dataset is there; who's asking can't be resolved.
    const transport = silentTransport();
    vi.mocked(transport.read).mockResolvedValue(
      makeDatasetSeed().datasets.map((d) => ({
        ...d,
        ref: { id: d.id, version: 1 },
        owners: [],
      })) as never,
    );
    const store = createDeltaStore({ transport });

    await expect(
      store.accessRequests.submit({
        datasetId: DATASET_ID,
        role: "tester",
        reason: "Check scores",
      }),
    ).rejects.toThrow(/Identity unavailable/);
  });
});
