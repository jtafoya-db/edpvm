// Sample access requests on Delta (#312). Access requests still live in one
// tab's memory there (the `access-request-persistence` stub), but approving
// one adds the member and lists the entry in Delta. So a sample request must
// never reach a real dataset's owner: the samples target
// `ds-refund-anomaly-scores`, and a real dataset can have that ID. Samples
// appear only when the server says this is a PR preview with the switch on
// (`sampleAccessRequests` on the session profile; see
// src/server/sample-access-requests.ts). Anything else, none.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_DATASET_SEED } from "../datasets/seed";
import { loadStore, resetStoreForTests } from "../loadStore";
import type { UserProfile } from "../types";
import { makeClock } from "./dataset-fixture";
import { createDeltaHarness } from "./team-backends";

const COLLIDING_ID = "ds-refund-anomaly-scores";

/** The owner of the real dataset whose ID the samples target. */
const OWNER: UserProfile = {
  principalId: "seed-dana-whitfield",
  name: "Dana Whitfield",
  initials: "DW",
  title: "EDP User",
  tenant: "RAAS",
  email: "dana.whitfield@example.gov",
  isOnboardingLead: false,
  isAdmin: false,
};

describe("Delta: sample access requests (#312)", () => {
  it("a production-shaped store gives the owner of a real dataset with the samples' ID no sample requests", async () => {
    // The server loads the default datasets as real rows: the first one is
    // `ds-refund-anomaly-scores`, owned by OWNER.
    expect(DEFAULT_DATASET_SEED.datasets[0]).toMatchObject({
      id: COLLIDING_ID,
      owners: [{ principalId: OWNER.principalId }],
    });
    const { store, warehouse } = createDeltaHarness({
      currentUser: async () => OWNER,
      now: makeClock().now,
    });

    expect(await store.datasets.getDataset(COLLIDING_ID)).toMatchObject({ id: COLLIDING_ID });
    // No request to approve, so no approval path to a real member.
    expect(await store.accessRequests.listInbox()).toEqual([]);
    expect(await store.accessRequests.listMine()).toEqual([]);
    expect(await store.changeList.listEntries()).toEqual([]);
    expect(
      warehouse.query(`SELECT person_email FROM "teams__dataset_members" WHERE source = 'app'`),
    ).toEqual([]);
  });

  it("a forged client that seeds samples on production-shaped Delta can't approve one: the server writes nothing", async () => {
    // The browser is told (or tricked into) seeding samples; the server's own
    // sample mode is off, as on any store without a PR preview's prefix.
    const { store, warehouse } = createDeltaHarness({
      currentUser: async () => OWNER,
      now: makeClock().now,
      sampleAccessRequests: true,
    });

    const inbox = await store.accessRequests.listInbox();
    expect(inbox).toHaveLength(2);
    for (const request of inbox) {
      await expect(store.accessRequests.approve(request.id)).rejects.toThrow(
        "This change isn't allowed.",
      );
    }
    // Nor straight through the team store, with a sample's email.
    await expect(
      store.datasetRoles.addMember({
        datasetId: COLLIDING_ID,
        name: "Priya Natarajan",
        email: "PRIYA.NATARAJAN@example.gov",
        role: "tester",
      }),
    ).rejects.toThrow("This change isn't allowed.");
    await expect(
      store.datasetTeam.addOwner({
        datasetId: COLLIDING_ID,
        name: "Tom Becker",
        email: "tom.becker@example.gov",
      }),
    ).rejects.toThrow("This change isn't allowed.");

    // Nor with an alias of a sample's email.
    for (const email of [
      "priya.natarajan+tag@example.gov",
      "Tom.Becker+Pilot@EXAMPLE.gov",
      "ｐｒｉｙａ.natarajan@example.gov",
    ]) {
      await expect(
        store.datasetRoles.addMember({
          datasetId: COLLIDING_ID,
          name: "Alias",
          email,
          role: "tester",
        }),
        email,
      ).rejects.toThrow("This change isn't allowed.");
      await expect(
        store.datasetTeam.addOwner({ datasetId: COLLIDING_ID, name: "Alias", email }),
        email,
      ).rejects.toThrow("This change isn't allowed.");
    }

    expect(await store.changeList.listEntries()).toEqual([]);
    expect(
      warehouse.query(`SELECT person_email FROM "teams__dataset_members" WHERE source = 'app'`),
    ).toEqual([]);
    expect(
      warehouse.query(`SELECT person_email FROM "teams__dataset_owners" WHERE source = 'app'`),
    ).toEqual([]);
    expect(
      warehouse.query(
        `SELECT person_email FROM "change_list__change_list_entries" WHERE person_email LIKE '%@example.gov'`,
      ),
    ).toEqual([]);
  });

  it("a preview with the switch on still gives the owner the labelled samples", async () => {
    const { store } = createDeltaHarness({
      currentUser: async () => OWNER,
      now: makeClock().now,
      sampleAccessRequests: true,
      serverSampleAccessRequests: true,
    });

    const inbox = await store.accessRequests.listInbox();
    expect(inbox.map((r) => [r.datasetId, r.role, r.requester.name])).toEqual([
      [COLLIDING_ID, "tester", "Priya Natarajan (sample)"],
      [COLLIDING_ID, "developer", "Tom Becker (sample)"],
    ]);
    const { added } = await store.accessRequests.approve(inbox[0]!.id);
    expect(added.entries).toHaveLength(1);
  });
});

describe("loadStore on Delta: the session decides whether samples exist (#312)", () => {
  beforeAll(async () => {
    await import("../../legacy/appData.js");
  });

  afterEach(() => {
    resetStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubDelta(profile: unknown) {
    vi.stubEnv("VITE_DATA_BACKEND", "delta");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/session") return Response.json(profile);
      if (url === "/api/reads/initiatives/initiatives") {
        return Response.json(DEFAULT_DATASET_SEED.initiatives);
      }
      if (url.startsWith("/api/reads/initiatives/datasets")) {
        const id = new URL(url, "http://app").searchParams.get("id");
        const ref = { id: "row-1", version: 1 };
        return Response.json(
          DEFAULT_DATASET_SEED.datasets
            .filter((d) => !id || d.id === id)
            .map((d) => ({ ...d, ref, owners: d.owners.map((o) => ({ ...o, ref })) })),
        );
      }
      return Response.json([]);
    });
  }

  it.each([
    ["absent", {}],
    ["false", { sampleAccessRequests: false }],
    ["a string", { sampleAccessRequests: "true" }],
    ["malformed", { sampleAccessRequests: { on: true } }],
  ])("has no samples when the session's switch is %s", async (_label, extra) => {
    stubDelta({ ...OWNER, ...extra });

    const store = await loadStore();

    expect(await store.accessRequests.listInbox()).toEqual([]);
  });

  it("has the samples when the session's switch is exactly true", async () => {
    stubDelta({ ...OWNER, sampleAccessRequests: true });

    const store = await loadStore();

    expect((await store.accessRequests.listInbox()).map((r) => r.requester.name)).toEqual([
      "Priya Natarajan (sample)",
      "Tom Becker (sample)",
    ]);
  });
});
