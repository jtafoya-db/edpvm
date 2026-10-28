// @vitest-environment node
/**
 * EDP staff match an onboarding request's owners to Databricks principals,
 * or request onboarding for owners who aren't users yet (#103, slice 103-B),
 * as a contract both DataStore adapters satisfy.
 *
 * - `memory`: the memory adapter, as the app runs in local development;
 * - `delta`: the Delta adapter end to end, its real HTTP transport, the
 *   server's API router, the transaction runner and every area, over the
 *   SQLite fake warehouse built from the real DDL.
 *
 * Who is acting is always the signed-in session. A staff match records only
 * the principal ID it was given, labelled as entered by staff and not
 * verified; it never writes an ADR-0006 email binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeltaStore, httpTransport } from "../adapters/delta";
import { createMemoryStore } from "../adapters/memory";
import type { OnboardUserEntry } from "../change-list/types";
import { DEFAULT_DATASET_SEED } from "../datasets/seed";
import type { OnboardingIntake, OnboardingOwnerMatch, OnboardingRequest } from "../onboarding";
import { INITIATIVE_OWNER_ID, ownersForStandup } from "../onboarding/owners";
import { completeIntake } from "../onboarding/intake.fixtures";
import type { DataStore } from "../store";
import type { UserProfile } from "../types";
import { errorResponse, handleDeltaApiRequest, type DeltaApiDeps } from "../../server/delta/api.ts";
import { createAppRegistry } from "../../server/delta/areas/index.ts";
import {
  configuredDatasetsLoader,
  needsConfiguredDatasets,
} from "../../server/delta/areas/teams-seed.ts";
import type { CommandDefinition } from "../../server/delta/registry.ts";
import { createStoreNames } from "../../server/delta/sql-builder.ts";
import { createTransactionRunner } from "../../server/delta/transaction.ts";
import {
  createSqliteWarehouse,
  type SqliteWarehouse,
} from "../../server/delta/__tests__/sqlite-warehouse.ts";
import { makeSnapshot } from "./fixture";

const BACKENDS = ["memory", "delta"] as const;
type Backend = (typeof BACKENDS)[number];

function person(principalId: string, name: string, email: string, staff = false): UserProfile {
  return {
    ...makeSnapshot().user,
    principalId,
    name,
    email,
    isAdmin: staff,
    isSafeguardsValidator: staff,
    onboardingReviewerRoles: staff ? ["business-office", "ccb"] : [],
  };
}

const PROVIDER = person("scim-provider", "Pat Provider", "pat.provider@example.gov");
/** EDP staff: a member of the EDP admin group, so every staff role (#226). */
const STAFF = person("scim-staff", "Sasha Staff", "sasha.staff@example.gov", true);
/** A reviewer who isn't EDP staff (a per-role group a later split could bring back). */
const REVIEWER: UserProfile = {
  ...person("scim-reviewer", "Rae Reviewer", "rae.reviewer@example.gov"),
  onboardingReviewerRoles: ["business-office"],
};

const OLIVE = { name: "Olive Owner", email: "Olive.Owner@example.gov" };
const NOEL = { name: "Noel Newhire", email: "noel.newhire@example.gov" };

function intake(): OnboardingIntake {
  return completeIntake({
    initiativeName: "Collections case signals",
    initiativeOwner: { kind: "someone-else", name: "Ivy Initiative", email: "ivy.i@example.gov" },
    datasets: [
      {
        name: "Case signals",
        sourceSystem: "IMF / Individual Master File",
        domain: "individual-filing",
        ingestionMethod: "eftu",
        datasetTag: "case_signals",
        owners: [{ self: true, name: "", email: "" }, { ...OLIVE }, { ...NOEL }],
      },
    ],
  });
}

interface Harness {
  store: DataStore;
  signIn(user: UserProfile): void;
  /** Delta only: the warehouse, for assertions on stored rows. */
  warehouse?: SqliteWarehouse;
}

