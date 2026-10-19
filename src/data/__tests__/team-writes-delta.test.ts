import { describe, expect, it } from "vitest";

import type { UserProfile } from "../types";
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

// A team write is one request: the server checks ownership inside the
// command, so the browser doesn't read it first (it cost a warehouse round
// trip per write).
describe("Delta team writes: one request, ownership checked by the server", () => {
  function setup(user: UserProfile) {
    const harness = createDeltaHarness({
      currentUser: async () => user,
      now: makeClock().now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    return harness;
  }
  const TESS = { name: "Tess Tester", email: "tess.tester@example.test" };

  it("an owner's add makes exactly one request, the command", async () => {
    const { store, requests } = setup(OWNER);
    // The owner's first action binds their email; get that out of the way.
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    requests.length = 0;

    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: "Devon Developer",
      email: "devon.developer@example.test",
      role: "developer",
    });
    expect(requests).toEqual(["POST /api/commands/teams/add-member"]);
  });

  it("an owner's add owner makes one request", async () => {
    const { store, requests } = setup(OWNER);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    requests.length = 0;

    await store.datasetTeam.addOwner({
      datasetId: DATASET_ID,
      name: "Drew Partner",
      email: "drew.partner@example.test",
    });
    expect(requests).toEqual(["POST /api/commands/teams/add-owner"]);
  });

  it("a non-owner is still refused, by the server, and nothing is recorded", async () => {
    const { store, requests } = setup(STRANGER);
    await expect(
      store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" }),
    ).rejects.toMatchObject({ name: "ActionRefusedError", code: "not-owner" });
    expect(requests).toEqual(["POST /api/commands/teams/add-member"]);
    expect(
      (await store.datasetRoles.listMembers(DATASET_ID)).some((m) => m.person.email === TESS.email),
    ).toBe(false);
  });
});
