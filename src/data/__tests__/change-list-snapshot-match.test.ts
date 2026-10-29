import { describe, expect, it, vi } from "vitest";

import { applyObservedMemberships } from "../change-list/snapshot-match";
import type { OnboardUserEntry } from "../change-list/types";
import type { GroupMembership, GroupMembershipReader, SnapshotRun } from "../group-membership";
import {
  DATASET_ID,
  OWNER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "./dataset-fixture";
import { BACKENDS, createTeamStore } from "./team-backends";

const TESS = { name: "Tess Tester", email: "tess.tester@example.gov" };
const RUN_ENDED = "2026-10-01T11:59:00.000Z";

function run(overrides: Partial<SnapshotRun> = {}): SnapshotRun {
  return {
    runId: "snapshot-run-88",
    startedAt: "2026-10-01T11:58:00.000Z",
    endedAt: RUN_ENDED,
    status: "succeeded",
    groupsExpected: ["group-88"],
    groupsRead: ["group-88"],
    complete: true,
    ...overrides,
  };
}

function membership(overrides: Partial<GroupMembership> = {}): GroupMembership {
  return {
    groupName: "edp-refund_anomalies-tester",
    groupId: "group-88",
    kind: "dataset",
    domain: "individual-filing",
    datasetTag: "refund_anomalies",
    managedBy: "manual",
    userId: "scim-tess-1",
    email: TESS.email,
    displayName: TESS.name,
    firstSeen: "2026-10-01T11:58:00.000Z",
    lastSeen: RUN_ENDED,
    ...overrides,
  };
}

function reader(state: {
  rows: GroupMembership[];
  run: SnapshotRun | null;
}): GroupMembershipReader {
  return {
    listMemberships: async () => structuredClone(state.rows),
    listHistory: async () => ({ rows: [], nextCursor: null }),
    latestRun: async () => structuredClone(state.run),
  };
}

function setup(
  backend: (typeof BACKENDS)[number],
  state: { rows: GroupMembership[]; run: SnapshotRun | null },
) {
  const clock = makeClock();
  const store = createTeamStore(backend, {
    currentUser: async () => OWNER,
    now: clock.now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    groupMembershipReader: reader(state),
  });
  return { store, clock };
}

describe.each(BACKENDS)("%s change-list snapshot matching", (backend) => {
  it("verifies an add separately from manual applied state when a complete fresh snapshot has the active member, idempotently", async () => {
    const state = { rows: [membership()], run: run() };
    const { store } = setup(backend, state);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    const first = await store.changeList.listEntries();
    const second = await store.changeList.listEntries();

    expect(first[0]?.applied).toBeNull();
    expect(first[0]?.verified).toEqual({ runId: "snapshot-run-88", at: RUN_ENDED });
    expect(second).toEqual(first);
  });

  it("can show manual Marked applied and snapshot Verified as separate facts", async () => {
    const state = { rows: [membership()], run: run() };
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => ({ ...OWNER, isAdmin: true }),
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: reader(state),
    });
    const { entries } = await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      ...TESS,
      role: "tester",
    });
    await store.changeList.markApplied(entries[0]!.id);

    const entry = (await store.changeList.listEntries())[0]!;
    expect(entry.applied).toEqual({ by: OWNER.principalId, at: "2026-10-01T12:00:00.000Z" });
    expect(entry.verified).toEqual({ runId: "snapshot-run-88", at: RUN_ENDED });
  });

  it("removes derived verification when a later snapshot no longer proves the state", async () => {
    const state = { rows: [membership()], run: run() };
    const { store, clock } = setup(backend, state);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    expect((await store.changeList.listEntries())[0]?.verified).toBeDefined();

    state.rows = [membership({ removedAt: "2026-10-01T12:14:00.000Z" })];
    state.run = run({
      runId: "snapshot-run-89",
      startedAt: "2026-10-01T12:13:00.000Z",
      endedAt: "2026-10-01T12:14:00.000Z",
    });
    clock.advance(15 * 60 * 1000);
    expect((await store.changeList.listEntries())[0]?.verified).toBeUndefined();
  });

  it("verifies a removal only when the matching person and group row has removedAt set", async () => {
    const state = {
      rows: [membership({ removedAt: RUN_ENDED })],
      run: run(),
    };
    const { store } = setup(backend, state);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });

    const entries = await store.changeList.listEntries();

    const removal = entries.find((entry) => entry.kind === "remove-member");
    expect(removal?.applied).toBeNull();
    expect(removal?.verified).toEqual({ runId: "snapshot-run-88", at: RUN_ENDED });
    expect(entries.find((entry) => entry.kind === "add-member")?.applied).toBeNull();
  });

  it("does not verify a removal when the person's row is missing", async () => {
    const { store } = setup(backend, {
      rows: [membership({ userId: "other", email: "other@example.gov" })],
      run: run(),
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });

    const removal = (await store.changeList.listEntries()).find(
      (entry) => entry.kind === "remove-member",
    );
    expect(removal?.verified).toBeUndefined();
  });

  it.each([
    [
      "partial matching-group read",
      run({ groupsExpected: ["group-88", "group-99"], groupsRead: ["group-88"], complete: false }),
    ],
    ["non-succeeded", run({ status: "failed" })],
    ["empty allowlist", run({ groupsExpected: [], groupsRead: ["group-88"], complete: true })],
    ["empty read set", run({ groupsRead: [] })],
    ["stale", run({ endedAt: "2026-10-01T11:29:59.000Z" })],
  ])("marks nothing applied for a %s run", async (_label, latestRun) => {
    const { store } = setup(backend, { rows: [membership()], run: latestRun });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    const entry = (await store.changeList.listEntries())[0];
    expect(entry?.applied).toBeNull();
    expect(entry?.verified).toBeUndefined();
  });

  it("does not read membership rows when the completed run read no groups", async () => {
    const listMemberships = vi.fn(async () => [membership()]);
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => OWNER,
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: {
        listMemberships,
        listHistory: async () => ({ rows: [], nextCursor: null }),
        latestRun: async () => run({ groupsRead: [] }),
      },
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    expect((await store.changeList.listEntries())[0]?.verified).toBeUndefined();
    expect(listMemberships).not.toHaveBeenCalled();
  });

  it("marks nothing applied for a future-dated run even when its row is equally future-dated", async () => {
    const latestRun = run({
      startedAt: "2026-10-01T12:01:00.000Z",
      endedAt: "2026-10-01T12:02:00.000Z",
    });
    const { store } = setup(backend, {
      rows: [membership({ lastSeen: latestRun.endedAt })],
      run: latestRun,
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    expect((await store.changeList.listEntries())[0]?.verified).toBeUndefined();
  });

  it("does not verify an add from a stale active row last seen before this run started", async () => {
    const { store } = setup(backend, {
      rows: [membership({ lastSeen: "2026-10-01T11:57:59.999Z" })],
      run: run(),
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    expect((await store.changeList.listEntries())[0]?.verified).toBeUndefined();
  });

  it("does not verify an ID-only owner's removal while that principal is still active", async () => {
    const state = {
      rows: [
        membership({
          groupName: "edp-refund_anomalies-manager",
          userId: OWNER.principalId,
          email: "",
          displayName: OWNER.name,
        }),
      ],
      run: run(),
    };
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => ({ ...OWNER, isAdmin: true }),
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: reader(state),
    });
    await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });
    await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId });

    const removal = (await store.changeList.listEntries()).find(
      (entry) =>
        entry.kind === "remove-member" && entry.target.person.principalId === OWNER.principalId,
    );
    expect(removal).toBeDefined();
    expect(removal?.verified).toBeUndefined();
  });

  it("verifies an ID-only removal from that principal's own removed row", async () => {
    const state = {
      rows: [
        membership({
          groupName: "edp-refund_anomalies-manager",
          userId: OWNER.principalId,
          email: "",
          displayName: OWNER.name,
          removedAt: RUN_ENDED,
        }),
      ],
      run: run(),
    };
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => ({ ...OWNER, isAdmin: true }),
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: reader(state),
    });
    await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });
    await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId });

    const removal = (await store.changeList.listEntries()).find(
      (entry) =>
        entry.kind === "remove-member" && entry.target.person.principalId === OWNER.principalId,
    );
    expect(removal?.verified).toEqual({ runId: "snapshot-run-88", at: RUN_ENDED });
  });

  it("does not fall back to the same email when entry and row principal IDs differ", async () => {
    const state = {
      rows: [
        membership({
          groupName: "edp-refund_anomalies-manager",
          userId: "different-principal",
          email: OWNER.email,
          displayName: OWNER.name,
          removedAt: RUN_ENDED,
        }),
      ],
      run: run(),
    };
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => ({ ...OWNER, isAdmin: true }),
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: reader(state),
    });
    await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });
    await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId });

    const removal = (await store.changeList.listEntries()).find(
      (entry) =>
        entry.kind === "remove-member" && entry.target.person.principalId === OWNER.principalId,
    );
    if (!removal || removal.kind !== "remove-member") throw new Error("Expected owner removal");
    const entryWithEmail = {
      ...removal,
      target: { ...removal.target, person: { ...removal.target.person, email: OWNER.email! } },
    };
    const [observed] = await applyObservedMemberships(
      [entryWithEmail],
      makeDatasetSeed().datasets,
      reader(state),
      clock.now(),
    );
    expect(observed?.verified).toBeUndefined();
  });

  it("does not match two missing principal IDs through empty emails", async () => {
    const state = {
      rows: [membership({ userId: "", email: "", removedAt: RUN_ENDED })],
      run: run(),
    };
    const { store, clock } = setup(backend, state);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });
    const removal = (await store.changeList.listEntries()).find(
      (entry) => entry.kind === "remove-member",
    );
    if (!removal || removal.kind !== "remove-member") throw new Error("Expected member removal");
    const entryWithoutIdentifiers = {
      ...removal,
      target: {
        ...removal.target,
        person: { name: removal.target.person.name, email: "" },
      },
    };

    const [observed] = await applyObservedMemberships(
      [entryWithoutIdentifiers],
      makeDatasetSeed().datasets,
      reader(state),
      clock.now(),
    );
    expect(observed?.verified).toBeUndefined();
  });

  it("falls back to a non-empty email when an owner entry has an ID but the snapshot row does not", async () => {
    const state = {
      rows: [
        membership({
          groupName: "edp-refund_anomalies-manager",
          userId: "",
          email: OWNER.email,
          displayName: OWNER.name,
          removedAt: "2026-10-01T11:59:00.000Z",
        }),
      ],
      run: run(),
    };
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => ({ ...OWNER, isAdmin: true }),
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: reader(state),
    });
    await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });
    await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId });

    const removal = (await store.changeList.listEntries()).find(
      (entry) =>
        entry.kind === "remove-member" && entry.target.person.principalId === OWNER.principalId,
    );
    if (!removal || removal.kind !== "remove-member") throw new Error("Expected owner removal");
    const entryWithBothIdentifiers = {
      ...removal,
      target: { ...removal.target, person: { ...removal.target.person, email: OWNER.email! } },
    };
    const [observed] = await applyObservedMemberships(
      [entryWithBothIdentifiers],
      makeDatasetSeed().datasets,
      reader(state),
      clock.now(),
    );
    expect(observed?.verified).toEqual({ runId: "snapshot-run-88", at: RUN_ENDED });
  });

  it("marks nothing applied when an empty group leaves no name-and-tag evidence", async () => {
    const { store } = setup(backend, { rows: [], run: run() });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });

    expect((await store.changeList.listEntries()).every((entry) => entry.applied === null)).toBe(
      true,
    );
    expect(
      (await store.changeList.listEntries()).every((entry) => entry.verified === undefined),
    ).toBe(true);
  });

  it("marks nothing applied when the matching group ID was not read", async () => {
    const { store } = setup(backend, {
      rows: [membership({ groupId: "unread-group" })],
      run: run(),
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    const entry = (await store.changeList.listEntries())[0];
    expect(entry?.applied).toBeNull();
    expect(entry?.verified).toBeUndefined();
  });

  it("marks nothing applied when memberships are unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clock = makeClock();
    const failingReader: GroupMembershipReader = {
      listMemberships: async () => {
        throw new Error("snapshot unavailable");
      },
      listHistory: async () => ({ rows: [], nextCursor: null }),
      latestRun: async () => run(),
    };
    const store = createTeamStore(backend, {
      currentUser: async () => OWNER,
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader: failingReader,
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    const entry = (await store.changeList.listEntries())[0];
    expect(entry?.applied).toBeNull();
    expect(entry?.verified).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("membership snapshot rows unavailable"),
      expect.any(Error),
    );
    warning.mockRestore();
  });

  it.each([
    ["group name", membership({ groupName: "edp-other-tester" })],
    ["dataset tag", membership({ datasetTag: "other_dataset" })],
  ])("marks nothing applied when the %s does not match", async (_label, row) => {
    const { store } = setup(backend, { rows: [row], run: run() });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });

    const entry = (await store.changeList.listEntries())[0];
    expect(entry?.applied).toBeNull();
    expect(entry?.verified).toBeUndefined();
  });

  it("handles owner-replacement removal and add pairs independently", async () => {
    const state = {
      rows: [
        membership({ removedAt: RUN_ENDED }),
        membership({ groupName: "edp-refund_anomalies-manager" }),
      ],
      run: run(),
    };
    const { store } = setup(backend, state);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });

    const entries = await store.changeList.listEntries();

    expect(entries.map((entry) => [entry.kind, entry.verified !== undefined])).toEqual([
      ["add-member", false],
      ["remove-member", true],
      ["add-member", true],
    ]);
  });
});