function createHarness(backend: Backend): Harness {
  let signedIn: UserProfile = PROVIDER;
  const currentUser = async () => structuredClone(signedIn);
  const now = () => new Date();
  if (backend === "memory") {
    return {
      store: createMemoryStore(makeSnapshot(), { currentUser, now }),
      signIn: (user) => (signedIn = user),
    };
  }
  const warehouse = createSqliteWarehouse({
    files: ["store-admin.sql", "store-teams.sql", "store-onboarding.sql"],
    now,
  });
  const names = createStoreNames("edp_test", "");
  const registry = createAppRegistry();
  const runner = createTransactionRunner({
    client: warehouse.client,
    names,
    now,
    sleep: async () => undefined,
    refusalCommand: () =>
      registry.findWrite("teams", "record-ownership-refusal") as
        CommandDefinition<{ datasetId: string }, unknown> | undefined,
  });
  const deps: DeltaApiDeps = {
    registry,
    runner,
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => ({
      principalId: signedIn.principalId,
      displayName: signedIn.name,
      email: signedIn.email,
      isAdmin: signedIn.isAdmin,
      onboardingReviewerRoles: [...(signedIn.onboardingReviewerRoles ?? [])],
    }),
    requirePrivacyAcknowledgment: async () => undefined,
  };
  const load = configuredDatasetsLoader(() => DEFAULT_DATASET_SEED, { runner, names });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const request = new Request(new URL(url, "http://edp.test"), init);
    if (needsConfiguredDatasets(new URL(request.url).pathname)) {
      try {
        await load();
      } catch (error) {
        return errorResponse(error, "loading the configured datasets");
      }
    }
    return handleDeltaApiRequest(request, deps);
  }) as typeof fetch;
  return {
    store: createDeltaStore({
      transport: httpTransport(fetchImpl),
      accessStores: { currentUser, now },
    }),
    signIn: (user) => (signedIn = user),
    warehouse,
  };
}

const matchOf = (request: OnboardingRequest, email: string): OnboardingOwnerMatch => {
  const found = request.ownerMatches.find((owner) => owner.email === email.toLowerCase());
  if (!found) throw new Error(`No owner ${email} on ${request.id}`);
  return found;
};

