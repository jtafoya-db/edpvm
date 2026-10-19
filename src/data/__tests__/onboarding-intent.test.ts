/**
 * One user intent, one idempotency key (#131 UAT). The key comes from the
 * screen, made when the person confirms; both adapters treat a second write
 * under it as the same write. On Delta the key and the version the intent's
 * first attempt was based on go to the server unchanged on every retry, so the
 * server replays a write that already committed instead of making another.
 */
import { describe, expect, it } from "vitest";

import { createDeltaStore, DeltaApiError, type CommandBody } from "../adapters/delta";
import { createMemoryStore } from "../adapters/memory";
import type { OnboardingIntake, OnboardingRequest } from "../onboarding";
import type { UserProfile } from "../types";
import { makeSnapshot } from "./fixture";

const INTAKE: OnboardingIntake = {
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
  initiativeOwner: { kind: "self" },
};

/** A transport that records commands and answers them from a script. */
function recordingTransport(answer: (name: string, call: number) => unknown = () => undefined) {
  const commands: Array<{ name: string; body: CommandBody<unknown> }> = [];
  let version = 2;
  let reads = 0;
  return {
    commands,
    reads: () => reads,
    bumpVersion: () => void (version += 1),
    transport: {
      async read<T>(_area: string, name: string): Promise<T> {
        if (name !== "request") throw new Error(`unexpected read ${name}`);
        reads += 1;
        return { id: "ONB-1001", version } as T;
      },
      async command<T>(_area: string, name: string, body: CommandBody<unknown>): Promise<T> {
        commands.push({ name, body });
        const scripted = answer(name, commands.length - 1);
        if (scripted instanceof Error) throw scripted;
        return { result: { id: "ONB-1001", version: version + 1 } as OnboardingRequest } as T;
      },
      async legacyWrite<T>(): Promise<T> {
        throw new Error("no legacy writes");
      },
    },
  };
}

describe("Delta adapter: the intent key is the idempotency key", () => {
  it("sends the screen's key on submit, and the same key for a retry of that intent", async () => {
    const fake = recordingTransport();
    const store = createDeltaStore({ transport: fake.transport });

    await store.onboarding.submit(INTAKE, { key: "intent-submit" });
    await store.onboarding.submit(INTAKE, { key: "intent-submit" });

    expect(fake.commands.map((c) => c.body.idempotencyKey)).toEqual([
      "intent-submit",
      "intent-submit",
    ]);
  });

  it("retries a decision with the same key and the version its first attempt saw", async () => {
    // The first attempt reaches the server but its response is lost (a 503);
    // meanwhile the record moved on. The retry must hash the same as the first.
    const fake = recordingTransport((_name, call) =>
      call === 0 ? new DeltaApiError(503, "unavailable", "Service unavailable") : undefined,
    );
    const store = createDeltaStore({ transport: fake.transport });
    const intent = { key: "intent-approve" };

    await expect(store.onboarding.decide("ONB-1001", { type: "approve" }, intent)).rejects.toThrow(
      /unavailable/i,
    );
    fake.bumpVersion();
    await store.onboarding.decide("ONB-1001", { type: "approve" }, intent);

    const [first, retry] = fake.commands;
    expect(retry!.body.idempotencyKey).toBe(first!.body.idempotencyKey);
    expect(retry!.body.expectedVersion).toBe(first!.body.expectedVersion);
    expect(retry!.body.payload).toEqual(first!.body.payload);
  });

  it("gives a new decision a new key", async () => {
    const fake = recordingTransport();
    const store = createDeltaStore({ transport: fake.transport });

    await store.onboarding.decide("ONB-1001", { type: "approve" }, { key: "intent-1" });
    await store.onboarding.decide(
      "ONB-1001",
      { type: "reject", note: "Out of scope." },
      { key: "intent-2" },
    );

    expect(fake.commands.map((c) => c.body.idempotencyKey)).toEqual(["intent-1", "intent-2"]);
  });

  it("re-reads the version after a refusal, since nothing under the key committed", async () => {
    const fake = recordingTransport((_name, call) =>
      call === 0 ? new DeltaApiError(409, "version-conflict", "The request changed.") : undefined,
    );
    const store = createDeltaStore({ transport: fake.transport });
    const intent = { key: "intent-withdraw" };

    await expect(store.onboarding.withdraw("ONB-1001", {}, intent)).rejects.toThrow(/changed/);
    fake.bumpVersion();
    await store.onboarding.withdraw("ONB-1001", {}, intent);

    expect(fake.commands.map((c) => c.body.expectedVersion)).toEqual([2, 3]);
    expect(fake.reads()).toBe(2);
  });
});