it("leaves onboard-user entries untouched because membership snapshots cannot prove onboarding", async () => {
  const entry: OnboardUserEntry = {
    id: "CL-0088",
    kind: "onboard-user",
    target: {
      person: TESS,
      initiative: { onboardingRequestId: "ONB-0088", name: "Refund Fraud Analytics" },
    },
    reason: {
      kind: "owner-not-a-databricks-user",
      onboardingRequestId: "ONB-0088",
      requestedBy: OWNER.principalId,
      requestedAt: "2026-10-01T11:00:00.000Z",
    },
    createdBy: OWNER.principalId,
    createdAt: "2026-10-01T11:00:00.000Z",
    applied: null,
  };

  await expect(
    applyObservedMemberships(
      [entry],
      makeDatasetSeed().datasets,
      reader({ rows: [membership()], run: run() }),
      new Date("2026-10-01T12:00:00.000Z"),
    ),
  ).resolves.toEqual([entry]);
});

it("logs unavailable snapshot metadata and leaves entries unverified", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const unavailable: GroupMembershipReader = {
    latestRun: async () => {
      throw new Error("metadata unavailable");
    },
    listMemberships: async () => [membership()],
    listHistory: async () => ({ rows: [], nextCursor: null }),
  };
  const entry: OnboardUserEntry = {
    id: "CL-0089",
    kind: "onboard-user",
    target: {
      person: TESS,
      initiative: { onboardingRequestId: "ONB-0089", name: "Refund Fraud Analytics" },
    },
    reason: {
      kind: "owner-not-a-databricks-user",
      onboardingRequestId: "ONB-0089",
      requestedBy: OWNER.principalId,
      requestedAt: "2026-10-01T11:00:00.000Z",
    },
    createdBy: OWNER.principalId,
    createdAt: "2026-10-01T11:00:00.000Z",
    applied: null,
  };

  await expect(
    applyObservedMemberships(
      [entry],
      makeDatasetSeed().datasets,
      unavailable,
      new Date("2026-10-01T12:00:00.000Z"),
    ),
  ).resolves.toEqual([entry]);
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("snapshot metadata unavailable"),
    expect.any(Error),
  );
  warning.mockRestore();
});
