import { describe, expect, it } from "vitest";

import { applySupersession } from "../change-list/supersession";
import { isMembershipEntry, isPendingChange, type ChangeListEntry } from "../change-list/types";
import type { GroupMembershipReader } from "../group-membership";
import type { UserProfile } from "../types";
import {
  DATASET_ID,
  OWNER,
  STAFF,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "./dataset-fixture";
import { BACKENDS, createTeamStore } from "./team-backends";

const ALEX = { name: "Alex Analyst", email: "alex.analyst@example.gov" };

function membershipEntry(
  id: string,
  kind: "add-member" | "remove-member",
  overrides: {
    group?: string;
    email?: string;
    principalId?: string;
  } = {},
): ChangeListEntry {
  const common = {
    id,
    target: {
      group: overrides.group ?? "edp-refund_anomalies-tester",
      person: {
        name: ALEX.name,
        email: overrides.email ?? ALEX.email,
        ...(overrides.principalId ? { principalId: overrides.principalId } : {}),
      },
      datasetId: DATASET_ID,
      role: "tester" as const,
    },
    grants: ["Test grant: read"],
    createdBy: OWNER.principalId,
    createdAt: kind === "add-member" ? "2026-10-01T12:00:00.000Z" : "2026-10-01T12:01:00.000Z",
    applied: null,
  };
  return kind === "add-member"
    ? {
        ...common,
        kind,
        reason: {
          kind: "dataset-role-added",
          datasetId: DATASET_ID,
          role: "tester",
          addedBy: OWNER.principalId,
          addedAt: "2026-10-01T12:00:00.000Z",
        },
      }
    : {
        ...common,
        kind,
        reason: {
          kind: "dataset-role-removed",
          datasetId: DATASET_ID,
          role: "tester",
          removedBy: OWNER.principalId,
          removedAt: "2026-10-01T12:01:00.000Z",
        },
      };
}

describe("change-list supersession identity and target matching", () => {
  it("matches equal principal IDs before conflicting emails", () => {
    const entries = applySupersession([
      membershipEntry("CL-0001", "add-member", {
        principalId: "scim-alex-311",
        email: "old.alex@example.gov",
      }),
      membershipEntry("CL-0002", "remove-member", {
        principalId: "scim-alex-311",
        email: "new.alex@example.gov",
      }),
    ]);
    expect(entries[0]?.supersededBy).toBe("CL-0002");
  });

  it("does not fall back to email when both principal IDs exist and differ", () => {
    const entries = applySupersession([
      membershipEntry("CL-0001", "add-member", { principalId: "scim-alex-old" }),
      membershipEntry("CL-0002", "remove-member", { principalId: "scim-alex-new" }),
    ]);
    expect(entries[0]).not.toHaveProperty("supersededBy");
  });

  it("falls back to two non-empty normalized emails when a principal ID is unavailable", () => {
    const entries = applySupersession([
      membershipEntry("CL-0001", "add-member", { email: " Alex.Analyst@example.gov " }),
      membershipEntry("CL-0002", "remove-member", {
        principalId: "scim-alex-311",
        email: ALEX.email,
      }),
    ]);
    expect(entries[0]?.supersededBy).toBe("CL-0002");
  });

  it("does not match when neither a principal ID nor two non-empty emails establish identity", () => {
    const entries = applySupersession([
      membershipEntry("CL-0001", "add-member", { email: "" }),
      membershipEntry("CL-0002", "remove-member", { email: "" }),
    ]);
    expect(entries[0]).not.toHaveProperty("supersededBy");
  });

  it("does not match an ID-only entry to an email-only entry", () => {
    const entries = applySupersession([
      membershipEntry("CL-0001", "add-member", {
        principalId: "scim-alex-311",
        email: "",
      }),
      membershipEntry("CL-0002", "remove-member", { email: ALEX.email }),
    ]);
    expect(entries[0]).not.toHaveProperty("supersededBy");
  });

  it("does not supersede a different group when person, dataset, role and direction match", () => {
    const entries = applySupersession([
      membershipEntry("CL-0001", "add-member"),
      membershipEntry("CL-0002", "remove-member", {
        group: "edp-refund_anomalies-tester-replacement",
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("supersededBy");
  });
});

describe.each(BACKENDS)("%s change-list supersession", (backend) => {
  function setup() {
    let user: UserProfile = OWNER;
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => user,
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    return { store, clock, actAs: (next: UserProfile) => (user = next) };
  }

  it("supersedes an unapplied add when a later removal is seen in the snapshot and refuses to apply the add", async () => {
    let user: UserProfile = OWNER;
    const clock = makeClock();
    const groupMembershipReader: GroupMembershipReader = {
      latestRun: async () => ({
        runId: "snapshot-run-311",
        startedAt: "2026-10-01T11:58:00.000Z",
        endedAt: "2026-10-01T11:59:00.000Z",
        status: "succeeded",
        groupsExpected: ["group-311"],
        groupsRead: ["group-311"],
        complete: true,
      }),
      listMemberships: async () => [
        {
          groupName: "edp-refund_anomalies-tester",
          groupId: "group-311",
          kind: "dataset",
          domain: "individual-filing",
          datasetTag: "refund_anomalies",
          managedBy: "manual",
          userId: "scim-alex-311",
          email: ALEX.email,
          displayName: ALEX.name,
          firstSeen: "2026-10-01T11:00:00.000Z",
          lastSeen: "2026-10-01T11:58:00.000Z",
          removedAt: "2026-10-01T11:59:00.000Z",
        },
      ],
      listHistory: async () => ({ rows: [], nextCursor: null }),
    };
    const store = createTeamStore(backend, {
      currentUser: async () => user,
      now: clock.now,
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      groupMembershipReader,
    });

    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: ALEX.email,
      role: "tester",
    });

    const [add, remove] = await store.changeList.listEntries();
    expect(add).toMatchObject({
      id: "CL-0001",
      kind: "add-member",
      supersededBy: "CL-0002",
      applied: null,
    });
    expect(isPendingChange(add!)).toBe(false);
    expect(remove).toMatchObject({
      id: "CL-0002",
      kind: "remove-member",
      verified: { runId: "snapshot-run-311" },
    });

    user = STAFF;
    await expect(store.changeList.markApplied(add!.id)).rejects.toMatchObject({
      code: "superseded",
      message: "This change is no longer pending.",
    });
  });

  it("keeps only the last add live in an add-remove-add chain", async () => {
    const { store } = setup();
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: ALEX.email,
      role: "tester",
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });

    const entries = await store.changeList.listEntries();
    expect(entries.map(({ id, supersededBy }) => [id, supersededBy])).toEqual([
      ["CL-0001", "CL-0002"],
      ["CL-0002", "CL-0003"],
      ["CL-0003", undefined],
    ]);
    expect(entries.filter(isPendingChange).map((entry) => entry.id)).toEqual(["CL-0003"]);
  });

  it("refuses a stale client's direct apply after a later removal supersedes its listed add", async () => {
    const { store, actAs } = setup();
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });
    const [staleAdd] = await store.changeList.listEntries();

    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: ALEX.email,
      role: "tester",
    });
    actAs(STAFF);

    await expect(store.changeList.markApplied(staleAdd!.id)).rejects.toMatchObject({
      code: "superseded",
      message: "This change is no longer pending.",
    });
  });

  it("a role swap supersedes the earlier add only with the removal for that role", async () => {
    const { store } = setup();
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });
    await store.datasetTeam.changeMemberRole({
      datasetId: DATASET_ID,
      email: ALEX.email,
      role: "tester",
      newRole: "developer",
    });

    expect(
      (await store.changeList.listEntries())
        .filter(isMembershipEntry)
        .map(({ id, kind, supersededBy, target }) => [id, kind, target.role, supersededBy]),
    ).toEqual([
      ["CL-0001", "add-member", "tester", "CL-0002"],
      ["CL-0002", "remove-member", "tester", undefined],
      ["CL-0003", "add-member", "developer", undefined],
    ]);
  });

  it("does not supersede a matching person in a different dataset and group", async () => {
    const seed = makeDatasetSeed();
    seed.initiatives[1]!.stage = "active";
    const clock = makeClock();
    const store = createTeamStore(backend, {
      currentUser: async () => OWNER,
      now: clock.now,
      datasetSeed: seed,
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });
    await store.datasetRoles.addMember({
      datasetId: "ds-payroll-events",
      ...ALEX,
      role: "tester",
    });
    await store.datasetTeam.removeMember({
      datasetId: "ds-payroll-events",
      email: ALEX.email,
      role: "tester",
    });

    const entries = await store.changeList.listEntries();
    expect(entries[0]).not.toHaveProperty("supersededBy");
    expect(entries[1]).toMatchObject({ supersededBy: "CL-0003" });
  });

  it("keeps an already-applied earlier entry applied instead of relabelling it", async () => {
    const { store, actAs } = setup();
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...ALEX, role: "tester" });
    actAs(STAFF);
    await store.changeList.markApplied("CL-0001");
    actAs(OWNER);
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: ALEX.email,
      role: "tester",
    });

    const [add] = await store.changeList.listEntries();
    expect(add?.applied).toMatchObject({ by: STAFF.principalId });
    expect(add).not.toHaveProperty("supersededBy");
  });
});