const onboardUserEntries = async (store: DataStore): Promise<OnboardUserEntry[]> =>
  (await store.changeList.listEntries()).filter(
    (entry): entry is OnboardUserEntry => entry.kind === "onboard-user",
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T14:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(BACKENDS)("owner matching (%s)", (backend) => {
  let h: Harness;
  let submitted: OnboardingRequest;

  beforeEach(async () => {
    h = createHarness(backend);
    h.signIn(PROVIDER);
    submitted = await h.store.onboarding.submit(intake());
  });

  const asStaff = () => h.signIn(STAFF);
  /** The request as EDP staff read it: through the staff inbox, a staff-app read. */
  const staffRead = async (id: string): Promise<OnboardingRequest> => {
    asStaff();
    const found = (await h.store.onboarding.listInbox("business-office")).find((r) => r.id === id);
    if (!found) throw new Error(`${id} isn't in the business & ROI inbox`);
    return found;
  };
  const oliveId = () => matchOf(submitted, OLIVE.email).ownerId;

  describe("staff see every owner with a match state", () => {
    it("lists the initiative owner and each dataset owner, Myself already matched", async () => {
      asStaff();
      const [request] = await h.store.onboarding.listInbox("business-office");

      expect(
        request!.ownerMatches.map(({ ownerId: _id, datasetId: _d, ...owner }) => owner),
      ).toEqual([
        {
          role: "initiative",
          name: "Ivy Initiative",
          email: "ivy.i@example.gov",
          state: "unmatched",
          principalId: null,
          matchedBy: null,
          onboardingEntryId: null,
        },
        {
          role: "dataset",
          name: "Pat Provider",
          email: "pat.provider@example.gov",
          state: "matched",
          principalId: "scim-provider",
          matchedBy: { kind: "self" },
          onboardingEntryId: null,
        },
        {
          role: "dataset",
          name: "Olive Owner",
          email: "olive.owner@example.gov",
          state: "unmatched",
          principalId: null,
          matchedBy: null,
          onboardingEntryId: null,
        },
        {
          role: "dataset",
          name: "Noel Newhire",
          email: "noel.newhire@example.gov",
          state: "unmatched",
          principalId: null,
          matchedBy: null,
          onboardingEntryId: null,
        },
      ]);
      expect(request!.ownerMatches[0]!.ownerId).toBe(INITIATIVE_OWNER_ID);
      expect(request!.ownerMatches[0]!.datasetId).toBeNull();
      expect(request!.ownerMatches[2]!.datasetId).toBe(request!.intake.datasets[0]!.id);
    });
  });

  describe("staff match an owner by principal ID", () => {
    it("records the ID, who matched and when, labelled entered by staff and not verified", async () => {
      asStaff();
      const matched = await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: " 7412589630 ",
      });

      expect(matchOf(matched, OLIVE.email)).toMatchObject({
        state: "matched",
        principalId: "7412589630",
        matchedBy: {
          kind: "staff",
          principalId: "scim-staff",
          name: "Sasha Staff",
          at: "2026-10-19T14:00:00.000Z",
        },
      });
      // Entered by staff is not verified: only Myself is (#103 decision 6244111956).
      expect(matched.ownerVerification[oliveId()]).toBe("not-verified");
      expect(matched.version).toBe(submitted.version + 1);
      expect(matched.stage).toBe(submitted.stage);
      // A match isn't a review decision.
      expect(matched.decisions).toEqual(submitted.decisions);
    });

    it("matches the initiative owner too", async () => {
      asStaff();
      const matched = await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: INITIATIVE_OWNER_ID,
        principalId: "1234",
      });
      expect(matched.ownerMatches[0]).toMatchObject({ state: "matched", principalId: "1234" });
      expect(matched.initiativeOwner).toMatchObject({
        principalId: "1234",
        verification: "not-verified",
      });
    });

    it.each(["abc", "12 34", "", "1".repeat(21), "12345-6"])(
      "refuses a principal ID that isn't a Databricks ID: %j",
      async (principalId) => {
        asStaff();
        await expect(
          h.store.onboarding.matchOwner(submitted.id, { ownerId: oliveId(), principalId }),
        ).rejects.toMatchObject({ code: "invalid-principal-id" });
      },
    );

    it("refuses to rematch an owner picked as Myself", async () => {
      asStaff();
      const self = matchOf(submitted, PROVIDER.email).ownerId;
      await expect(
        h.store.onboarding.matchOwner(submitted.id, { ownerId: self, principalId: "1234" }),
      ).rejects.toMatchObject({ code: "owner-verified" });
    });

    it("refuses an owner the request doesn't have", async () => {
      asStaff();
      await expect(
        h.store.onboarding.matchOwner(submitted.id, { ownerId: "nobody", principalId: "1234" }),
      ).rejects.toMatchObject({ code: "owner-not-found" });
    });

    it("refuses a match against a version that has moved on", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      await expect(
        h.store.onboarding.matchOwner(
          submitted.id,
          { ownerId: oliveId(), principalId: "5678" },
          { key: crypto.randomUUID(), version: submitted.version },
        ),
      ).rejects.toMatchObject({ code: "version-conflict" });
    });

    it("lets staff correct a match, since it binds nothing", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      const corrected = await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "5678",
      });
      expect(matchOf(corrected, OLIVE.email).principalId).toBe("5678");
    });

    it("refuses a match on a closed request", async () => {
      h.signIn(PROVIDER);
      await h.store.onboarding.withdraw(submitted.id);
      asStaff();
      await expect(
        h.store.onboarding.matchOwner(submitted.id, { ownerId: oliveId(), principalId: "1234" }),
      ).rejects.toMatchObject({ code: "not-found" });
    });
  });

  describe("only EDP staff can match owners or request onboarding", () => {
    it.each([
      ["the provider", PROVIDER],
      ["a reviewer who isn't EDP staff", REVIEWER],
    ])("refuses %s", async (_who, user) => {
      h.signIn(user);
      await expect(
        h.store.onboarding.matchOwner(submitted.id, { ownerId: oliveId(), principalId: "1234" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        h.store.onboarding.requestOwnerOnboarding(submitted.id, { ownerId: oliveId() }),
      ).rejects.toMatchObject({ code: "forbidden" });
      h.signIn(PROVIDER);
      const after = await h.store.onboarding.get(submitted.id);
      expect(matchOf(after!, OLIVE.email).state).toBe("unmatched");
    });
  });

  describe("request onboarding lists one onboard-user entry", () => {
    it("lists one entry naming the person and the initiative, and repeating it lists no second", async () => {
      asStaff();
      const noel = matchOf(submitted, NOEL.email).ownerId;
      const first = await h.store.onboarding.requestOwnerOnboarding(submitted.id, {
        ownerId: noel,
      });
      const again = await h.store.onboarding.requestOwnerOnboarding(submitted.id, {
        ownerId: noel,
      });

      const entries = await onboardUserEntries(h.store);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry).toMatchObject({
        kind: "onboard-user",
        target: {
          person: { name: "Noel Newhire", email: "noel.newhire@example.gov" },
          initiative: { onboardingRequestId: submitted.id, name: "Collections case signals" },
        },
        reason: {
          kind: "owner-not-a-databricks-user",
          onboardingRequestId: submitted.id,
          requestedBy: "scim-staff",
          requestedAt: "2026-10-19T14:00:00.000Z",
        },
        createdBy: "scim-staff",
        applied: null,
      });
      expect(matchOf(first, NOEL.email)).toMatchObject({
        state: "onboarding-requested",
        onboardingEntryId: entry!.id,
      });
      expect(matchOf(again, NOEL.email).onboardingEntryId).toBe(entry!.id);
      if (h.warehouse) {
        // A live warehouse can't cast a STRING-typed null parameter to
        // ARRAY<STRING> (DATATYPE_MISMATCH on edp-vm-pr272), so the entry's
        // membership-only grants column gets a typed null.
        const insert = h.warehouse.statements.find((sql) =>
          /INSERT INTO \S*change_list_entries/.test(sql),
        );
        expect(insert).toContain("CAST(NULL AS ARRAY<STRING>)");
      }
    });

    it("shares one pending entry between owners with the same email", async () => {
      asStaff();
      await h.store.onboarding.requestOwnerOnboarding(submitted.id, {
        ownerId: matchOf(submitted, NOEL.email).ownerId,
      });
      h.signIn(PROVIDER);
      const second = await h.store.onboarding.submit(
        completeIntake({
          datasets: [
            {
              name: "Second",
              sourceSystem: "IMF / Individual Master File",
              domain: "individual-filing",
              ingestionMethod: "eftu",
              datasetTag: "second_signals",
              owners: [{ name: "Noel N.", email: "NOEL.newhire@example.gov" }],
            },
          ],
        }),
      );
      expect(matchOf(second, NOEL.email).state).toBe("onboarding-requested");
      asStaff();
      await h.store.onboarding.requestOwnerOnboarding(second.id, {
        ownerId: matchOf(second, NOEL.email).ownerId,
      });
      expect(await onboardUserEntries(h.store)).toHaveLength(1);
    });

    it("refuses to request onboarding for an owner already matched", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      await expect(
        h.store.onboarding.requestOwnerOnboarding(submitted.id, { ownerId: oliveId() }),
      ).rejects.toMatchObject({ code: "owner-matched" });
    });

    it("keeps onboard-user entries off a non-staff change list", async () => {
      asStaff();
      await h.store.onboarding.requestOwnerOnboarding(submitted.id, {
        ownerId: matchOf(submitted, NOEL.email).ownerId,
      });
      h.signIn(PROVIDER);
      expect(await onboardUserEntries(h.store)).toEqual([]);
    });
  });

  describe("applying an onboard-user entry returns the owner to unmatched", () => {
    it("marks the entry applied and the owner reads as unmatched", async () => {
      asStaff();
      const noel = matchOf(submitted, NOEL.email).ownerId;
      await h.store.onboarding.requestOwnerOnboarding(submitted.id, { ownerId: noel });
      const [entry] = await onboardUserEntries(h.store);
      const applied = await h.store.changeList.markApplied(entry!.id);
      expect(applied).toMatchObject({ kind: "onboard-user", applied: { by: "scim-staff" } });

      const after = await h.store.onboarding.get(submitted.id);
      expect(matchOf(after!, NOEL.email)).toMatchObject({
        state: "unmatched",
        onboardingEntryId: null,
      });
      // Now a user, they can be matched; a new request would list a new entry.
      const matched = await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: noel,
        principalId: "998877",
      });
      expect(matchOf(matched, NOEL.email).state).toBe("matched");
    });
  });

  describe("the provider sees each owner's match state", () => {
    it("reads the states staff set on their own request", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      await h.store.onboarding.requestOwnerOnboarding(submitted.id, {
        ownerId: matchOf(submitted, NOEL.email).ownerId,
      });
      h.signIn(PROVIDER);
      const [mine] = await h.store.onboarding.listMine();
      expect(mine!.ownerMatches.map(({ email, state }) => [email, state])).toEqual([
        ["ivy.i@example.gov", "unmatched"],
        ["pat.provider@example.gov", "matched"],
        ["olive.owner@example.gov", "matched"],
        ["noel.newhire@example.gov", "onboarding-requested"],
      ]);
    });
  });

  describe("the provider reads match state only; IDs and who matched stay with staff", () => {
    async function staffActed(): Promise<void> {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "7412589630",
      });
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: INITIATIVE_OWNER_ID,
        principalId: "4321",
      });
      await h.store.onboarding.requestOwnerOnboarding(submitted.id, {
        ownerId: matchOf(submitted, NOEL.email).ownerId,
      });
    }
    const states = (request: OnboardingRequest) =>
      request.ownerMatches.map(({ ownerId: _o, datasetId: _d, ...owner }) => owner);
    const STATE_ONLY = [
      {
        role: "initiative",
        name: "Ivy Initiative",
        email: "ivy.i@example.gov",
        state: "matched",
        principalId: null,
        matchedBy: { kind: "staff" },
        onboardingEntryId: null,
      },
      {
        role: "dataset",
        name: "Pat Provider",
        email: "pat.provider@example.gov",
        state: "matched",
        principalId: null,
        matchedBy: { kind: "self" },
        onboardingEntryId: null,
      },
      {
        role: "dataset",
        name: "Olive Owner",
        email: "olive.owner@example.gov",
        state: "matched",
        principalId: null,
        matchedBy: { kind: "staff" },
        onboardingEntryId: null,
      },
      {
        role: "dataset",
        name: "Noel Newhire",
        email: "noel.newhire@example.gov",
        state: "onboarding-requested",
        principalId: null,
        matchedBy: null,
        onboardingEntryId: null,
      },
    ];
    const expectStateOnlyOwners = (request: OnboardingRequest) => {
      expect(states(request)).toEqual(STATE_ONLY);
      expect(request.initiativeOwner).toMatchObject({ principalId: null });
    };

    it("gives the provider's request read and list the state, with no principal, matcher or entry", async () => {
      await staffActed();
      h.signIn(PROVIDER);
      const one = (await h.store.onboarding.get(submitted.id))!;
      const [mine] = await h.store.onboarding.listMine();
      for (const read of [one, mine!]) {
        expectStateOnlyOwners(read);
      }
    });

    it("gives the provider's own write results the same state-only view", async () => {
      await staffActed();
      asStaff();
      const sent = await h.store.onboarding.decide(submitted.id, {
        type: "send-back",
        to: "submitted",
        note: "Which team runs this?",
      });
      h.signIn(PROVIDER);
      const resubmitted = await h.store.onboarding.resubmit(sent.id, {
        answer: "The case team.",
        intake: (await h.store.onboarding.get(sent.id))!.intake,
      });
      expectStateOnlyOwners(resubmitted);
    });

    it("keeps the IDs, who matched and when, and the entry on staff reads", async () => {
      await staffActed();
      const staff = await staffRead(submitted.id);
      expect(matchOf(staff, OLIVE.email)).toMatchObject({
        principalId: "7412589630",
        matchedBy: { kind: "staff", principalId: "scim-staff", name: "Sasha Staff" },
      });
      expect(matchOf(staff, NOEL.email).onboardingEntryId).toBe("CL-0001");
      expect(staff.initiativeOwner).toMatchObject({ principalId: "4321" });
    });

    it("keeps the provider's own Myself principal off the state-only view too", async () => {
      h.signIn(PROVIDER);
      const mine = (await h.store.onboarding.get(submitted.id))!;
      expect(matchOf(mine, PROVIDER.email)).toMatchObject({
        state: "matched",
        principalId: null,
        matchedBy: { kind: "self" },
      });
    });
  });

  describe("a resubmission keeps a staff match", () => {
    async function sendBack(): Promise<OnboardingRequest> {
      asStaff();
      const current = await h.store.onboarding.get(submitted.id);
      return h.store.onboarding.decide(current!.id, {
        type: "send-back",
        to: "submitted",
        note: "Which team runs this?",
      });
    }

    it("keeps an owner's match when the provider resubmits them unchanged", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: INITIATIVE_OWNER_ID,
        principalId: "4321",
      });
      const sent = await sendBack();
      h.signIn(PROVIDER);
      const resubmitted = await h.store.onboarding.resubmit(sent.id, {
        answer: "The case team.",
        intake: sent.intake,
      });

      // The provider's own result says matched, nothing more (state only).
      expect(matchOf(resubmitted, OLIVE.email)).toMatchObject({ state: "matched" });
      const staff = await staffRead(resubmitted.id);
      expect(matchOf(staff, OLIVE.email)).toMatchObject({
        state: "matched",
        principalId: "1234",
        matchedBy: { kind: "staff", principalId: "scim-staff" },
      });
      expect(staff.ownerMatches[0]).toMatchObject({ state: "matched", principalId: "4321" });
    });

    it("keeps the match when the provider changes only that owner's name", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      const sent = await sendBack();
      h.signIn(PROVIDER);
      const edited = structuredClone(sent.intake);
      edited.datasets[0]!.owners.find((o) => o.id === oliveId())!.name = "Olive O. Owner";
      const resubmitted = await h.store.onboarding.resubmit(sent.id, {
        answer: "Fixed Olive's name.",
        intake: edited,
      });
      expect(matchOf(await staffRead(resubmitted.id), OLIVE.email)).toMatchObject({
        name: "Olive O. Owner",
        state: "matched",
        principalId: "1234",
      });
    });

    it("clears the match when the provider changes that owner's email", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      const sent = await sendBack();
      h.signIn(PROVIDER);
      const edited = structuredClone(sent.intake);
      const olive = edited.datasets[0]!.owners.find((o) => o.id === oliveId())!;
      olive.email = "olive.other@example.gov";
      const resubmitted = await h.store.onboarding.resubmit(sent.id, {
        answer: "Fixed Olive's email.",
        intake: edited,
      });
      expect(matchOf(resubmitted, "olive.other@example.gov")).toMatchObject({
        state: "unmatched",
        principalId: null,
        matchedBy: null,
      });
    });
  });

  describe("matched IDs are exposed for standup", () => {
    it("lists each dataset owner's email and principal, an unmatched owner blocking", async () => {
      asStaff();
      await h.store.onboarding.matchOwner(submitted.id, {
        ownerId: oliveId(),
        principalId: "1234",
      });
      // Standup is EDP staff's: it reads the staff projection.
      const request = await staffRead(submitted.id);
      const datasetId = request.intake.datasets[0]!.id;
      expect(ownersForStandup(request)).toEqual([
        {
          datasetId,
          ownerEmail: "pat.provider@example.gov",
          principalId: "scim-provider",
          blocking: false,
        },
        { datasetId, ownerEmail: "olive.owner@example.gov", principalId: "1234", blocking: false },
        { datasetId, ownerEmail: "noel.newhire@example.gov", principalId: null, blocking: true },
      ]);
    });
  });

  it("a staff match writes no email binding (ADR-0006)", async () => {
    asStaff();
    await h.store.onboarding.matchOwner(submitted.id, {
      ownerId: oliveId(),
      principalId: "1234",
    });
    if (h.warehouse) {
      expect(h.warehouse.query("SELECT * FROM teams__email_bindings")).toEqual([]);
      expect(h.warehouse.query("SELECT * FROM teams__email_binding_actions")).toEqual([]);
      expect(
        h.warehouse.query(
          "SELECT person_principal_id, person_match_source FROM onboarding__onboarding_intake_owners WHERE id = :id",
          { id: oliveId() },
        ),
      ).toEqual([{ person_principal_id: "1234", person_match_source: "staff" }]);
    }
  });
});
