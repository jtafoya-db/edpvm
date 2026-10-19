import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACCESS_REQUEST_CONFIG,
  validateAccessRequestConfig,
  type AccessRequestConfig,
} from "../access-requests/config";
import { createMemoryAccessRequestStore } from "../access-requests/memory";
import { isDatasetOwner } from "../datasets/ownership";
import { createMemoryStore, type MemoryStoreOptions } from "../adapters/memory";
import type { UserProfile } from "../types";
import {
  DATASET_ID,
  OWNER,
  STAFF,
  STRANGER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "./dataset-fixture";
import { makeSnapshot } from "./fixture";

/** A memory store whose current user can be switched mid-test, on a fixed clock. */
function setup(overrides: Partial<MemoryStoreOptions> = {}) {
  let me: UserProfile = STRANGER;
  // Thursday 2026-10-01, noon UTC.
  const clock = makeClock("2026-10-01T12:00:00.000Z");
  const store = createMemoryStore(makeSnapshot(), {
    currentUser: async () => me,
    now: clock.now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    ...overrides,
  });
  return {
    store,
    clock,
    actAs: (user: UserProfile) => {
      me = user;
    },
  };
}

const DAY = 86_400_000;
const REQUEST = {
  datasetId: DATASET_ID,
  role: "tester",
  reason: " Validate refund scores ",
} as const;

describe("submitting an access request", () => {
  it("records the requester from the session, the role, the reason and the time", async () => {
    const { store } = setup();

    const request = await store.accessRequests.submit(REQUEST);

    expect(request).toMatchObject({
      datasetId: DATASET_ID,
      role: "tester",
      reason: "Validate refund scores",
      requester: {
        principalId: STRANGER.principalId,
        name: STRANGER.name,
        email: STRANGER.email,
      },
      status: "requested",
      requestedAt: "2026-10-01T12:00:00.000Z",
      outcome: null,
      changeListEntryIds: [],
    });
    // A display code (ADR-0007 decision 2, amended 2026-10-10).
    expect(request.id).toMatch(/^AR-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(await store.accessRequests.listMine()).toEqual([request]);
  });

  it("puts nothing on the change list and records no role until an owner approves", async () => {
    const { store, actAs } = setup();
    await store.accessRequests.submit(REQUEST);

    actAs(OWNER);
    expect(await store.changeList.listEntries()).toEqual([]);
    expect(
      (await store.datasetRoles.listMembers(DATASET_ID)).filter(
        (member) => member.addedBy !== "intake",
      ),
    ).toEqual([]);
  });

  it("accepts tester and developer", async () => {
    const { store } = setup();
    for (const role of ["tester", "developer"] as const) {
      await store.accessRequests.submit({ ...REQUEST, role });
    }
    expect((await store.accessRequests.listMine()).map((r) => r.role)).toEqual([
      "developer",
      "tester",
    ]);
  });

  it("refuses manager: a dataset owner grants it directly, it can't be requested", async () => {
    const { store, actAs } = setup();
    await expect(
      store.accessRequests.submit({ ...REQUEST, role: "manager" }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringMatching(/manager.*granted directly by a dataset owner/i),
    });
    expect(await store.accessRequests.listMine()).toEqual([]);
    actAs(OWNER);
    expect(await store.accessRequests.listInbox()).toEqual([]);
  });

  it("refuses a blank reason, an unknown role and an unknown dataset", async () => {
    const { store } = setup();
    await expect(store.accessRequests.submit({ ...REQUEST, reason: "  " })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      // @ts-expect-error -- a role the app doesn't know.
      store.accessRequests.submit({ ...REQUEST, role: "admin" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      store.accessRequests.submit({ ...REQUEST, datasetId: "missing" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses a dataset whose initiative isn't active", async () => {
    const { store } = setup();
    await expect(
      store.accessRequests.submit({ ...REQUEST, datasetId: "ds-payroll-events" }),
    ).rejects.toMatchObject({ code: "not-active" });
  });

  it("refuses an owner asking for a role on their own dataset", async () => {
    const { store, actAs } = setup();
    actAs(OWNER);
    await expect(store.accessRequests.submit(REQUEST)).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses a second open request for the same dataset and role", async () => {
    const { store } = setup();
    await store.accessRequests.submit(REQUEST);
    await expect(store.accessRequests.submit(REQUEST)).rejects.toMatchObject({ code: "invalid" });
    // A different role is a different request.
    await store.accessRequests.submit({ ...REQUEST, role: "developer" });
  });

  it("refuses a role the person already holds, matched by email", async () => {
    const { store, actAs } = setup();
    actAs(OWNER);
    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: STRANGER.name,
      email: STRANGER.email.toUpperCase(),
      role: "tester",
    });
    actAs(STRANGER);
    await expect(store.accessRequests.submit(REQUEST)).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses a session with no usable email, since members are stored by email", async () => {
    const { store, actAs } = setup();
    actAs({ ...STRANGER, email: "" });
    await expect(store.accessRequests.submit(REQUEST)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("the owner's inbox", () => {
  it("lists requests for the datasets the signed-in user owns, and nobody else's", async () => {
    const { store, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);

    actAs(OWNER);
    expect((await store.accessRequests.listInbox()).map((r) => r.id)).toEqual([request.id]);
    // The owner made no requests of their own.
    expect(await store.accessRequests.listMine()).toEqual([]);

    actAs(STAFF);
    expect(await store.accessRequests.listInbox()).toEqual([]);
  });

  it("shows each open request's SLA state against a 3-business-day target", async () => {
    const { store, clock, actAs } = setup();
    // Submitted Thursday noon: due Tuesday noon, skipping the weekend.
    await store.accessRequests.submit(REQUEST);
    actAs(OWNER);

    const sla = async () => (await store.accessRequests.listInbox())[0]?.sla;
    expect(await sla()).toEqual({
      targetBusinessDays: 3,
      provisional: true,
      dueAt: "2026-10-06T12:00:00.000Z",
      businessDaysRemaining: 3,
      state: "on-track",
      escalationAppropriate: false,
    });

    clock.advance(4 * DAY); // Monday noon: one business day left.
    expect(await sla()).toMatchObject({ businessDaysRemaining: 1, state: "due-soon" });

    clock.advance(2 * DAY); // Wednesday noon: past due.
    expect(await sla()).toMatchObject({ state: "breached", escalationAppropriate: true });
  });
});

describe("approving an access request", () => {
  it("records the role and produces the same add-member entry as a direct add", async () => {
    const { store, clock, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);
    clock.advance(DAY);

    actAs(OWNER);
    const { request: approved, added } = await store.accessRequests.approve(request.id);

    expect(approved).toMatchObject({
      status: "active",
      outcome: { by: OWNER.principalId, at: "2026-10-02T12:00:00.000Z", note: null },
      changeListEntryIds: [added.entries[0]!.id],
      sla: null,
    });
    expect(
      (await store.datasetRoles.listMembers(DATASET_ID)).filter(
        (member) => member.addedBy !== "intake",
      ),
    ).toEqual([
      {
        datasetId: DATASET_ID,
        person: { name: STRANGER.name, email: STRANGER.email },
        role: "tester",
        addedBy: OWNER.principalId,
        addedAt: "2026-10-02T12:00:00.000Z",
      },
    ]);
    const entries = await store.changeList.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "add-member",
      target: {
        group: "edp-refund_anomalies-tester",
        person: { name: STRANGER.name, email: STRANGER.email },
        datasetId: DATASET_ID,
        role: "tester",
      },
      grants: TEST_ROLE_DESCRIPTIONS.roles.tester.grants,
      reason: { kind: "dataset-role-added", addedBy: OWNER.principalId },
      createdBy: OWNER.principalId,
      applied: null,
    });

    // Same shape as a direct add of someone else to the same role.
    const direct = await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: "Tess Tester",
      email: "tess@example.test",
      role: "tester",
    });
    expect(Object.keys(direct.entries[0]!).sort()).toEqual(Object.keys(entries[0]!).sort());

    actAs(STRANGER);
    expect((await store.accessRequests.listMine())[0]?.status).toBe("active");
  });

  it("is refused for anyone but the dataset's owners, including EDP staff", async () => {
    const { store, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);

    await expect(store.accessRequests.approve(request.id)).rejects.toMatchObject({
      code: "not-owner",
    });
    actAs(STAFF);
    await expect(store.accessRequests.approve(request.id)).rejects.toMatchObject({
      code: "not-owner",
    });
    await expect(store.accessRequests.reject(request.id)).rejects.toMatchObject({
      code: "not-owner",
    });
    expect(await store.changeList.listEntries()).toEqual([]);
  });

  it("can't be repeated once the request is closed", async () => {
    const { store, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);
    actAs(OWNER);
    await store.accessRequests.approve(request.id);

    await expect(store.accessRequests.approve(request.id)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(store.accessRequests.reject(request.id)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await store.changeList.listEntries()).toHaveLength(1);
  });

  it("closes the request without a new entry when the person already got the role directly", async () => {
    const { store, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);
    actAs(OWNER);
    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: STRANGER.name,
      email: STRANGER.email,
      role: "tester",
    });

    const { request: approved, added } = await store.accessRequests.approve(request.id);
    expect(approved.status).toBe("active");
    expect(added.created).toBe(false);
    expect(approved.changeListEntryIds).toEqual([]);
    expect(await store.changeList.listEntries()).toHaveLength(1);
  });

  it("refuses an unknown request id", async () => {
    const { store, actAs } = setup();
    actAs(OWNER);
    await expect(store.accessRequests.approve("AR-9999")).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("rejecting and withdrawing", () => {
  it("an owner rejects with a note, recording who and when; nothing goes on the change list", async () => {
    const { store, clock, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);
    clock.advance(DAY);

    actAs(OWNER);
    const rejected = await store.accessRequests.reject(request.id, "  Ask for developer instead ");
    expect(rejected).toMatchObject({
      status: "rejected",
      outcome: {
        by: OWNER.principalId,
        at: "2026-10-02T12:00:00.000Z",
        note: "Ask for developer instead",
      },
      sla: null,
    });
    expect(await store.changeList.listEntries()).toEqual([]);
    expect(
      (await store.datasetRoles.listMembers(DATASET_ID)).filter(
        (member) => member.addedBy !== "intake",
      ),
    ).toEqual([]);

    // A closed request no longer blocks asking again.
    actAs(STRANGER);
    await store.accessRequests.submit(REQUEST);
  });

  it("the requester withdraws while it's open; then it can't be decided", async () => {
    const { store, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);

    const withdrawn = await store.accessRequests.withdraw(request.id);
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      outcome: { by: STRANGER.principalId, at: "2026-10-01T12:00:00.000Z", note: null },
    });
    await expect(store.accessRequests.withdraw(request.id)).rejects.toMatchObject({
      code: "invalid",
    });

    actAs(OWNER);
    await expect(store.accessRequests.approve(request.id)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("only the requester can withdraw, and a decided request can't be withdrawn", async () => {
    const { store, actAs } = setup();
    const request = await store.accessRequests.submit(REQUEST);

    actAs(OWNER);
    await expect(store.accessRequests.withdraw(request.id)).rejects.toMatchObject({
      code: "not-found",
    });
    await store.accessRequests.reject(request.id);

    actAs(STRANGER);
    await expect(store.accessRequests.withdraw(request.id)).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("reads are copies", () => {
  it("mutating a returned request doesn't change the store", async () => {
    const { store } = setup();
    const request = await store.accessRequests.submit(REQUEST);
    request.status = "active";
    (await store.accessRequests.listMine())[0]!.reason = "changed";
    expect((await store.accessRequests.listMine())[0]).toMatchObject({
      status: "requested",
      reason: "Validate refund scores",
    });
  });
});

describe("the default seed", () => {
  it("gives the first dataset's configured owner two sample requests to decide", async () => {
    const store = createMemoryStore(makeSnapshot(), {
      currentUser: async () => OWNER,
      now: makeClock("2026-10-01T12:00:00.000Z").now,
      seedOwnerIds: async () => [OWNER.principalId],
    });

    const inbox = await store.accessRequests.listInbox();
    expect(inbox.map((r) => [r.datasetId, r.role, r.status, r.sla?.state])).toEqual([
      ["ds-refund-anomaly-scores", "tester", "requested", "breached"],
      ["ds-refund-anomaly-scores", "developer", "requested", "due-soon"],
    ]);
    const { requestableRoles } = await store.accessRequests.describeSettings();
    for (const request of inbox) {
      expect(request.requester.email).toMatch(/@example\.gov$/);
      // Samples only ask for roles a person can actually request.
      expect(requestableRoles).toContain(request.role);
    }

    const { added } = await store.accessRequests.approve(inbox[0]!.id);
    expect(added.entries[0]?.target.person.email).toBe("priya.natarajan@example.gov");
  });

  it("seeds no requests when a test supplies its own datasets", async () => {
    const { store, actAs } = setup();
    actAs(OWNER);
    expect(await store.accessRequests.listInbox()).toEqual([]);
  });
});

describe("configuration", () => {
  const config = (patch: Partial<AccessRequestConfig>): AccessRequestConfig => ({
    ...structuredClone(DEFAULT_ACCESS_REQUEST_CONFIG),
    ...patch,
  });

  it("the checked-in config makes tester and developer requestable, on a provisional 3-day target", async () => {
    const { store } = setup();
    expect(await store.accessRequests.describeSettings()).toEqual({
      requestableRoles: ["tester", "developer"],
      nonRequestableNote: expect.stringMatching(
        /manager role .*granted directly by a dataset owner/i,
      ),
      sla: {
        targetBusinessDays: 3,
        dueSoonBusinessDays: 1,
        provisional: true,
        note: "This provisional target still needs business confirmation. It counts weekdays only; no holidays are configured.",
      },
    });
  });

  it("refuses a role that isn't in the requestable list", async () => {
    const { store } = setup({
      accessRequestConfig: config({ requestableRoles: ["tester"] }),
    });
    await expect(
      store.accessRequests.submit({ ...REQUEST, role: "developer" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await store.accessRequests.submit({ ...REQUEST, role: "tester" });
  });

  it("takes the SLA target and due-soon threshold from configuration", async () => {
    const { store, actAs } = setup({
      accessRequestConfig: config({
        sla: { targetBusinessDays: 5, dueSoonBusinessDays: 2, provisional: false, note: "Agreed." },
      }),
    });
    // Thursday noon plus five business days is the next Thursday.
    await store.accessRequests.submit(REQUEST);
    actAs(OWNER);
    expect((await store.accessRequests.listInbox())[0]?.sla).toMatchObject({
      targetBusinessDays: 5,
      provisional: false,
      dueAt: "2026-10-08T12:00:00.000Z",
      state: "on-track",
    });
  });

  it("takes the SLA target, due-soon threshold, provisional flag and holidays from deploy config", async () => {
    const { store, actAs } = setup({
      slaConfig: {
        stages: {
          "edp-roi-review": 5,
          ccb: 5,
          "eir-validation": 3,
          "access-request-decision": 2,
        },
        dueSoonThresholdBusinessDays: 0,
        holidays: ["2026-10-02"],
        eirValidityDays: 365,
        accessRequestSlaProvisional: false,
      },
    });

    await store.accessRequests.submit(REQUEST);
    actAs(OWNER);

    expect(await store.accessRequests.describeSettings()).toMatchObject({
      sla: { targetBusinessDays: 2, dueSoonBusinessDays: 0, provisional: false },
    });
    expect((await store.accessRequests.listInbox())[0]?.sla).toMatchObject({
      targetBusinessDays: 2,
      dueAt: "2026-10-06T12:00:00.000Z",
      state: "on-track",
    });
  });

  it.each([
    [
      true,
      [],
      "This provisional target still needs business confirmation. It counts weekdays only; no holidays are configured.",
    ],
    [
      true,
      ["2026-10-02"],
      "This provisional target still needs business confirmation. Configured holidays are skipped.",
    ],
    [
      false,
      [],
      "This target comes from the app's deployment settings. It counts weekdays only; no holidays are configured.",
    ],
    [
      false,
      ["2026-10-02"],
      "This target comes from the app's deployment settings. Configured holidays are skipped.",
    ],
  ] as const)(
    "describes the access-request SLA for provisional=%s and holidays=%j",
    async (provisional, holidays, note) => {
      const { store } = setup({
        slaConfig: {
          stages: {
            "edp-roi-review": 5,
            ccb: 5,
            "eir-validation": 3,
            "access-request-decision": 2,
          },
          dueSoonThresholdBusinessDays: 1,
          holidays,
          eirValidityDays: 365,
          accessRequestSlaProvisional: provisional,
        },
      });

      await expect(store.accessRequests.describeSettings()).resolves.toMatchObject({
        sla: { provisional, note },
      });
    },
  );

  it("rejects a config with an unknown role, no roles, or a zero target", () => {
    expect(() =>
      // @ts-expect-error -- a role the app doesn't know.
      validateAccessRequestConfig(config({ requestableRoles: ["admin"] })),
    ).toThrow();
    expect(() => validateAccessRequestConfig(config({ requestableRoles: [] }))).toThrow();
    // Leaving a role out needs a note saying why.
    expect(() => validateAccessRequestConfig(config({ nonRequestableNote: " " }))).toThrow();
    expect(() =>
      validateAccessRequestConfig(
        config({ sla: { ...DEFAULT_ACCESS_REQUEST_CONFIG.sla, targetBusinessDays: 0 } }),
      ),
    ).toThrow();
  });
});

describe("an owner deciding their own request", () => {
  it("is refused, though they own the dataset", async () => {
    // A request whose requester also owns the dataset, as after an ownership change.
    const { store: base, actAs } = setup();
    actAs(OWNER);
    const store = createMemoryAccessRequestStore({
      datasets: base.datasets,
      datasetRoles: base.datasetRoles,
      currentUser: async () => OWNER,
      now: makeClock().now,
      settings: DEFAULT_ACCESS_REQUEST_CONFIG,
      seed: [
        {
          datasetId: DATASET_ID,
          role: "developer",
          reason: "Asked before becoming an owner",
          requester: { principalId: OWNER.principalId, name: OWNER.name, email: OWNER.email },
          requestedAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    });
    const [request] = await store.listInbox();

    await expect(store.approve(request!.id)).rejects.toMatchObject({ code: "invalid" });
    await expect(store.reject(request!.id)).rejects.toMatchObject({ code: "invalid" });
    expect((await store.listInbox())[0]?.status).toBe("requested");
    expect(await base.changeList.listEntries()).toEqual([]);
  });
});

describe("an owner record with no principal id (owners added by email, #110)", () => {
  const emailOnlyOwner = { displayName: "Ellen Emailed", email: "ellen.emailed@example.test" };

  it("matches an email-added owner by session email, never by two missing ids", () => {
    const dataset = { owners: [emailOnlyOwner] };
    type OwnershipSession = Parameters<typeof isDatasetOwner>[1];
    const missingSession: OwnershipSession = { principalId: undefined, email: undefined };
    const emptySession: OwnershipSession = { principalId: "", email: "" };
    expect(isDatasetOwner(dataset, STRANGER)).toBe(false);
    expect(
      isDatasetOwner(dataset, {
        principalId: "scim-ellen-1",
        email: "ELLEN.EMAILED@example.test",
      }),
    ).toBe(true);
    const ownerWithNoIdentity = { owners: [{ displayName: "Blank" }] };
    expect(isDatasetOwner(ownerWithNoIdentity, missingSession)).toBe(false);
    expect(isDatasetOwner(ownerWithNoIdentity, emptySession)).toBe(false);
    expect(
      isDatasetOwner(
        { owners: [emailOnlyOwner, { principalId: OWNER.principalId, displayName: "O" }] },
        OWNER,
      ),
    ).toBe(true);
  });

  it("requires a matching server session before authorizing a decision", async () => {
    const seed = makeDatasetSeed();
    seed.datasets[0]!.owners = [emailOnlyOwner];
    const { store, actAs } = setup({ datasetSeed: seed });
    const request = await store.accessRequests.submit(REQUEST);

    for (const user of [
      STRANGER,
      OWNER,
      { ...STRANGER, principalId: undefined as unknown as string },
    ]) {
      actAs(user);
      await expect(store.accessRequests.approve(request.id)).rejects.toBeInstanceOf(Error);
      await expect(store.accessRequests.reject(request.id)).rejects.toBeInstanceOf(Error);
    }
    actAs(OWNER);
    expect(await store.accessRequests.listInbox()).toEqual([]);
    actAs(STRANGER);
    expect((await store.accessRequests.listMine())[0]?.status).toBe("requested");
    expect(await store.changeList.listEntries()).toEqual([]);
  });

  it("approves through the direct add path and binds an email-added owner", async () => {
    const seed = makeDatasetSeed();
    seed.datasets[0]!.owners = [emailOnlyOwner];
    const { store, actAs } = setup({ datasetSeed: seed });
    const request = await store.accessRequests.submit(REQUEST);
    const ellen = {
      ...OWNER,
      principalId: "scim-ellen-1",
      name: "Ellen Emailed",
      email: "ellen.emailed@example.test",
    };

    actAs(ellen);
    const result = await store.accessRequests.approve(request.id);

    expect(result.added.created).toBe(true);
    expect((await store.datasets.getDataset(DATASET_ID))?.owners[0]).toMatchObject({
      email: "ellen.emailed@example.test",
      matchedPrincipalId: "scim-ellen-1",
    });
  });

  it("rejects through the ownership claim and binds an email-added owner", async () => {
    const seed = makeDatasetSeed();
    seed.datasets[0]!.owners = [emailOnlyOwner];
    const { store, actAs } = setup({ datasetSeed: seed });
    const request = await store.accessRequests.submit(REQUEST);
    actAs({
      ...OWNER,
      principalId: "scim-ellen-1",
      name: "Ellen Emailed",
      email: "ellen.emailed@example.test",
    });

    const rejected = await store.accessRequests.reject(request.id, "Not needed");

    expect(rejected).toMatchObject({
      status: "rejected",
      outcome: { by: "scim-ellen-1", note: "Not needed" },
    });
    expect((await store.datasets.getDataset(DATASET_ID))?.owners[0]).toMatchObject({
      email: "ellen.emailed@example.test",
      matchedPrincipalId: "scim-ellen-1",
    });
  });

  it("refuses both decisions when the owner's email is bound to another account", async () => {
    const seed = makeDatasetSeed();
    seed.datasets[0]!.owners = [emailOnlyOwner];
    const { store, actAs } = setup({ datasetSeed: seed });
    const request = await store.accessRequests.submit(REQUEST);
    actAs({
      ...OWNER,
      principalId: "scim-ellen-1",
      name: "Ellen Emailed",
      email: "ellen.emailed@example.test",
    });
    expect(await store.datasets.claimOwnership(DATASET_ID)).toBe(true);
    actAs({
      ...OWNER,
      principalId: "scim-impostor-2",
      name: "Ellen Impostor",
      email: "ellen.emailed@example.test",
    });

    await expect(store.accessRequests.reject(request.id)).rejects.toMatchObject({
      code: "owner-mismatch",
    });
    await expect(store.accessRequests.approve(request.id)).rejects.toMatchObject({
      code: "owner-mismatch",
    });
    expect((await store.datasets.getDataset(DATASET_ID))?.owners[0]?.mismatch).toMatchObject({
      principalId: "scim-impostor-2",
    });
  });
});
