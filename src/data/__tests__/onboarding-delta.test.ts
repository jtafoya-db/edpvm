import { describe, expect, it } from "vitest";

import { createDeltaStore, type CommandBody, type DeltaApiTransport } from "../adapters/delta";
import type { OnboardingIntake, OnboardingRequest } from "../onboarding";
import { FEATURES } from "../../features/registry";

const INTAKE: OnboardingIntake = {
  initiativeName: "Collections case signals",
  businessCase: "Prioritize balance-due cases.",
  annualBenefit: 1_250_000,
  levers: ["taxgap"],
  datasets: [
    {
      name: "Case signals",
      domain: "individual-filing",
      datasetTag: "case_signals",
      owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
    },
  ],
  workspaceNeeds: { isolation: "Not sure", teamSize: 6 },
  answers: {},
};

const REQUEST: OnboardingRequest = {
  id: "ONB-1001",
  version: 2,
  title: "Collections case signals",
  providerId: "scim-provider",
  providerName: "Pat Provider",
  submittedAt: "2026-09-28T09:00:00.000Z",
  stage: "business-roi-review",
  stageEnteredAt: "2026-09-28T09:00:00.000Z",
  intake: INTAKE,
  openSendBack: null,
  decisions: [],
  sla: null,
  initiativeOwner: null,
  ownerVerification: {},
  ownerMatches: [],
};

function transport(): DeltaApiTransport & {
  reads: Array<[string, string, Record<string, string> | undefined]>;
  commands: Array<[string, string, CommandBody<unknown>]>;
  legacyWrites: unknown[];
} {
  const reads: Array<[string, string, Record<string, string> | undefined]> = [];
  const commands: Array<[string, string, CommandBody<unknown>]> = [];
  const legacyWrites: unknown[] = [];
  return {
    reads,
    commands,
    legacyWrites,
    async read<T>(area: string, name: string, query?: Record<string, string>): Promise<T> {
      reads.push([area, name, query]);
      if (name === "request") return REQUEST as T;
      if (name === "mine" || name === "inbox") return [REQUEST] as T;
      return null as T;
    },
    async command<T>(area: string, name: string, body: CommandBody<unknown>): Promise<T> {
      commands.push([area, name, body]);
      return {
        actionId: `action-${name}`,
        recordId: REQUEST.id,
        recordVersion: body.expectedVersion + 1,
        replayed: false,
        attempts: 1,
        result: { ...REQUEST, version: body.expectedVersion + 1 },
      } as T;
    },
    async legacyWrite<T>(area: string, name: string, payload: unknown): Promise<T> {
      legacyWrites.push([area, name, payload]);
      return undefined as T;
    },
  };
}

describe("Delta adapter: onboarding requests use Delta commands and reads", () => {
  it("submits and reads onboarding requests through the Delta API", async () => {
    const api = transport();
    const store = createDeltaStore({ transport: api });

    await expect(store.onboarding.submit(INTAKE)).resolves.toMatchObject({
      id: "ONB-1001",
      version: 1,
    });
    await expect(store.onboarding.get("ONB-1001")).resolves.toMatchObject({ id: "ONB-1001" });
    await expect(store.onboarding.listMine()).resolves.toHaveLength(1);
    await expect(store.onboarding.listInbox("business-office")).resolves.toHaveLength(1);

    expect(api.commands).toEqual([
      [
        "onboarding",
        "submit",
        expect.objectContaining({ expectedVersion: 0, payload: { intake: INTAKE } }),
      ],
    ]);
    expect(api.reads).toContainEqual(["onboarding", "request", { id: "ONB-1001" }]);
    expect(api.reads).toContainEqual(["onboarding", "mine", undefined]);
    expect(api.reads).toContainEqual(["onboarding", "inbox", { role: "business-office" }]);
    expect(api.legacyWrites).toEqual([]);
  });

  it("loads the current version before review, resubmit and withdrawal commands", async () => {
    const api = transport();
    const store = createDeltaStore({ transport: api });

    await store.onboarding.decide("ONB-1001", { type: "approve", note: "Strong ROI" });
    await store.onboarding.resubmit("ONB-1001", { answer: "Updated." });
    await store.onboarding.withdraw("ONB-1001", { note: "Duplicate." });

    expect(api.commands.map(([area, name, body]) => [area, name, body.expectedVersion])).toEqual([
      ["onboarding", "decide", 2],
      ["onboarding", "resubmit", 2],
      ["onboarding", "withdraw", 2],
    ]);
  });

  it("declares the Delta-backed capability as live", () => {
    expect(FEATURES["onboarding-request-persistence"]).toMatchObject({ status: "live" });
    expect(FEATURES["onboarding-request-persistence"].notes).toMatch(/Delta/);
  });
});
