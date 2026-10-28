// @vitest-environment node
/**
 * The initiative owner and dataset owners picked as Myself (#103, slice
 * 103-A), on the Delta path: real commands on the SQLite fake warehouse built
 * from the provisioning DDL. Myself is the server-resolved session, never what
 * the browser sends; Someone else is a name and a normalised email with no
 * principal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardingIntake, OnboardingRequest } from "../../../data/onboarding";
import { COMPLETE_INTAKE_ANSWERS } from "../../../data/onboarding/intake.fixtures";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import type { SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const PROVIDER: SessionUser = {
  principalId: "scim-provider",
  displayName: "Pat Provider",
  email: "Pat.Provider@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: [],
};
const BUSINESS_OFFICE: SessionUser = {
  principalId: "scim-bo",
  displayName: "Bea Office",
  email: "bea.office@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: ["business-office"],
};

const INTAKE: OnboardingIntake = {
  initiativeName: "Collections case signals",
  businessCase: "Prioritize balance-due cases across treatment streams.",
  annualBenefit: 1_250_000,
  levers: ["taxgap"],
  datasets: [
    {
      name: "Case signals",
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      ingestionMethod: "eftu",
      datasetTag: "case_signals",
      owners: [
        { self: true, name: "", email: "" },
        { name: "Olive Owner", email: "Olive.Owner@example.gov" },
      ],
    },
  ],
  workspaceNeeds: { isolation: "shared", teamSize: 6 },
  answers: { dataName: "Collections case signals", ...COMPLETE_INTAKE_ANSWERS },
  initiativeOwner: { kind: "self" },
};

let warehouse: SqliteWarehouse;
let deps: DeltaApiDeps;
let signedIn: SessionUser = PROVIDER;
let keys = 0;
const names = createStoreNames("edp_vending", "");

async function command(user: SessionUser, name: string, expectedVersion: number, payload: unknown) {
  signedIn = user;
  const key = `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
  const response = await handleDeltaApiRequest(
    new Request(`https://app.example/api/commands/onboarding/${name}`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: key, expectedVersion, payload }),
    }),
    deps,
  );
  return {
    status: response.status,
    body: (await response.json()) as { result: OnboardingRequest; error?: { code: string } },
  };
}

async function ok(user: SessionUser, name: string, expectedVersion: number, payload: unknown) {
  const res = await command(user, name, expectedVersion, payload);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result;
}

async function readRequest(id: string): Promise<OnboardingRequest> {
  signedIn = PROVIDER;
  const response = await handleDeltaApiRequest(
    new Request(`https://app.example/api/reads/onboarding/request?id=${id}`),
    deps,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as OnboardingRequest;
}

const requestRow = () =>
  warehouse.query<Record<string, unknown>>(
    "SELECT initiative_owner_kind, initiative_owner_display, initiative_owner_email, initiative_owner_principal_id FROM onboarding__onboarding_requests",
  );
const ownerRows = () =>
  warehouse.query<Record<string, unknown>>(
    "SELECT id, person_display, person_email, person_principal_id FROM onboarding__onboarding_intake_owners ORDER BY position",
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T09:00:00.000Z"));
  warehouse = createSqliteWarehouse({
    files: ["store-admin.sql", "store-teams.sql", "store-onboarding.sql"],
  });
  deps = {
    registry: createAppRegistry(),
    runner: createTransactionRunner({ client: warehouse.client, names, sleep: async () => {} }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => signedIn,
    requirePrivacyAcknowledgment: async () => undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Myself stores the session's identity, not the browser's", () => {
  it("writes the session's principal, name and normalised email for the initiative owner and a Myself dataset owner", async () => {
    const created = await ok(PROVIDER, "submit", 0, { intake: INTAKE });

    expect(requestRow()).toEqual([
      {
        initiative_owner_kind: "self",
        initiative_owner_display: "Pat Provider",
        initiative_owner_email: "pat.provider@example.gov",
        initiative_owner_principal_id: "scim-provider",
      },
    ]);
    expect(ownerRows().map(({ id: _id, ...row }) => row)).toEqual([
      {
        person_display: "Pat Provider",
        person_email: "pat.provider@example.gov",
        person_principal_id: "scim-provider",
      },
      {
        person_display: "Olive Owner",
        person_email: "olive.owner@example.gov",
        person_principal_id: null,
      },
    ]);

    const read = await readRequest(created.id);
    for (const request of [created, read]) {
      expect(request.initiativeOwner).toEqual({
        kind: "self",
        name: "Pat Provider",
        email: "pat.provider@example.gov",
        principalId: "scim-provider",
        verification: "verified",
      });
      expect(request.intake.initiativeOwner).toEqual({ kind: "self" });
      const [mine, olive] = request.intake.datasets[0]!.owners;
      expect(mine).toMatchObject({ self: true, name: "Pat Provider" });
      expect(olive).not.toHaveProperty("self");
      expect(request.ownerVerification).toEqual({
        [mine!.id!]: "verified",
        [olive!.id!]: "not-verified",
      });
    }
  });

  it.each([
    [
      "the initiative owner",
      { ...INTAKE, initiativeOwner: { kind: "self", principalId: "scim-boss" } },
    ],
    [
      "a dataset owner",
      {
        ...INTAKE,
        datasets: [
          {
            ...INTAKE.datasets[0]!,
            owners: [{ name: "Boss", email: "boss@example.gov", principalId: "scim-boss" }],
          },
        ],
      },
    ],
  ])("refuses a principal smuggled in for %s", async (_label, intake) => {
    const res = await command(PROVIDER, "submit", 0, { intake });
    expect(res.status).toBe(400);
    expect(requestRow()).toEqual([]);
  });

  it("refuses Myself twice on one dataset", async () => {
    const me = { self: true, name: "", email: "" };
    const res = await command(PROVIDER, "submit", 0, {
      intake: { ...INTAKE, datasets: [{ ...INTAKE.datasets[0]!, owners: [me, me] }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid-intake");
    expect(requestRow()).toEqual([]);
  });

  it("refuses a submit with no initiative owner", async () => {
    const { initiativeOwner: _none, ...intake } = INTAKE;
    const res = await command(PROVIDER, "submit", 0, { intake });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid-intake");
  });
});

describe("Someone else and a resubmission", () => {
  it("stores Someone else with no principal, and a resubmission from Myself clears it", async () => {
    const created = await ok(PROVIDER, "submit", 0, { intake: INTAKE });
    const sentBack = await ok(BUSINESS_OFFICE, "decide", created.version, {
      requestId: created.id,
      decision: { type: "send-back", to: "submitted", note: "Who owns this?" },
    });
    const ownerIds = ownerRows().map((row) => row["id"]);
    const dataset = sentBack.intake.datasets[0]!;
    const resubmitted = await ok(PROVIDER, "resubmit", sentBack.version, {
      requestId: created.id,
      resubmission: {
        answer: "Sam owns it.",
        intake: {
          ...sentBack.intake,
          initiativeOwner: { kind: "someone-else", name: " Sam Else ", email: "Sam.Else@example.gov" },
          datasets: [
            {
              ...dataset,
              owners: dataset.owners.map((owner, i) =>
                i === 0
                  ? { id: owner.id, name: "Sam Else", email: "sam.else@example.gov" }
                  : { id: owner.id, name: owner.name, email: owner.email },
              ),
            },
          ],
        },
      },
    });

    expect(requestRow()).toEqual([
      {
        initiative_owner_kind: "someone-else",
        initiative_owner_display: "Sam Else",
        initiative_owner_email: "sam.else@example.gov",
        initiative_owner_principal_id: null,
      },
    ]);
    // The same owner records (#222); the one that was Myself has no principal now.
    expect(ownerRows()).toEqual([
      {
        id: ownerIds[0],
        person_display: "Sam Else",
        person_email: "sam.else@example.gov",
        person_principal_id: null,
      },
      {
        id: ownerIds[1],
        person_display: "Olive Owner",
        person_email: "olive.owner@example.gov",
        person_principal_id: null,
      },
    ]);
    expect(resubmitted.initiativeOwner).toMatchObject({ verification: "not-verified" });
    expect((await readRequest(created.id)).initiativeOwner).toEqual({
      kind: "someone-else",
      name: "Sam Else",
      email: "sam.else@example.gov",
      principalId: null,
      verification: "not-verified",
    });
  });
});

describe("an older request's steward is kept read-only by the server (#103)", () => {
  const storedAnswers = () =>
    warehouse
      .query<{ intake_answers: string }>(
        "SELECT intake_answers FROM onboarding__onboarding_requests",
      )
      .map((row) => JSON.parse(row.intake_answers) as Record<string, unknown>);

  it("drops a steward the browser sends with a new request", async () => {
    await ok(PROVIDER, "submit", 0, {
      intake: { ...INTAKE, answers: { ...INTAKE.answers, steward: "Crafted Steward" } },
    });
    expect(storedAnswers()[0]).not.toHaveProperty("steward");
  });

  it.each([
    ["altered", { steward: "Crafted Steward" }],
    ["deleted", {}],
  ])("keeps an older request's stored steward when a resubmission %s it", async (_how, steward) => {
    const created = await ok(PROVIDER, "submit", 0, { intake: INTAKE });
    // As a request made before the steward was dropped holds it.
    warehouse.query("UPDATE onboarding__onboarding_requests SET intake_answers = :answers", {
      answers: JSON.stringify({ ...storedAnswers()[0], steward: "Older Steward" }),
    });
    const sentBack = await ok(BUSINESS_OFFICE, "decide", created.version, {
      requestId: created.id,
      decision: { type: "send-back", to: "submitted", note: "Restate it." },
    });
    const { steward: _stored, ...answers } = sentBack.intake.answers;
    expect(_stored).toBe("Older Steward");
    const intake = {
      ...sentBack.intake,
      answers: { ...answers, ...steward },
      datasets: sentBack.intake.datasets.map((dataset) => ({
        ...dataset,
        owners: dataset.owners.map(({ id, self, name, email }) =>
          self ? { id, self, name: "", email: "" } : { id, name, email },
        ),
      })),
    };
    await ok(PROVIDER, "resubmit", sentBack.version, {
      requestId: created.id,
      resubmission: { answer: "Restated.", intake },
    });

    expect(storedAnswers()[0]?.["steward"]).toBe("Older Steward");
    expect((await readRequest(created.id)).intake.answers["steward"]).toBe("Older Steward");
  });
});
