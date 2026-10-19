import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../adapters/memory";
import { DEFAULT_ROLE_DESCRIPTIONS } from "../datasets/role-descriptions";
import { DEFAULT_DATASET_SEED } from "../datasets/seed";
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
  addedMembers,
} from "./dataset-fixture";
import { makeSnapshot } from "./fixture";
import { BACKENDS, createTeamStore, type TeamStoreOptions } from "./team-backends";
import type { AddMemberEntry } from "../change-list/types";

// The same scenarios on the memory adapter and on the Delta path (#123). Tests
// that build the memory store directly check its own configuration handling;
// the Delta loader's are in src/server/delta/__tests__/teams-area.test.ts.
describe.each(BACKENDS)("on the %s backend", (backend) => {
  /** The change list, where a test has only made adds. */
  async function addEntries(store: { changeList: { listEntries(): Promise<unknown[]> } }) {
    return (await store.changeList.listEntries()) as AddMemberEntry[];
  }

  /** A store whose current user can be switched mid-test, on a fixed clock. */
  function setup(overrides: Partial<TeamStoreOptions> = {}) {
    let me: UserProfile = OWNER;
    const clock = makeClock();
    const store = createTeamStore(backend, {
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

  // Entered with stray case and whitespace; the store normalises the email.
  const ADD_TESTER = {
    datasetId: DATASET_ID,
    name: " Tess Tester ",
    email: " Tess.Tester@example.test ",
    role: "tester",
  } as const;
  const TESS = { name: "Tess Tester", email: "tess.tester@example.test" };

  describe("datasets and their owners", () => {
    it("lists initiatives and datasets with domain tag, dataset tag and owners", async () => {
      const { store } = setup();

      expect((await store.datasets.listInitiatives()).map((i) => i.id)).toEqual([
        "INI-001",
        "INI-002",
      ]);
      const dataset = await store.datasets.getDataset(DATASET_ID);
      expect(dataset).toMatchObject({
        initiativeId: "INI-001",
        domainTag: "individual-filing",
        datasetTag: "refund_anomalies",
        owners: [{ principalId: OWNER.principalId }],
      });
      expect(await store.datasets.getDataset("missing")).toBeUndefined();
    });

    it("the default memory seed has one active initiative with two datasets in different domains and owners", async () => {
      const store = createMemoryStore(makeSnapshot(), { seedOwnerIds: async () => null });

      const initiatives = await store.datasets.listInitiatives();
      expect(initiatives).toHaveLength(1);
      expect(initiatives[0]?.stage).toBe("active");
      const datasets = await store.datasets.listDatasets();
      expect(datasets).toHaveLength(2);
      for (const dataset of datasets) {
        expect(dataset.initiativeId).toBe(initiatives[0]?.id);
        expect(dataset.domainTag).toBeTruthy();
        expect(dataset.datasetTag).toBeTruthy();
        expect(dataset.owners).toHaveLength(1);
      }
      expect(datasets[0]?.domainTag).not.toBe(datasets[1]?.domainTag);
      expect(datasets[0]?.owners[0]?.principalId).not.toBe(datasets[1]?.owners[0]?.principalId);
      expect(DEFAULT_DATASET_SEED.datasets).toHaveLength(2);
    });

    // #257: only owners and EDP staff see the counts; the rest see their own roles.
    const COUNTS = { totalMembers: 2, roleCounts: { tester: 1, developer: 0, manager: 1 } };
    const WITHHELD = { totalMembers: null, roleCounts: null };
    it.each([
      { label: "staff", user: STAFF, counts: COUNTS, expectedRoles: [] },
      // The owner's manager row is on record by SCIM id, not email.
      { label: "owner", user: OWNER, counts: COUNTS, expectedRoles: ["manager"] },
      {
        label: "member",
        user: { ...STRANGER, name: "Tess Tester", email: "tess.tester@example.test" },
        counts: WITHHELD,
        expectedRoles: ["tester"],
      },
      { label: "non-member", user: STRANGER, counts: WITHHELD, expectedRoles: [] },
    ] as const)(
      "summarizes members for a $label without returning member emails",
      async ({ user, counts, expectedRoles }) => {
        const { store, actAs } = setup();
        await store.datasetRoles.addMember(ADD_TESTER);

        actAs(user);
        const summaries = await store.datasets.listDatasetSummaries();
        const first = summaries.find((dataset) => dataset.id === DATASET_ID)!;

        expect(first.owners).toEqual(
          expect.arrayContaining([expect.objectContaining({ displayName: OWNER.name })]),
        );
        expect(first.memberSummary).toEqual({ ...counts, viewerRoles: expectedRoles });
        expect(JSON.stringify(summaries)).not.toContain(TESS.email);
      },
    );
  });

  describe("a dataset owner adds a member", () => {
    it("records the dataset role with who added it and when", async () => {
      const { store } = setup();

      const result = await store.datasetRoles.addMember(ADD_TESTER);

      expect(result.created).toBe(true);
      expect(result.member).toEqual({
        datasetId: DATASET_ID,
        person: TESS,
        role: "tester",
        addedBy: OWNER.principalId,
        addedAt: "2026-10-01T12:00:00.000Z",
      });
      expect(await addedMembers(store, DATASET_ID)).toEqual([result.member]);
    });

    it.each(["tester", "developer", "manager"] as const)("can add a %s", async (role) => {
      const { store } = setup();
      await store.datasetRoles.addMember({ ...ADD_TESTER, role });
      expect((await addedMembers(store, DATASET_ID)).map((m) => m.role)).toEqual([role]);
    });

    it("puts exactly one pending add-member entry on the change list, naming group, person, grants, reason and time", async () => {
      const { store } = setup();

      await store.datasetRoles.addMember(ADD_TESTER);

      const entries = await addEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "add-member",
        target: {
          group: "edp-refund_anomalies-tester",
          person: TESS,
          datasetId: DATASET_ID,
          role: "tester",
        },
        grants: TEST_ROLE_DESCRIPTIONS.roles.tester.grants,
        reason: {
          kind: "dataset-role-added",
          role: "tester",
          addedBy: OWNER.principalId,
          addedAt: "2026-10-01T12:00:00.000Z",
        },
        createdBy: OWNER.principalId,
        createdAt: "2026-10-01T12:00:00.000Z",
        applied: null,
      });
    });

    it("stamps one add with one time, even if the clock moves mid-action", async () => {
      let tick = 0;
      const { store } = setup({ now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, tick++)) });

      const { member, entries } = await store.datasetRoles.addMember(ADD_TESTER);

      expect(entries[0]?.createdAt).toBe(member.addedAt);
      expect(entries[0]?.reason).toMatchObject({ addedAt: member.addedAt });
    });

    it("repeating the same add creates no duplicate role or entry", async () => {
      const { store, clock } = setup();

      await store.datasetRoles.addMember(ADD_TESTER);
      clock.advance(60_000);
      const again = await store.datasetRoles.addMember(ADD_TESTER);

      expect(again.created).toBe(false);
      expect(again.entries).toEqual([]);
      expect(again.member.addedAt).toBe("2026-10-01T12:00:00.000Z");
      expect(await addedMembers(store, DATASET_ID)).toHaveLength(1);
      expect(await store.changeList.listEntries()).toHaveLength(1);
    });

    it("treats the same email in any case or spacing, with the same role, as a repeat", async () => {
      const { store } = setup();

      await store.datasetRoles.addMember(ADD_TESTER);
      const again = await store.datasetRoles.addMember({
        ...ADD_TESTER,
        name: "T. Tester",
        email: "tess.tester@example.test",
      });

      expect(again.created).toBe(false);
      expect(again.member.person).toEqual(TESS); // the first add's record is kept
      expect(await store.changeList.listEntries()).toHaveLength(1);
    });

    it("refuses a second role for the same person: one role per person per dataset", async () => {
      const { store } = setup();

      await store.datasetRoles.addMember(ADD_TESTER);
      // A different role for the same email is refused; a switch goes through
      // change-member-role, not a second add (ADR-0007 decision 11).
      await expect(
        store.datasetRoles.addMember({
          ...ADD_TESTER,
          email: "TESS.TESTER@example.test",
          role: "developer",
        }),
      ).rejects.toMatchObject({ code: "duplicate" });

      expect((await addedMembers(store, DATASET_ID)).map((m) => m.role)).toEqual(["tester"]);
      const entries = await addEntries(store);
      expect(entries.map((e) => [e.target.person.email, e.target.role])).toEqual([
        ["tess.tester@example.test", "tester"],
      ]);
    });

    it("a role held by email is display only: it doesn't let that person add members", async () => {
      const { store, actAs } = setup();
      await store.datasetRoles.addMember({
        ...ADD_TESTER,
        name: STRANGER.name,
        email: STRANGER.email,
        role: "manager",
      });

      actAs(STRANGER);
      await expect(
        store.datasetRoles.addMember({ ...ADD_TESTER, email: "someone.else@example.test" }),
      ).rejects.toMatchObject({ code: "not-owner" });
      expect(await addedMembers(store, DATASET_ID)).toHaveLength(1);
    });

    it("treats a different email as a different person", async () => {
      const { store } = setup();

      await store.datasetRoles.addMember(ADD_TESTER);
      await store.datasetRoles.addMember({ ...ADD_TESTER, email: "tess.tester2@example.test" });

      expect(await addedMembers(store, DATASET_ID)).toHaveLength(2);
      expect(await store.changeList.listEntries()).toHaveLength(2);
    });

    it("does not re-list an add once it has been applied", async () => {
      const { store, actAs } = setup();
      const { entries } = await store.datasetRoles.addMember(ADD_TESTER);
      actAs(STAFF);
      await store.changeList.markApplied(entries[0]!.id);

      actAs(OWNER);
      await store.datasetRoles.addMember(ADD_TESTER);

      expect(await store.changeList.listEntries()).toHaveLength(1);
    });

    it("refuses anyone who isn't an owner of that dataset, and records nothing", async () => {
      const { store, actAs } = setup();
      actAs(STRANGER);

      await expect(store.datasetRoles.addMember(ADD_TESTER)).rejects.toMatchObject({
        code: "not-owner",
      });
      // EDP staff aren't owners either.
      actAs(STAFF);
      await expect(store.datasetRoles.addMember(ADD_TESTER)).rejects.toMatchObject({
        code: "not-owner",
      });
      expect(await addedMembers(store, DATASET_ID)).toEqual([]);
      expect(await store.changeList.listEntries()).toEqual([]);
    });

    it("refuses an unknown dataset, an unknown role, a blank name or an invalid email", async () => {
      const { store } = setup();

      await expect(
        store.datasetRoles.addMember({ ...ADD_TESTER, datasetId: "missing" }),
      ).rejects.toMatchObject({ code: "not-found" });
      await expect(
        // @ts-expect-error — an unknown role is refused at runtime too
        store.datasetRoles.addMember({ ...ADD_TESTER, role: "admin" }),
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        store.datasetRoles.addMember({ ...ADD_TESTER, name: "  " }),
      ).rejects.toMatchObject({ code: "invalid" });
      for (const email of ["", "tess", "tess@", "@example.test", "tess tester@example.test", "tess@irs"]) {
        await expect(store.datasetRoles.addMember({ ...ADD_TESTER, email })).rejects.toMatchObject({
          code: "invalid",
        });
      }
      expect(await addedMembers(store, DATASET_ID)).toEqual([]);
    });

    it("refuses adds until the dataset's initiative is active", async () => {
      const { store } = setup();

      await expect(
        store.datasetRoles.addMember({ ...ADD_TESTER, datasetId: "ds-payroll-events" }),
      ).rejects.toMatchObject({ code: "not-active" });
    });

    it("a role switch goes through change-member-role, moving to the new role and group", async () => {
      const { store } = setup();

      await store.datasetRoles.addMember(ADD_TESTER);
      const switched = await store.datasetTeam.changeMemberRole({
        datasetId: DATASET_ID,
        email: TESS.email,
        role: "tester",
        newRole: "developer",
      });

      expect(switched.changed).toBe(true);
      expect((await addedMembers(store, DATASET_ID)).map((m) => m.role)).toEqual(["developer"]);
      // The switch lists the tester group's removal and the developer group's add.
      expect(switched.entries.map((e) => [e.kind, e.target.group])).toEqual([
        ["remove-member", "edp-refund_anomalies-tester"],
        ["add-member", "edp-refund_anomalies-developer"],
      ]);
    });
  });

  describe("group names come from configuration", () => {
    it("a different template changes the group names, with no code change", async () => {
      const { store } = setup({
        groupNaming: { datasetGroup: "grp_{domainTag}__{datasetId}__{role}", overrides: {} },
      });

      await store.datasetRoles.addMember(ADD_TESTER);

      const [entry] = await addEntries(store);
      expect(entry?.target.group).toBe("grp_individual-filing__ds-refund-anomalies__tester");
    });

    it("a per-dataset override names one role's group explicitly", async () => {
      const { store } = setup({
        groupNaming: {
          datasetGroup: "edp-{datasetTag}-{role}",
          overrides: { [DATASET_ID]: { tester: "legacy-refund_anomalies-testers" } },
        },
      });

      // Two different people (one role each) show the override and the default.
      await store.datasetRoles.addMember(ADD_TESTER);
      await store.datasetRoles.addMember({
        ...ADD_TESTER,
        name: "Dana Dev",
        email: "dana.dev@example.test",
        role: "developer",
      });

      const groups = (await addEntries(store)).map((e) => e.target.group);
      expect(groups).toEqual(["legacy-refund_anomalies-testers", "edp-refund_anomalies-developer"]);
    });

    it("refuses a template that wouldn't say which dataset and which role a group grants", () => {
      expect(() =>
        createMemoryStore(makeSnapshot(), {
          groupNaming: { datasetGroup: "edp-{datasetTag}", overrides: {} },
        }),
      ).toThrow(/\{role\}/);
      expect(() =>
        createMemoryStore(makeSnapshot(), {
          groupNaming: { datasetGroup: "edp-{role}", overrides: {} },
        }),
      ).toThrow(/dataset/);
      expect(() =>
        createMemoryStore(makeSnapshot(), {
          groupNaming: { datasetGroup: "edp-{datasetTag}-{role}-{env}", overrides: {} },
        }),
      ).toThrow(/\{env\}/);
    });
  });

  describe("what each role grants comes from configuration", () => {
    it("the checked-in configuration describes all three roles and the data consumer", async () => {
      const store = createMemoryStore(makeSnapshot());

      const described = await store.datasetRoles.describeRoles();
      expect(described).toEqual(DEFAULT_ROLE_DESCRIPTIONS);
      expect(Object.keys(described.roles)).toEqual(["tester", "developer", "manager"]);
      expect(described.roles.tester.grants.join(" ")).toMatch(/uncertified/);
      expect(described.consumerNote).toMatch(/BEARS/);
    });

    it("different wording in configuration changes what the store and its entries say", async () => {
      const { store } = setup();

      expect((await store.datasetRoles.describeRoles()).roles.developer.label).toBe("Dev (test)");
      const { entries } = await store.datasetRoles.addMember({ ...ADD_TESTER, role: "developer" });
      expect(entries[0]?.grants).toEqual(["Test grant: read/write"]);
    });

    it("refuses configuration that leaves a role undescribed", () => {
      const { manager: _omitted, ...twoRoles } = TEST_ROLE_DESCRIPTIONS.roles;
      expect(() =>
        createMemoryStore(makeSnapshot(), {
          roleDescriptions: { ...TEST_ROLE_DESCRIPTIONS, roles: twoRoles as never },
        }),
      ).toThrow(/manager/);
      expect(() =>
        createMemoryStore(makeSnapshot(), {
          roleDescriptions: {
            ...TEST_ROLE_DESCRIPTIONS,
            roles: {
              ...TEST_ROLE_DESCRIPTIONS.roles,
              tester: { ...TEST_ROLE_DESCRIPTIONS.roles.tester, grants: [] },
            },
          },
        }),
      ).toThrow(/tester/);
    });
  });

  describe("group names stay unambiguous", () => {
    it("refuses an override that doesn't say which dataset and which role it grants", async () => {
      const { store } = setup({
        groupNaming: {
          datasetGroup: "edp-{datasetTag}-{role}",
          overrides: { [DATASET_ID]: { tester: "legacy-testers" } },
        },
      });

      await expect(store.datasets.listDatasets()).rejects.toThrow(/legacy-testers/);
    });

    it("refuses configuration where two dataset/role mappings resolve to the same group name", async () => {
      const seed = makeDatasetSeed();
      seed.datasets[1]!.datasetTag = seed.datasets[0]!.datasetTag;
      const { store } = setup({ datasetSeed: seed });

      await expect(store.datasets.listDatasets()).rejects.toThrow(
        /edp-refund_anomalies-tester.*same group name/,
      );
      await expect(store.datasetRoles.addMember(ADD_TESTER)).rejects.toThrow(/same group name/);
    });
  });

  describe("the seeded dataset's owners come from configuration", () => {
    it("uses the configured SCIM ids as the first seeded dataset's owners, leaving the other alone", async () => {
      const store = createMemoryStore(makeSnapshot(), {
        seedOwnerIds: async () => ["scim-uat-1", "scim-uat-2"],
      });

      const [first, second] = await store.datasets.listDatasets();
      expect(first?.owners.map((o) => o.principalId)).toEqual(["scim-uat-1", "scim-uat-2"]);
      expect(second?.owners.map((o) => o.principalId)).toEqual(["seed-marcus-liu"]);
    });

    it("falls back to the local seed user when nothing is configured", async () => {
      const store = createMemoryStore(makeSnapshot(), { seedOwnerIds: async () => null });

      const [dataset] = await store.datasets.listDatasets();
      expect(dataset?.owners.map((o) => o.principalId)).toEqual(["seed-dana-whitfield"]);
    });

    it("lets a configured owner add a member", async () => {
      const store = createMemoryStore(makeSnapshot(), {
        seedOwnerIds: async () => ["scim-uat-1"],
        currentUser: async () => ({ ...OWNER, principalId: "scim-uat-1" }),
      });
      const [dataset] = await store.datasets.listDatasets();

      const result = await store.datasetRoles.addMember({
        datasetId: dataset!.id,
        name: "Dev Person",
        email: "dev.person@example.test",
        role: "developer",
      });
      expect(result.entries).toHaveLength(1);
    });
  });

  describe("EDP staff work the change list", () => {
    it("marks an entry applied, recording who and when", async () => {
      const { store, actAs, clock } = setup();
      const { entries } = await store.datasetRoles.addMember(ADD_TESTER);

      actAs(STAFF);
      clock.advance(3_600_000);
      const applied = await store.changeList.markApplied(entries[0]!.id);

      expect(applied.applied).toEqual({
        by: STAFF.principalId,
        at: "2026-10-01T13:00:00.000Z",
      });
      expect((await store.changeList.listEntries())[0]?.applied).toEqual(applied.applied);
    });

    it("refuses anyone who isn't EDP staff, including the dataset owner", async () => {
      const { store, actAs } = setup();
      const { entries } = await store.datasetRoles.addMember(ADD_TESTER);
      const id = entries[0]!.id;

      await expect(store.changeList.markApplied(id)).rejects.toMatchObject({
        code: "not-edp-staff",
      });
      actAs(STRANGER);
      await expect(store.changeList.markApplied(id)).rejects.toMatchObject({
        code: "not-edp-staff",
      });
      actAs(OWNER);
      expect((await store.changeList.listEntries())[0]?.applied).toBeNull();
    });

    it("refuses an unknown entry, and keeps the first who/when if marked twice", async () => {
      const { store, actAs, clock } = setup();
      const { entries } = await store.datasetRoles.addMember(ADD_TESTER);
      actAs(STAFF);

      await expect(store.changeList.markApplied("CL-missing")).rejects.toMatchObject({
        code: "not-found",
      });
      await store.changeList.markApplied(entries[0]!.id);
      clock.advance(1000);
      await expect(store.changeList.markApplied(entries[0]!.id)).rejects.toMatchObject({
        code: "already-applied",
      });
      expect((await store.changeList.listEntries())[0]?.applied?.at).toBe(
        "2026-10-01T12:00:00.000Z",
      );
    });

    it("shows EDP staff every entry, and anyone else only their own datasets' entries", async () => {
      const { store, actAs } = setup();
      await store.datasetRoles.addMember(ADD_TESTER);

      // The owner sees what their add created.
      expect(await store.changeList.listEntries()).toHaveLength(1);
      actAs(STAFF);
      expect(await store.changeList.listEntries()).toHaveLength(1);
      // Someone with no stake in the dataset sees none of its people or grants.
      actAs(STRANGER);
      expect(await store.changeList.listEntries()).toEqual([]);
    });
  });

  describe("store isolation", () => {
    it("reads return copies, so mutating them cannot change the store or the seed", async () => {
      const seed = makeDatasetSeed();
      const store = createMemoryStore(makeSnapshot(), {
        currentUser: async () => OWNER,
        datasetSeed: seed,
        groupNaming: TEST_GROUP_NAMING,
        roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      });
      await store.datasetRoles.addMember(ADD_TESTER);

      (await store.datasets.getDataset(DATASET_ID))!.owners.length = 0;
      (await addEntries(store))[0]!.target.group = "MUTATED";

      expect((await store.datasets.getDataset(DATASET_ID))?.owners).toHaveLength(1);
      expect(seed.datasets[0]?.owners).toHaveLength(1);
      expect((await addEntries(store))[0]?.target.group).toBe("edp-refund_anomalies-tester");
    });
  });
});
