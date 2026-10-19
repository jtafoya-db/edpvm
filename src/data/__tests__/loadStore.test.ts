import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_DATASET_SEED } from "../datasets/seed";
import { loadStore, resetStoreForTests } from "../loadStore";
import type { UserProfile } from "../types";

const PROFILE: UserProfile = {
  principalId: "scim-reviewer",
  name: "Riley Reviewer",
  initials: "RR",
  title: "EDP staff",
  tenant: "EDP",
  email: "riley.reviewer@example.test",
  isOnboardingLead: false,
  isAdmin: true,
  onboardingReviewerRoles: ["business-office", "ccb"],
  slaConfig: {
    stages: {
      "edp-roi-review": 2,
      ccb: 4,
      "eir-validation": 3,
      "access-request-decision": 2,
    },
    dueSoonThresholdBusinessDays: 0,
    holidays: ["2026-10-02"],
    eirValidityDays: 365,
    accessRequestSlaProvisional: false,
  },
};

beforeAll(async () => {
  await import("../../legacy/appData.js");
});

afterEach(() => {
  resetStoreForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const INTAKE = {
  initiativeName: "Collections case signals",
  businessCase: "Prioritize balance-due cases across treatment streams.",
  annualBenefit: 1_250_000,
  levers: ["taxgap"],
  datasets: [
    {
      name: "Case signals",
      domain: "individual-filing",
      datasetTag: "case_signals",
      owners: [{ name: "Olive Owner", email: "olive.owner@example.test" }],
    },
  ],
  workspaceNeeds: { isolation: "shared", teamSize: 6 },
  answers: {},
  initiativeOwner: { kind: "self" as const },
};

function stubBackend(backend: "memory" | "delta") {
  vi.stubEnv("VITE_DATA_BACKEND", backend);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/session") {
      return Response.json(PROFILE);
    }
    if (url === "/api/seed-config") {
      return Response.json({ datasetOwnerIds: ["seed-owner"] });
    }
    // Delta mode reads datasets from the Delta API (#123), not the seed.
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

describe("loadStore browser seam", () => {
  it.each(["memory", "delta"] as const)(
    "passes /api/session SLA config into the %s store stubs",
    async (backend) => {
      stubBackend(backend);

      const store = await loadStore();

      const settings = await store.accessRequests.describeSettings();
      expect(settings.sla).toMatchObject({
        targetBusinessDays: 2,
        dueSoonBusinessDays: 0,
        provisional: false,
      });

      const access = await store.accessRequests.submit({
        datasetId: "ds-refund-anomaly-scores",
        role: "tester",
        reason: "Validate configured SLA from the browser-loaded store.",
      });
      expect(access.sla).toMatchObject({
        targetBusinessDays: 2,
        dueAt: "2026-10-06T12:00:00.000Z",
      });
    },
  );

  it("passes /api/session SLA config into the memory onboarding store", async () => {
    stubBackend("memory");

    const store = await loadStore();

    const onboarding = await store.onboarding.submit(INTAKE);
    const ccb = await store.onboarding.decide(onboarding.id, { type: "approve" });

    expect(ccb.sla).toMatchObject({
      stage: "ccb",
      target: 4,
      dueAt: "2026-10-08T12:00:00.000Z",
    });
  });

  it("sends Delta onboarding to the server, which applies its own SLA config (#131)", async () => {
    // No browser-side stub on Delta: the server's onboarding area computes and
    // persists the SLA from the deploy-time config (onboarding-area.test.ts).
    const fetch = stubBackend("delta");

    const store = await loadStore();
    await store.onboarding.submit(INTAKE).catch(() => undefined);

    expect(fetch.mock.calls.map(([input]) => String(input))).toContain(
      "/api/commands/onboarding/submit",
    );
  });
});