describe("Delta adapter: a write confirmed against the version on screen", () => {
  it.each(["decide", "resubmit", "withdraw"] as const)(
    "%s sends the screen's version as the expected version, with no read first",
    async (name) => {
      const fake = recordingTransport();
      const store = createDeltaStore({ transport: fake.transport });
      const intent = { key: `intent-${name}`, version: 7 };

      if (name === "decide") await store.onboarding.decide("ONB-1001", { type: "approve" }, intent);
      if (name === "resubmit")
        await store.onboarding.resubmit("ONB-1001", { answer: "Nightly." }, intent);
      if (name === "withdraw") await store.onboarding.withdraw("ONB-1001", {}, intent);

      expect(fake.reads()).toBe(0);
      expect(fake.commands).toEqual([
        {
          name,
          body: expect.objectContaining({ idempotencyKey: `intent-${name}`, expectedVersion: 7 }),
        },
      ]);
    },
  );

  it("retries the same intent with the same key and version, after an unknown outcome", async () => {
    const fake = recordingTransport((_name, call) =>
      call === 0 ? new DeltaApiError(503, "unavailable", "Service unavailable") : undefined,
    );
    const store = createDeltaStore({ transport: fake.transport });
    const intent = { key: "intent-approve", version: 2 };

    await expect(
      store.onboarding.decide("ONB-1001", { type: "approve" }, intent),
    ).rejects.toThrow();
    fake.bumpVersion(); // the first attempt may have committed
    await store.onboarding.decide("ONB-1001", { type: "approve" }, intent);

    expect(fake.reads()).toBe(0);
    expect(fake.commands.map((c) => [c.body.idempotencyKey, c.body.expectedVersion])).toEqual([
      ["intent-approve", 2],
      ["intent-approve", 2],
    ]);
  });

  it("surfaces a version conflict rather than retrying against a fresh read", async () => {
    const fake = recordingTransport(
      () => new DeltaApiError(409, "version-conflict", "This changed since you opened it."),
    );
    const store = createDeltaStore({ transport: fake.transport });

    await expect(
      store.onboarding.decide("ONB-1001", { type: "approve" }, { key: "k", version: 2 }),
    ).rejects.toMatchObject({ status: 409 });

    // The reviewer has to look again: no silent re-read, and one command sent.
    expect(fake.reads()).toBe(0);
    expect(fake.commands).toHaveLength(1);
  });
});

describe("memory adapter: a write under a seen key replays it", () => {
  const user: UserProfile = { ...makeSnapshot().user, principalId: "scim-provider" };

  it("creates one request for two submits of the same intent, and two for two intents", async () => {
    const store = createMemoryStore(makeSnapshot(), { currentUser: async () => user });

    const [first, second] = await Promise.all([
      store.onboarding.submit(INTAKE, { key: "intent-a" }),
      store.onboarding.submit(INTAKE, { key: "intent-a" }),
    ]);
    expect(second.id).toBe(first.id);
    expect(await store.onboarding.listMine()).toHaveLength(1);

    await store.onboarding.submit(INTAKE, { key: "intent-b" });
    expect(await store.onboarding.listMine()).toHaveLength(2);
  });

  it("runs a retry of a refused intent again", async () => {
    const store = createMemoryStore(makeSnapshot(), { currentUser: async () => user });
    const bad = { ...INTAKE, datasets: [] };

    await expect(store.onboarding.submit(bad, { key: "intent-c" })).rejects.toThrow(/dataset/i);
    await expect(store.onboarding.submit(INTAKE, { key: "intent-c" })).resolves.toMatchObject({
      stage: "business-roi-review",
    });
  });
});
