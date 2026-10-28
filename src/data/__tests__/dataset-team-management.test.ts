import { describe, expect, it } from "vitest";

import { isMembershipEntry, type ChangeListEntry } from "../change-list/types";
import { findSameOwner, ownerKey, type OwnerBindings } from "../datasets/ownership";
import type { DatasetRoleName, DatasetSeed } from "../datasets/types";
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
import { BACKENDS, createTeamStore, type TeamStoreOptions } from "./team-backends";

function membershipKindAndRole(entry: ChangeListEntry) {
  if (!isMembershipEntry(entry)) {
    throw new Error(`Expected a membership entry, received ${entry.kind}`);
  }
  return [entry.kind, entry.target.role];
}

// The same scenarios on the memory adapter and on the Delta path (#123).
describe.each(BACKENDS)("on the %s backend", (backend) => {
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

  const TESS = { name: "Tess Tester", email: "tess.tester@example.gov" };
  const DREW = { name: "Drew Partner", email: "drew.partner@example.gov" };

  /** Someone signed in whose session email is Drew's, with their own SCIM id. */
  const DREW_SIGNED_IN: UserProfile = {
    ...STRANGER,
    principalId: "scim-drew-1",
    name: DREW.name,
    email: "Drew.Partner@example.gov",
  };

  async function addTess(
    store: ReturnType<typeof setup>["store"],
    role: DatasetRoleName = "tester",
  ) {
    return store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role });
  }

  describe("a dataset owner edits a member's role", () => {
    it("moves the role and lists remove-old and add-new entries naming the person, with grants snapshotted", async () => {
      const { store, clock } = setup();
      await addTess(store);
      clock.advance(60_000);

      const result = await store.datasetTeam.changeMemberRole({
        datasetId: DATASET_ID,
        email: " Tess.Tester@example.gov ",
        role: "tester",
        newRole: "developer",
      });

      expect(result.changed).toBe(true);
      expect(result.member).toMatchObject({ role: "developer", person: TESS });
      const at = "2026-10-01T12:01:00.000Z";
      const reason = {
        kind: "dataset-role-changed",
        datasetId: DATASET_ID,
        from: "tester",
        to: "developer",
        changedBy: OWNER.principalId,
        changedAt: at,
      };
      expect(result.entries).toEqual([
        {
          id: "CL-0002",
          kind: "remove-member",
          target: {
            group: "edp-refund_anomalies-tester",
            person: TESS,
            datasetId: DATASET_ID,
            role: "tester",
          },
          grants: ["Test grant: read"],
          reason,
          createdBy: OWNER.principalId,
          createdAt: at,
          applied: null,
        },
        {
          id: "CL-0003",
          kind: "add-member",
          target: {
            group: "edp-refund_anomalies-developer",
            person: TESS,
            datasetId: DATASET_ID,
            role: "developer",
          },
          grants: ["Test grant: read/write"],
          reason,
          createdBy: OWNER.principalId,
          createdAt: at,
          applied: null,
        },
      ]);
      expect((await store.changeList.listEntries()).map((e) => e.id)).toEqual([
        "CL-0001",
        "CL-0002",
        "CL-0003",
      ]);
      const members = await addedMembers(store, DATASET_ID);
      expect(members).toEqual([
        expect.objectContaining({
          role: "developer",
          addedBy: OWNER.principalId,
          addedAt: "2026-10-01T12:00:00.000Z",
          roleChangedBy: OWNER.principalId,
          roleChangedAt: at,
        }),
      ]);
    });

    it("a no-op edit (same role) changes nothing and lists nothing", async () => {
      const { store } = setup();
      await addTess(store);

      const result = await store.datasetTeam.changeMemberRole({
        datasetId: DATASET_ID,
        email: TESS.email,
        role: "tester",
        newRole: "tester",
      });

      expect(result).toMatchObject({ changed: false, entries: [] });
      expect(await store.changeList.listEntries()).toHaveLength(1);
      expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([]);
    });

    it("edits two members' roles independently (one role per person)", async () => {
      const { store } = setup();
      await addTess(store, "tester");
      await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...DREW, role: "developer" });

      await store.datasetTeam.changeMemberRole({
        datasetId: DATASET_ID,
        email: TESS.email,
        role: "tester",
        newRole: "manager",
      });

      expect((await addedMembers(store, DATASET_ID)).map((m) => [m.person.email, m.role])).toEqual([
        [TESS.email, "manager"],
        [DREW.email, "developer"],
      ]);
    });

    it("refuses a role the person doesn't hold, a non-owner, and an inactive initiative", async () => {
      const { store, actAs } = setup();
      await addTess(store);

      await expect(
        store.datasetTeam.changeMemberRole({
          datasetId: DATASET_ID,
          email: TESS.email,
          role: "manager",
          newRole: "developer",
        }),
      ).rejects.toMatchObject({ code: "not-found" });
      await expect(
        store.datasetTeam.changeMemberRole({
          datasetId: DATASET_ID,
          email: TESS.email,
          role: "tester",
          newRole: "owner" as never,
        }),
      ).rejects.toMatchObject({ code: "invalid" });

      actAs(STRANGER);
      await expect(
        store.datasetTeam.changeMemberRole({
          datasetId: DATASET_ID,
          email: TESS.email,
          role: "tester",
          newRole: "developer",
        }),
      ).rejects.toMatchObject({ code: "not-owner" });
      // EDP staff manage owners, not members.
      actAs(STAFF);
      await expect(
        store.datasetTeam.removeMember({
          datasetId: DATASET_ID,
          email: TESS.email,
          role: "tester",
        }),
      ).rejects.toMatchObject({ code: "not-owner" });
      expect(await store.changeList.listEntries()).toHaveLength(1);
    });

    it("re-adding a role after it was removed lists a fresh add", async () => {
      const { store } = setup();
      await addTess(store);
      await store.datasetTeam.removeMember({
        datasetId: DATASET_ID,
        email: TESS.email,
        role: "tester",
      });

      const again = await addTess(store);

      expect(again.created).toBe(true);
      expect(again.entries.map((e) => e.kind)).toEqual(["add-member"]);
      expect((await store.changeList.listEntries()).map((e) => e.kind)).toEqual([
        "add-member",
        "remove-member",
        "add-member",
      ]);
    });
  });

  describe("a dataset owner removes a member's role", () => {
    it("drops the role and lists a remove-member entry with its reason", async () => {
      const { store, clock } = setup();
      await addTess(store);
      clock.advance(1000);

      const result = await store.datasetTeam.removeMember({
        datasetId: DATASET_ID,
        email: TESS.email,
        role: "tester",
      });

      const at = "2026-10-01T12:00:01.000Z";
      expect(result.entries).toEqual([
        {
          id: "CL-0002",
          kind: "remove-member",
          target: {
            group: "edp-refund_anomalies-tester",
            person: TESS,
            datasetId: DATASET_ID,
            role: "tester",
          },
          grants: ["Test grant: read"],
          reason: {
            kind: "dataset-role-removed",
            datasetId: DATASET_ID,
            role: "tester",
            removedBy: OWNER.principalId,
            removedAt: at,
          },
          createdBy: OWNER.principalId,
          createdAt: at,
          applied: null,
        },
      ]);
      expect(await addedMembers(store, DATASET_ID)).toEqual([]);
      expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([
        {
          datasetId: DATASET_ID,
          kind: "member-removed",
          person: TESS,
          role: "tester",
          by: OWNER.principalId,
          at,
          entryIds: ["CL-0002"],
        },
      ]);
    });

    it("removes one member's role and leaves another's", async () => {
      const { store } = setup();
      await addTess(store, "tester");
      await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...DREW, role: "developer" });

      await store.datasetTeam.removeMember({
        datasetId: DATASET_ID,
        email: DREW.email,
        role: "developer",
      });

      expect((await addedMembers(store, DATASET_ID)).map((m) => [m.person.email, m.role])).toEqual([
        [TESS.email, "tester"],
      ]);
    });

    it("refuses a role the person doesn't hold", async () => {
      const { store } = setup();
      await expect(
        store.datasetTeam.removeMember({
          datasetId: DATASET_ID,
          email: TESS.email,
          role: "tester",
        }),
      ).rejects.toMatchObject({ code: "not-found" });
    });
  });

  describe("dataset owners manage owners", () => {
    it("an owner adds another owner, who gets the manager role on the change list", async () => {
      const { store } = setup();

      const result = await store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: " Drew Partner ",
        email: " Drew.Partner@example.gov ",
      });

      expect(result.dataset.owners).toEqual([
        { principalId: OWNER.principalId, displayName: OWNER.name },
        {
          displayName: DREW.name,
          email: DREW.email,
          addedBy: OWNER.principalId,
          addedAt: "2026-10-01T12:00:00.000Z",
        },
      ]);
      expect(result.entries).toEqual([
        expect.objectContaining({
          kind: "add-member",
          target: expect.objectContaining({
            group: "edp-refund_anomalies-manager",
            person: DREW,
            role: "manager",
          }),
          grants: ["Test grant: read/write", "Test grant: manage"],
          reason: {
            kind: "dataset-owner-added",
            datasetId: DATASET_ID,
            addedBy: OWNER.principalId,
            addedAt: "2026-10-01T12:00:00.000Z",
          },
        }),
      ]);
      expect(await addedMembers(store, DATASET_ID)).toEqual([
        expect.objectContaining({ person: DREW, role: "manager" }),
      ]);
      expect((await store.datasets.getDataset(DATASET_ID))?.owners).toHaveLength(2);
    });

    it("adding an owner who already holds manager lists no second add", async () => {
      const { store } = setup();
      await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...DREW, role: "manager" });

      const result = await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      expect(result.entries).toEqual([]);
      expect(await addedMembers(store, DATASET_ID)).toHaveLength(1);
    });

    it("refuses an owner already listed, a blank name, or an invalid email", async () => {
      const { store } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      await expect(
        store.datasetTeam.addOwner({
          datasetId: DATASET_ID,
          name: "Drew",
          email: "DREW.partner@example.gov",
        }),
      ).rejects.toMatchObject({ code: "duplicate" });
      await expect(
        store.datasetTeam.addOwner({ datasetId: DATASET_ID, name: " ", email: "x@example.gov" }),
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        store.datasetTeam.addOwner({ datasetId: DATASET_ID, name: "X", email: "not-an-email" }),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("an owner added by email can act alone once signed in with that email", async () => {
      const { store, actAs } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      actAs(DREW_SIGNED_IN);
      const added = await addTess(store);

      // Attributed to their SCIM id, not their email.
      expect(added.member.addedBy).toBe("scim-drew-1");
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId });
      expect(
        (await store.datasets.getDataset(DATASET_ID))?.owners.map((o) => o.displayName),
      ).toEqual([DREW.name]);
    });

    it("an owner's manager role can't be edited or removed while they're an owner", async () => {
      const { store } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      await expect(
        store.datasetTeam.removeMember({
          datasetId: DATASET_ID,
          email: DREW.email,
          role: "manager",
        }),
      ).rejects.toMatchObject({ code: "owner-holds-manager" });
      await expect(
        store.datasetTeam.changeMemberRole({
          datasetId: DATASET_ID,
          email: DREW.email,
          role: "manager",
          newRole: "tester",
        }),
      ).rejects.toMatchObject({ code: "owner-holds-manager" });
    });

    it("the refusal names the stored manager role by its configured label (#260)", async () => {
      const { store } = setup({
        roleDescriptions: {
          ...TEST_ROLE_DESCRIPTIONS,
          roles: {
            ...TEST_ROLE_DESCRIPTIONS.roles,
            manager: { ...TEST_ROLE_DESCRIPTIONS.roles.manager, label: "Keeper (test)" },
          },
        },
      });
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      await expect(
        store.datasetTeam.removeMember({
          datasetId: DATASET_ID,
          email: DREW.email,
          role: "manager",
        }),
      ).rejects.toMatchObject({
        code: "owner-holds-manager",
        message: expect.stringMatching(/every owner holds the Keeper \(test\) role\. Remove them/),
      });
    });

    it("removing an owner also removes their manager role and lists the remove-member entry", async () => {
      const { store, clock } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      clock.advance(1000);

      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET_ID,
        owner: DREW.email,
      });

      const at = "2026-10-01T12:00:01.000Z";
      expect(result.entries).toEqual([
        {
          id: "CL-0002",
          kind: "remove-member",
          target: {
            group: "edp-refund_anomalies-manager",
            person: DREW,
            datasetId: DATASET_ID,
            role: "manager",
          },
          grants: ["Test grant: read/write", "Test grant: manage"],
          reason: {
            kind: "dataset-owner-removed",
            datasetId: DATASET_ID,
            removedBy: OWNER.principalId,
            removedAt: at,
          },
          createdBy: OWNER.principalId,
          createdAt: at,
          applied: null,
        },
      ]);
      expect(await addedMembers(store, DATASET_ID)).toEqual([]);
      expect((await store.datasetTeam.listTeamEvents(DATASET_ID)).at(-1)).toMatchObject({
        kind: "owner-removed",
        person: DREW,
        entryIds: ["CL-0002"],
      });
    });

    it("an owner holds only the manager role; a second role for them is refused", async () => {
      const { store } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      // Drew already holds manager as an owner, so a second role is refused
      // (one role per person per dataset, ADR-0007 decision 11).
      await expect(
        store.datasetRoles.addMember({ datasetId: DATASET_ID, ...DREW, role: "tester" }),
      ).rejects.toMatchObject({ code: "duplicate" });

      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET_ID,
        owner: DREW.email,
      });

      // Removing the owner drops the manager role that came with ownership.
      expect(result.entries.map((e) => e.kind)).toEqual(["remove-member"]);
      expect(
        (await addedMembers(store, DATASET_ID)).some((m) => m.person.email === DREW.email),
      ).toBe(false);
    });

    it.each(["tester", "developer"] as const)(
      "making an existing %s an owner replaces that role with manager in one action",
      async (oldRole) => {
        const { store } = setup();
        await addTess(store, oldRole);

        const result = await store.datasetTeam.addOwner({
          datasetId: DATASET_ID,
          name: TESS.name,
          email: TESS.email,
          idempotencyKey:
            oldRole === "tester"
              ? "00000000-0000-4000-8000-000000000254"
              : "00000000-0000-4000-8000-000000000255",
        });

        expect(result.dataset.owners).toContainEqual(
          expect.objectContaining({ email: TESS.email }),
        );
        expect(
          (await addedMembers(store, DATASET_ID)).map((m) => [m.person.email, m.role]),
        ).toEqual([[TESS.email, "manager"]]);
        expect(result.entries.map(membershipKindAndRole)).toEqual([
          ["remove-member", oldRole],
          ["add-member", "manager"],
        ]);
        expect(result.entries.map((entry) => entry.reason)).toEqual([
          expect.objectContaining({ kind: "dataset-owner-added", replacedRole: oldRole }),
          expect.objectContaining({ kind: "dataset-owner-added", replacedRole: oldRole }),
        ]);
        // ADR-0005 decision 6: the pending old-role add is preserved, then
        // compensated; no listed entry is silently cancelled or mutated.
        expect(
          (await store.changeList.listEntries()).map((entry) => [entry.id, entry.kind]),
        ).toEqual([
          ["CL-0001", "add-member"],
          ["CL-0002", "remove-member"],
          ["CL-0003", "add-member"],
        ]);
        expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([
          expect.objectContaining({
            kind: "owner-added",
            person: TESS,
            replacedRole: oldRole,
            entryIds: ["CL-0002", "CL-0003"],
          }),
        ]);

        const replay = await store.datasetTeam.addOwner({
          datasetId: DATASET_ID,
          name: TESS.name,
          email: TESS.email,
          idempotencyKey:
            oldRole === "tester"
              ? "00000000-0000-4000-8000-000000000254"
              : "00000000-0000-4000-8000-000000000255",
        });
        expect(replay).toEqual(result);
        expect(await store.changeList.listEntries()).toHaveLength(3);
        expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toHaveLength(1);
      },
    );

    it("refuses another actor who reuses the owner's successful add-owner key", async () => {
      const { store, actAs } = setup();
      await addTess(store, "tester");
      const key = "00000000-0000-4000-8000-000000000256";
      await store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: TESS.name,
        email: TESS.email,
        idempotencyKey: key,
      });

      actAs(STRANGER);
      await expect(
        store.datasetTeam.addOwner({
          datasetId: DATASET_ID,
          name: TESS.name,
          email: TESS.email,
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({
        code: "invalid",
        message: "This change was already submitted. Refresh to see the latest.",
      });
      actAs(STAFF);
      await expect(
        store.datasetTeam.addOwner({
          datasetId: DATASET_ID,
          name: TESS.name,
          email: TESS.email,
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({
        code: "invalid",
        message: "This change was already submitted. Refresh to see the latest.",
      });
      actAs(OWNER);
      expect(await store.changeList.listEntries()).toHaveLength(3);
    });

    it("preserves an applied old-role add and lists its compensating replacement", async () => {
      const { store, actAs } = setup();
      await addTess(store, "tester");
      actAs(STAFF);
      await store.changeList.markApplied("CL-0001");
      actAs(OWNER);

      const result = await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });

      expect(result.entries.map(membershipKindAndRole)).toEqual([
        ["remove-member", "tester"],
        ["add-member", "manager"],
      ]);
      expect((await store.changeList.listEntries())[0]).toMatchObject({
        id: "CL-0001",
        kind: "add-member",
        applied: { by: STAFF.principalId },
      });
    });

    it("re-adding a removed owner grants the manager role again with a fresh add entry", async () => {
      const { store } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: DREW.email });

      const again = await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      expect(again.entries).toEqual([
        expect.objectContaining({
          kind: "add-member",
          target: expect.objectContaining({ role: "manager", person: DREW }),
        }),
      ]);
      expect(await addedMembers(store, DATASET_ID)).toEqual([
        expect.objectContaining({ person: DREW, role: "manager" }),
      ]);
    });

    it("EDP staff removing an owner during reassignment also removes their manager role", async () => {
      const { store, actAs } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      actAs(STAFF);

      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET_ID,
        owner: DREW.email,
      });

      expect(result.entries).toEqual([
        expect.objectContaining({
          kind: "remove-member",
          target: expect.objectContaining({ role: "manager" }),
          createdBy: STAFF.principalId,
        }),
      ]);
    });

    it("refuses to remove the last owner, with a clear message", async () => {
      const { store } = setup();

      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId }),
      ).rejects.toMatchObject({
        code: "last-owner",
        message: expect.stringMatching(/last owner.*can't be left without one/i),
      });
      expect((await store.datasets.getDataset(DATASET_ID))?.owners).toHaveLength(1);
    });

    it("refuses non-owners, and an owner who isn't listed", async () => {
      const { store, actAs } = setup();
      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: "nobody@example.gov" }),
      ).rejects.toMatchObject({ code: "not-found" });
      actAs(STRANGER);
      await expect(
        store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW }),
      ).rejects.toMatchObject({ code: "not-owner" });
    });

    it("records every owner change with its actor and time", async () => {
      const { store, clock, actAs } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      clock.advance(1000);
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId });

      // Olive owns it no longer, so the team's history is EDP staff's to read (#257).
      actAs(STAFF);
      expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([
        expect.objectContaining({
          kind: "owner-added",
          person: DREW,
          by: OWNER.principalId,
          at: "2026-10-01T12:00:00.000Z",
          entryIds: ["CL-0001"],
        }),
        expect.objectContaining({
          kind: "owner-removed",
          person: { name: OWNER.name, email: null },
          by: OWNER.principalId,
          at: "2026-10-01T12:00:01.000Z",
          // Their manager role goes with ownership, listed by SCIM id.
          entryIds: ["CL-0002"],
        }),
      ]);
    });
  });

  describe("EDP staff reassign ownership", () => {
    function ownerless(): DatasetSeed {
      const seed = makeDatasetSeed();
      seed.datasets[0]!.owners = [];
      return seed;
    }

    it("adds an owner to a dataset that has none", async () => {
      const { store, actAs } = setup({ datasetSeed: ownerless() });
      actAs(STAFF);

      const result = await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      expect(result.dataset.owners).toEqual([expect.objectContaining({ email: DREW.email })]);
      expect(result.entries[0]?.createdBy).toBe(STAFF.principalId);
    });

    it("can't remove the last owner either", async () => {
      const { store, actAs } = setup();
      actAs(STAFF);
      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId }),
      ).rejects.toMatchObject({ code: "last-owner" });
    });
  });

  describe("email-added owners are recognised by session email, then bound to their SCIM id (ADR-0006)", () => {
    async function withDrewAsOwner() {
      const ctx = setup();
      await ctx.store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      return ctx;
    }
    const drewOwner = async (store: ReturnType<typeof setup>["store"]) =>
      (await store.datasets.getDataset(DATASET_ID))?.owners.find((o) => o.email === DREW.email);

    it("matches the session email in any case or spacing", async () => {
      const { store, actAs } = await withDrewAsOwner();
      actAs({ ...DREW_SIGNED_IN, email: "  DREW.PARTNER@example.gov " });

      await expect(addTess(store)).resolves.toMatchObject({ created: true });
    });

    it("refuses a session whose email doesn't match any owner", async () => {
      const { store, actAs } = await withDrewAsOwner();
      actAs({ ...DREW_SIGNED_IN, email: "drew.partner2@example.gov" });

      await expect(addTess(store)).rejects.toMatchObject({ code: "not-owner" });
      expect((await drewOwner(store))?.matchedPrincipalId).toBeUndefined();
    });

    it("records the SCIM id and time of the first match, and rights then follow that id", async () => {
      const { store, actAs, clock } = await withDrewAsOwner();
      clock.advance(5000);
      actAs(DREW_SIGNED_IN);
      await addTess(store);

      expect(await drewOwner(store)).toMatchObject({
        matchedPrincipalId: "scim-drew-1",
        matchedAt: "2026-10-01T12:00:05.000Z",
      });
      // The same SCIM id keeps owner rights even if its session email changes.
      actAs({ ...DREW_SIGNED_IN, email: "drew.p@example.gov" });
      await expect(
        store.datasetRoles.addMember({
          datasetId: DATASET_ID,
          name: "New Member",
          email: "new.member@example.gov",
          role: "tester",
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it("refuses and flags the same email under a different SCIM id once bound", async () => {
      const { store, actAs, clock } = await withDrewAsOwner();
      actAs(DREW_SIGNED_IN);
      await addTess(store);
      clock.advance(1000);

      actAs({ ...DREW_SIGNED_IN, principalId: "scim-someone-else" });
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
      await expect(
        store.datasetTeam.removeMember({
          datasetId: DATASET_ID,
          email: TESS.email,
          role: "tester",
        }),
      ).rejects.toMatchObject({ code: "owner-mismatch" });

      expect(await drewOwner(store)).toMatchObject({
        matchedPrincipalId: "scim-drew-1",
        mismatch: { principalId: "scim-someone-else", at: "2026-10-01T12:00:01.000Z" },
      });
      // Drew (manager) and Tess (tester): nothing new was recorded.
      actAs(DREW_SIGNED_IN);
      expect(await addedMembers(store, DATASET_ID)).toHaveLength(2);
    });

    it("ignores emails in what the caller sends: only the session identifies the actor", async () => {
      const { store, actAs } = await withDrewAsOwner();
      actAs(STRANGER);

      // The stranger names Drew, an owner, as the person to add and as a new owner.
      await expect(
        store.datasetRoles.addMember({ datasetId: DATASET_ID, ...DREW, role: "tester" }),
      ).rejects.toMatchObject({ code: "not-owner" });
      await expect(
        store.datasetTeam.addOwner({
          datasetId: DATASET_ID,
          name: STRANGER.name,
          email: DREW.email,
        }),
      ).rejects.toMatchObject({ code: "not-owner" });
      expect((await drewOwner(store))?.matchedPrincipalId).toBeUndefined();
    });
  });

  describe("an owner email's binding outlives the owner record (ADR-0006)", () => {
    const IMPOSTOR: UserProfile = { ...DREW_SIGNED_IN, principalId: "scim-impostor-1" };
    const OTHER_DATASET = "ds-payroll-events";

    /** Drew is added by email and binds on their first protected action. */
    async function withDrewBound() {
      const ctx = setup();
      await ctx.store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      ctx.actAs(DREW_SIGNED_IN);
      await addTess(ctx.store);
      ctx.actAs(OWNER);
      return ctx;
    }
    const drewOn = async (store: ReturnType<typeof setup>["store"], datasetId = DATASET_ID) =>
      (await store.datasets.getDataset(datasetId))?.owners.find((o) => o.email === DREW.email);

    it("reads don't bind: only an ownership-protected action does", async () => {
      const { store, actAs } = setup();
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      actAs(DREW_SIGNED_IN);

      await store.datasets.listDatasets();
      await addedMembers(store, DATASET_ID);
      await store.datasetTeam.listTeamEvents(DATASET_ID);

      expect((await drewOn(store))?.matchedPrincipalId).toBeUndefined();
    });

    it("keys a bound owner by their SCIM id, an unbound one by email", async () => {
      const { store } = await withDrewBound();
      await store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: "Pat",
        email: "pat@example.gov",
      });
      const owners = (await store.datasets.getDataset(DATASET_ID))!.owners;

      expect(owners.map(ownerKey)).toEqual([OWNER.principalId, "scim-drew-1", "pat@example.gov"]);
    });

    it("remove, re-add, then a different SCIM id with the same email is refused", async () => {
      const { store, actAs } = await withDrewBound();
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: "scim-drew-1" });
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      expect(await drewOn(store)).toMatchObject({ matchedPrincipalId: "scim-drew-1" });
      actAs(IMPOSTOR);
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
      expect((await drewOn(store))?.mismatch?.principalId).toBe("scim-impostor-1");
    });

    it("records the refusal when an impostor's protected add is refused on a mismatch", async () => {
      const { store, actAs } = await withDrewBound();
      // The impostor signs in with Drew's email under their own SCIM id and adds
      // a member directly; the refusal is recorded on both backends, so a
      // refused attempt is never silent (ADR-0006, #123).
      actAs(IMPOSTOR);
      await expect(
        store.datasetRoles.addMember({
          datasetId: DATASET_ID,
          name: "New Member",
          email: "new.member@example.gov",
          role: "developer",
        }),
      ).rejects.toMatchObject({ code: "owner-mismatch" });

      expect((await drewOn(store))?.mismatch?.principalId).toBe("scim-impostor-1");
      // The add wrote nothing.
      expect(
        (await addedMembers(store, DATASET_ID)).some(
          (m) => m.person.email === "new.member@example.gov",
        ),
      ).toBe(false);
    });

    it("removing an owner (and their manager role) doesn't clear the binding", async () => {
      const { store, actAs } = await withDrewBound();
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: "scim-drew-1" });
      expect(
        (await addedMembers(store, DATASET_ID)).some((m) => m.person.email === DREW.email),
      ).toBe(false);

      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      expect(await drewOn(store)).toMatchObject({ matchedPrincipalId: "scim-drew-1" });
      actAs(IMPOSTOR);
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
    });

    it("a re-added bound owner works for the original SCIM id", async () => {
      const { store, actAs } = await withDrewBound();
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: DREW.email });
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      actAs({ ...DREW_SIGNED_IN, email: "drew.renamed@example.gov" });
      await expect(
        store.datasetRoles.addMember({
          datasetId: DATASET_ID,
          name: "New Member",
          email: "new.member@example.gov",
          role: "developer",
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it("EDP staff reassignment reuses the binding and can't rebind", async () => {
      const { store, actAs } = await withDrewBound();
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: "scim-drew-1" });
      actAs(STAFF);
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      expect(await drewOn(store)).toMatchObject({ matchedPrincipalId: "scim-drew-1" });
      actAs(IMPOSTOR);
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
    });

    it("EDP staff go through the mismatch check too: a staff session can't act via someone else's bound email", async () => {
      const { store, actAs } = await withDrewBound();
      actAs({ ...STAFF, email: DREW.email });

      await expect(
        store.datasetTeam.addOwner({ datasetId: DATASET_ID, name: "Pat", email: "pat@example.gov" }),
      ).rejects.toMatchObject({ code: "owner-mismatch" });
      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId }),
      ).rejects.toMatchObject({ code: "owner-mismatch" });
      expect((await store.datasets.getDataset(DATASET_ID))?.owners).toHaveLength(2);
    });

    it("a binding covers the email on every dataset", async () => {
      const { store, actAs } = await withDrewBound();
      await store.datasetTeam.addOwner({ datasetId: OTHER_DATASET, ...DREW });

      expect(await drewOn(store, OTHER_DATASET)).toMatchObject({
        matchedPrincipalId: "scim-drew-1",
      });
      actAs(IMPOSTOR);
      await expect(
        store.datasetTeam.addOwner({ datasetId: OTHER_DATASET, name: "Pat", email: "pat@example.gov" }),
      ).rejects.toMatchObject({ code: "owner-mismatch" });
      actAs(DREW_SIGNED_IN);
      await expect(
        store.datasetTeam.addOwner({ datasetId: OTHER_DATASET, name: "Pat", email: "pat@example.gov" }),
      ).resolves.toBeDefined();
    });
  });

  describe("seeded (intake) owners hold the manager role too (ADR-0005)", () => {
    function twoSeededOwners(): DatasetSeed {
      const seed = makeDatasetSeed();
      seed.datasets[0]!.owners.push({ principalId: "scim-owner-2", displayName: "Quinn Second" });
      return seed;
    }
    const quinnManager = {
      datasetId: DATASET_ID,
      person: { name: "Quinn Second", email: "", principalId: "scim-owner-2" },
      role: "manager",
      addedBy: "intake",
    };

    it("the seed gives every owner a manager role record, identified by SCIM id when there's no email", async () => {
      const { store } = setup({ datasetSeed: twoSeededOwners() });

      expect(await store.datasetRoles.listMembers(DATASET_ID)).toEqual([
        expect.objectContaining({
          person: { name: OWNER.name, email: "", principalId: OWNER.principalId },
          role: "manager",
          addedBy: "intake",
        }),
        expect.objectContaining(quinnManager),
      ]);
      // Created by the seed (standup), not listed as app changes.
      expect(await store.changeList.listEntries()).toEqual([]);
    });

    it("an intake owner's manager role can't be edited or removed while they're an owner", async () => {
      const { store } = setup({ datasetSeed: twoSeededOwners() });
      await expect(
        store.datasetTeam.removeMember({ datasetId: DATASET_ID, email: "", role: "manager" }),
      ).rejects.toMatchObject({ code: "owner-holds-manager" });
    });

    it("removing an intake owner removes their manager role and lists the entry by SCIM id", async () => {
      const { store } = setup({ datasetSeed: twoSeededOwners() });

      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET_ID,
        owner: "scim-owner-2",
      });

      expect(result.entries).toEqual([
        {
          id: "CL-0001",
          kind: "remove-member",
          target: {
            group: "edp-refund_anomalies-manager",
            person: { name: "Quinn Second", email: "", principalId: "scim-owner-2" },
            datasetId: DATASET_ID,
            role: "manager",
          },
          grants: ["Test grant: read/write", "Test grant: manage"],
          reason: {
            kind: "dataset-owner-removed",
            datasetId: DATASET_ID,
            removedBy: OWNER.principalId,
            removedAt: "2026-10-01T12:00:00.000Z",
          },
          createdBy: OWNER.principalId,
          createdAt: "2026-10-01T12:00:00.000Z",
          applied: null,
        },
      ]);
      expect(
        (await store.datasetRoles.listMembers(DATASET_ID)).map((m) => m.person.principalId),
      ).toEqual([OWNER.principalId]);
    });

    it("EDP staff reassigning ownership away from an intake owner removes and lists their manager role", async () => {
      const { store, actAs } = setup();
      actAs(STAFF);
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });

      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET_ID,
        owner: OWNER.principalId,
      });

      expect(result.entries).toEqual([
        expect.objectContaining({
          kind: "remove-member",
          target: expect.objectContaining({
            group: "edp-refund_anomalies-manager",
            person: { name: OWNER.name, email: "", principalId: OWNER.principalId },
            role: "manager",
          }),
          reason: expect.objectContaining({ kind: "dataset-owner-removed" }),
          createdBy: STAFF.principalId,
        }),
      ]);
      expect((await store.datasetRoles.listMembers(DATASET_ID)).map((m) => m.person.name)).toEqual([
        DREW.name,
      ]);
    });

    it("refuses to remove an owner with no email and no SCIM id, since staff couldn't act on the entry", async () => {
      const seed = twoSeededOwners();
      seed.datasets[0]!.owners.push({ displayName: "Nameless Record" });
      const { store } = setup({ datasetSeed: seed });

      if (backend === "delta") {
        // On Delta such a record can't exist: the owner table's CHECK needs an
        // email or an account ID, so the configuration is refused when it loads.
        await expect(store.datasets.getDataset(DATASET_ID)).rejects.toThrow(
          /Nameless Record.*no email or Databricks account ID/,
        );
        return;
      }
      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: "Nameless Record" }),
      ).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringMatching(/no email or SCIM id.*from the Maintainer group/),
      });
      expect((await store.datasets.getDataset(DATASET_ID))?.owners).toHaveLength(3);
      expect(await store.changeList.listEntries()).toEqual([]);
    });
  });

  describe("one person, one identity: the dual-record bypass (ADR-0006)", () => {
    /** The seeded owner, signed in: their SCIM id is on the seed, their email isn't. */
    const OLIVE_EMAIL = OWNER.email;
    const IMPOSTOR: UserProfile = {
      ...STRANGER,
      principalId: "scim-impostor-9",
      email: OLIVE_EMAIL,
    };
    const bindingOf = async (store: ReturnType<typeof setup>["store"], email: string) =>
      (await store.datasets.getDataset(DATASET_ID))?.owners.find((o) => o.email === email)
        ?.matchedPrincipalId;

    it("the exact attack: seeded SCIM owner, same person added by email, real owner acts, an impostor with that email is refused", async () => {
      const { store, actAs } = setup();
      // Before Olive has acted, EDP staff make Drew a co-owner, and Drew adds
      // Olive again by email: her email isn't bound yet, so it can't be caught.
      actAs(STAFF);
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      actAs(DREW_SIGNED_IN);
      await store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: OWNER.name,
        email: OLIVE_EMAIL,
      });

      // The real owner acts; they match by SCIM id, which binds their session email.
      actAs(OWNER);
      await addTess(store);
      expect(await bindingOf(store, OLIVE_EMAIL)).toBe(OWNER.principalId);

      actAs(IMPOSTOR);
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
      await expect(
        store.datasetTeam.addOwner({ datasetId: DATASET_ID, name: "X", email: "x@example.gov" }),
      ).rejects.toMatchObject({ code: "owner-mismatch" });
    });

    it("a match by SCIM id binds the session email, store-wide", async () => {
      const { store, actAs } = setup();
      await addTess(store); // Olive acts by SCIM id: binds her session email.
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      actAs(DREW_SIGNED_IN);

      // Now nobody can add Olive's email as a second owner record: she already owns it.
      await expect(
        store.datasetTeam.addOwner({ datasetId: DATASET_ID, name: OWNER.name, email: OLIVE_EMAIL }),
      ).rejects.toMatchObject({
        code: "duplicate",
        message: expect.stringMatching(/already an owner/),
      });
      // And an impostor with Olive's email can't use it anywhere.
      actAs(IMPOSTOR);
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
      // Flagged on Olive's own (SCIM) owner record for EDP staff to see.
      expect((await store.datasets.getDataset(DATASET_ID))?.owners[0]?.mismatch).toMatchObject({
        principalId: IMPOSTOR.principalId,
      });
    });

    it("refuses an owner whose session email is bound to another SCIM id, even when their own SCIM id matches", async () => {
      const { store, actAs } = await (async () => {
        const ctx = setup();
        await ctx.store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
        ctx.actAs(DREW_SIGNED_IN);
        await addTess(ctx.store); // binds drew.partner@example.gov to scim-drew-1
        ctx.actAs(OWNER);
        return ctx;
      })();

      actAs({ ...OWNER, email: DREW.email });
      await expect(addTess(store, "developer")).rejects.toMatchObject({ code: "owner-mismatch" });
    });

    it("the duplicate check works both ways (email record vs SCIM record)", () => {
      const bindings: OwnerBindings = new Map([
        [DREW.email, { principalId: "scim-drew-1", at: "2026-10-01T12:00:00.000Z" }],
      ]);
      const bySCIM = { owners: [{ principalId: "scim-drew-1", displayName: DREW.name }] };
      const byEmail = { owners: [{ displayName: DREW.name, email: DREW.email }] };

      // Adding Drew's email where Drew already owns by SCIM id.
      expect(findSameOwner(bySCIM, { email: DREW.email }, bindings)?.displayName).toBe(DREW.name);
      // Adding Drew's SCIM id where Drew already owns by (bound) email.
      expect(findSameOwner(byEmail, { principalId: "scim-drew-1" }, bindings)?.email).toBe(
        DREW.email,
      );
      // Someone else, either way.
      expect(findSameOwner(bySCIM, { email: "pat@example.gov" }, bindings)).toBeUndefined();
      expect(findSameOwner(byEmail, { principalId: "scim-pat-1" }, bindings)).toBeUndefined();
    });

    it("an owner held twice before binding is removed as one person, with every record and manager role", async () => {
      const { store, actAs } = setup();
      actAs(STAFF); // so Olive hasn't acted, and her email isn't bound yet
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      actAs(DREW_SIGNED_IN);
      // Before Olive ever acts, her email is unbound, so this can't be detected yet.
      await store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: OWNER.name,
        email: OLIVE_EMAIL,
      });
      actAs(OWNER);
      await addTess(store); // binds Olive's email: both records are now Olive

      actAs(DREW_SIGNED_IN);
      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET_ID,
        owner: OWNER.principalId,
      });

      expect(
        (await store.datasets.getDataset(DATASET_ID))?.owners.map((o) => o.displayName),
      ).toEqual([DREW.name]);
      expect(result.entries.map((e) => [e.kind, e.target.person.email || "scim"])).toEqual([
        ["remove-member", "scim"],
        ["remove-member", OLIVE_EMAIL],
      ]);
      // With Drew the only person left, removing him is the last-owner case.
      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: DREW.email }),
      ).rejects.toMatchObject({ code: "last-owner" });
    });

    it("two records for one person don't count as two owners", async () => {
      const { store, actAs } = setup();
      actAs(STAFF); // so Olive hasn't acted, and her email isn't bound yet
      await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...DREW });
      actAs(DREW_SIGNED_IN);
      await store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: OWNER.name,
        email: OLIVE_EMAIL,
      });
      actAs(OWNER);
      await addTess(store);
      await store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: DREW.email });

      // Only Olive remains, held by two records: removing either is the last-owner case.
      await expect(
        store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OLIVE_EMAIL }),
      ).rejects.toMatchObject({ code: "last-owner" });
    });
  });
});
