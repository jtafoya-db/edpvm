/**
 * Who may read a dataset's team (#257 slice A). Only the dataset's owners and
 * EDP staff see who is on it (decision of 2026-10-18 on #115). Anyone else,
 * whatever dataset role they hold, sees only their own membership rows, and
 * the member counts are withheld from them. The rule is decided from the
 * signed-in identity, on the memory adapter and on the Delta path alike.
 */
import { describe, expect, it } from "vitest";

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
import { BACKENDS, createTeamStore } from "./team-backends";

const PAYROLL_ID = "ds-payroll-events";

/** Owns the payroll dataset only. */
const OTHER_OWNER: UserProfile = {
  ...STRANGER,
  principalId: "scim-other-owner-1",
  name: "Otto Other",
  email: "otto.other@example.test",
};
const TESS = { name: "Tess Tester", email: "tess.tester@example.test" };
const DEV = { name: "Dana Developer", email: "dana.developer@example.test" };
const MONA = { name: "Mona Manager", email: "mona.manager@example.test" };
/** Signed in as a person on the team, by their email. */
const as = (contact: { name: string; email: string }, principalId: string): UserProfile => ({
  ...STRANGER,
  principalId,
  name: contact.name,
  email: contact.email,
});
const TESTER = as(TESS, "scim-tess-1");
/** A manager who isn't an owner: no more right to the roster than a tester. */
const MANAGER = as(MONA, "scim-mona-1");

describe.each(BACKENDS)("team roster reads on the %s backend", (backend) => {
  async function setup() {
    let me: UserProfile = OWNER;
    const seed = makeDatasetSeed();
    seed.datasets[1]!.owners = [
      { principalId: OTHER_OWNER.principalId, displayName: OTHER_OWNER.name },
    ];
    const store = createTeamStore(backend, {
      currentUser: async () => me,
      now: makeClock().now,
      datasetSeed: seed,
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    for (const [person, role] of [
      [TESS, "tester"],
      [DEV, "developer"],
      [MONA, "manager"],
    ] as const) {
      await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...person, role });
    }
    // Two team events: Tess moves to developer, Dana is removed.
    await store.datasetTeam.changeMemberRole({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
      newRole: "developer",
    });
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: DEV.email,
      role: "developer",
    });
    return {
      store,
      actAs: (user: UserProfile) => {
        me = user;
      },
    };
  }

  const ROSTER = [
    { name: OWNER.name, role: "manager" },
    { name: TESS.name, role: "developer" },
    { name: MONA.name, role: "manager" },
  ];
  const roster = (members: { person: { name: string }; role: string }[]) =>
    members.map((m) => ({ name: m.person.name, role: m.role }));

  it.each([
    { label: "the dataset's owner", user: OWNER },
    { label: "EDP staff", user: STAFF },
  ])("$label reads the full roster, its counts and its history", async ({ user }) => {
    const { store, actAs } = await setup();
    actAs(user);

    expect(roster(await store.datasetRoles.listMembers(DATASET_ID))).toEqual(ROSTER);
    const summary = (await store.datasets.listDatasetSummaries()).find((d) => d.id === DATASET_ID);
    expect(summary?.memberSummary).toMatchObject({
      totalMembers: 3,
      roleCounts: { tester: 0, developer: 1, manager: 2 },
    });
    expect((await store.datasetTeam.listTeamEvents(DATASET_ID)).map((e) => e.kind)).toEqual([
      "role-changed",
      "member-removed",
    ]);
  });

  it.each([
    { label: "a tester", user: TESTER },
    { label: "a manager who isn't an owner", user: MANAGER },
  ])("$label reads only their own rows, with no one else's email or SCIM id", async ({ user }) => {
    const { store, actAs } = await setup();
    actAs(user);

    const members = await store.datasetRoles.listMembers(DATASET_ID);
    expect(members.map((m) => m.person.email)).toEqual([user.email]);
    const events = await store.datasetTeam.listTeamEvents(DATASET_ID);
    expect(events.every((e) => e.person.email === user.email)).toBe(true);
    const read = JSON.stringify([members, events]);
    for (const other of [TESS, DEV, MONA].filter((p) => p.email !== user.email)) {
      expect(read).not.toContain(other.email);
      expect(read).not.toContain(other.name);
    }
    expect(read).not.toContain(OWNER.name);
  });

  it("a tester sees the history of their own role and nothing else", async () => {
    const { store, actAs } = await setup();
    actAs(TESTER);

    expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([
      expect.objectContaining({ kind: "role-changed", person: TESS, from: "tester" }),
    ]);
  });

  it.each([
    { label: "someone with no role", user: STRANGER },
    { label: "the owner of another dataset", user: OTHER_OWNER },
  ])("$label reads no members and no history", async ({ user }) => {
    const { store, actAs } = await setup();
    actAs(user);

    expect(await store.datasetRoles.listMembers(DATASET_ID)).toEqual([]);
    expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([]);
  });

  it.each([
    { label: "a tester", user: TESTER, viewerRoles: ["developer"] },
    { label: "a manager who isn't an owner", user: MANAGER, viewerRoles: ["manager"] },
    { label: "someone with no role", user: STRANGER, viewerRoles: [] },
  ])(
    "member counts are withheld from $label, who still sees their own roles",
    async ({ user, viewerRoles }) => {
      const { store, actAs } = await setup();
      actAs(user);

      const summary = (await store.datasets.listDatasetSummaries()).find(
        (d) => d.id === DATASET_ID,
      );
      expect(summary?.memberSummary).toEqual({ totalMembers: null, roleCounts: null, viewerRoles });
    },
  );

  it("an owner on record by SCIM id only sees their own manager role (matched by SCIM id)", async () => {
    const { store, actAs } = await setup();
    actAs(OTHER_OWNER);

    const summaries = await store.datasets.listDatasetSummaries();
    expect(summaries.find((d) => d.id === PAYROLL_ID)?.memberSummary.viewerRoles).toEqual([
      "manager",
    ]);
  });

  it("an owner sees counts for the datasets they own and not for the others", async () => {
    const { store, actAs } = await setup();
    actAs(OTHER_OWNER);

    const summaries = await store.datasets.listDatasetSummaries();
    expect(summaries.find((d) => d.id === PAYROLL_ID)?.memberSummary).toEqual({
      totalMembers: 1,
      roleCounts: { tester: 0, developer: 0, manager: 1 },
      viewerRoles: ["manager"],
    });
    expect(summaries.find((d) => d.id === DATASET_ID)?.memberSummary.totalMembers).toBeNull();
    expect(roster(await store.datasetRoles.listMembers(PAYROLL_ID))).toEqual([
      { name: OTHER_OWNER.name, role: "manager" },
    ]);
  });
});
