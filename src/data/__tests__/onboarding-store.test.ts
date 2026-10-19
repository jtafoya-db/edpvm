/**
 * The onboarding request lifecycle as a contract both DataStore adapters must
 * satisfy (#125). Every behaviour is a sequence of store calls followed by
 * assertions on what a data provider or reviewer would see: inbox contents, the
 * request's stage, SLA state and its decision record.
 *
 * The same cases run against the in-memory adapter (#86) and the Delta adapter
 * (#125), the latter over a faithful fake of the server's onboarding API that,
 * like the real server, takes the acting identity from its own session rather
 * than from the caller. If the two adapters ever diverge on an observable, one
 * of these cases fails for exactly one adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryStore } from "../adapters/memory";
import { createDeltaStore, type CommandBody, type DeltaApiTransport } from "../adapters/delta";
import { createMemoryOnboardingStore } from "../onboarding/store";
import type { DataStore } from "../store";
import type {
  OnboardingActor,
  OnboardingIntake,
  OnboardingRequest,
  OnboardingReviewerRole,
} from "../onboarding";
import { DEFAULT_EFFECTIVE_SLA_CONFIG, type EffectiveSlaConfig } from "../sla-config";
import type { UserProfile } from "../types";
import { BAD_TAGS, GOOD_TAGS } from "../../schema/dataset-tag.fixtures";
import { makeNewRequest, makeSnapshot } from "./fixture";
import { COMPLETE_INTAKE_ANSWERS } from "../onboarding/intake.fixtures";

const provider: OnboardingActor = {
  principalId: "scim-provider-1",
  name: "Pat Provider",
  reviewerRoles: [],
};
const otherPerson: OnboardingActor = {
  principalId: "scim-someone-else",
  name: "Sam Else",
  reviewerRoles: [],
};
const businessOffice: OnboardingActor = {
  principalId: "scim-bo-1",
  name: "Bea Office",
  reviewerRoles: ["business-office"],
};
const ccb: OnboardingActor = {
  principalId: "scim-ccb-1",
  name: "Cal Board",
  reviewerRoles: ["ccb"],
};

function intake(overrides: Partial<OnboardingIntake> = {}): OnboardingIntake {
  return {
    initiativeName: "Collections case signals",
    businessCase: "Prioritize balance-due cases across treatment streams.",
    annualBenefit: 1_250_000,
    levers: ["taxgap"],
    datasets: [
      {
        name: "Case signals (curated)",
        domain: "individual-filing",
        datasetTag: "case_signals",
        owners: [{ name: "Olive Owner", email: "olive.owner@example.test" }],
      },
    ],
    workspaceNeeds: { isolation: "shared", teamSize: 6 },
    answers: { ...COMPLETE_INTAKE_ANSWERS },
    initiativeOwner: { kind: "self" },
    ...overrides,
  };
}

/** The stored intake with `change` applied, as the wizard sends it back on resubmit (#222). */
function edited(
  request: Pick<OnboardingRequest, "intake">,
  change: Partial<OnboardingIntake> = {},
): OnboardingIntake {
  return { ...structuredClone(request.intake), ...change };
}

// Monday 2026-09-28 09:00 UTC — all SLA arithmetic below counts business days from here.
const SUBMITTED_AT = new Date("2026-09-28T09:00:00.000Z");

/** The signed-in user, built from an actor, as the server resolves it from the session. */
function profileFor(actor: OnboardingActor): UserProfile {
  return {
    ...makeSnapshot().user,
    principalId: actor.principalId,
    name: actor.name,
    // As SCIM `/Me` gives it: not lower-cased.
    email: `${actor.name.replace(" ", ".")}@example.test`,
    onboardingReviewerRoles: [...actor.reviewerRoles],
  };
}

/** One adapter under test: a DataStore plus a way to sign in, as a browser session would. */
interface OnboardingAdapter {
  store: DataStore;
  signIn: (actor: OnboardingActor) => void;
}

function memoryAdapter(slaConfig?: EffectiveSlaConfig): OnboardingAdapter {
  let signedIn: UserProfile = profileFor(provider);
  const store = createMemoryStore(makeSnapshot(), {
    currentUser: async () => signedIn,
    ...(slaConfig ? { slaConfig } : {}),
  });
  return { store, signIn: (actor) => void (signedIn = profileFor(actor)) };
}

/**
 * A faithful fake of the server's onboarding API: it holds requests in memory
 * through the same lifecycle the real server runs, and takes the acting
 * identity from its session (`currentUser`), never from the caller. This is
 * what exercises the Delta adapter's command/read orchestration — version
 * pre-reads, command dispatch, result handling and error propagation.
 */
function fakeOnboardingServer(
  currentUser: () => Promise<UserProfile>,
  slaConfig?: EffectiveSlaConfig,
): DeltaApiTransport {
  const engine = createMemoryOnboardingStore({ currentUser, ...(slaConfig ? { slaConfig } : {}) });
  const dispatch = (name: string, payload: Record<string, unknown>) => {
    switch (name) {
      case "submit":
        return engine.submit(payload["intake"] as OnboardingIntake);
      case "decide":
        return engine.decide(payload["requestId"] as string, payload["decision"] as never);
      case "resubmit":
        return engine.resubmit(payload["requestId"] as string, payload["resubmission"] as never);
      case "withdraw":
        return engine.withdraw(payload["requestId"] as string, {
          note: payload["note"] as string | undefined,
        });
      default:
        throw new Error(`unexpected onboarding command ${name}`);
    }
  };
  return {
    async read<T>(area: string, name: string, query?: Record<string, string>): Promise<T> {
      if (area !== "onboarding") throw new Error(`unexpected read ${area}/${name}`);
      if (name === "request") return ((await engine.get(query!["id"]!)) ?? null) as T;
      if (name === "mine") return (await engine.listMine()) as T;
      if (name === "inbox")
        return (await engine.listInbox(query!["role"] as OnboardingReviewerRole)) as T;
      throw new Error(`unexpected read onboarding/${name}`);
    },
    async command<T>(area: string, name: string, body: CommandBody<unknown>): Promise<T> {
      if (area !== "onboarding") throw new Error(`unexpected command ${area}/${name}`);
      const result = (await dispatch(
        name,
        body.payload as Record<string, unknown>,
      )) as OnboardingRequest;
      return {
        actionId: `fake-${name}`,
        recordId: result.id,
        recordVersion: result.version,
        replayed: false,
        attempts: 1,
        result,
      } as T;
    },
    async legacyWrite<T>(area: string, name: string): Promise<T> {
      throw new Error(`onboarding has no legacy writes (${area}/${name})`);
    },
  };
}

function deltaAdapter(slaConfig?: EffectiveSlaConfig): OnboardingAdapter {
  let signedIn: UserProfile = profileFor(provider);
  const transport = fakeOnboardingServer(async () => signedIn, slaConfig);
  const store = createDeltaStore({ transport });
  return { store, signIn: (actor) => void (signedIn = profileFor(actor)) };
}

const ADAPTERS: ReadonlyArray<{
  label: string;
  make: (slaConfig?: EffectiveSlaConfig) => OnboardingAdapter;
}> = [
  { label: "memory", make: memoryAdapter },
  { label: "delta", make: deltaAdapter },
];

describe.each(ADAPTERS)("onboarding request contract ($label adapter)", ({ make }) => {
  let store: DataStore;
  let signIn: (actor: OnboardingActor) => void;

  /** Sign in as `actor` (the store reads the session, never a caller-passed actor) and return the repository. */
  function as(actor: OnboardingActor) {
    signIn(actor);
    return store.onboarding;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SUBMITTED_AT);
    ({ store, signIn } = make());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("onboarding request — submit", () => {
    it("creates the request and forwards it to the business & ROI review", async () => {
      const created = await as(provider).submit(intake());

      expect(created.id).toMatch(/^ONB-/);
      expect(created.stage).toBe("business-roi-review");
      expect(created.providerId).toBe("scim-provider-1");
      expect(created.submittedAt).toBe(SUBMITTED_AT.toISOString());
      expect(created.intake.datasets[0]?.owners[0]?.email).toBe("olive.owner@example.test");
      expect(created.decisions.map((d) => [d.kind, d.from, d.to, d.actorId, d.at])).toEqual([
        ["submit", null, "submitted", "scim-provider-1", SUBMITTED_AT.toISOString()],
        ["forward", "submitted", "business-roi-review", "system", SUBMITTED_AT.toISOString()],
      ]);

      expect((await store.onboarding.get(created.id))?.stage).toBe("business-roi-review");
    });

    it("computes onboarding review SLA from deploy config and holidays", async () => {
      ({ store, signIn } = make({
        stages: {
          "edp-roi-review": 2,
          ccb: 5,
          "eir-validation": 3,
          "access-request-decision": 3,
        },
        dueSoonThresholdBusinessDays: 0,
        holidays: ["2026-09-29"],
        eirValidityDays: 365,
        accessRequestSlaProvisional: true,
      }));

      const created = await as(provider).submit(intake());

      expect(created.sla).toMatchObject({
        stage: "business-roi-review",
        target: 2,
        dueAt: "2026-10-01T09:00:00.000Z",
        state: "on-track",
      });
    });

    it.each(BAD_TAGS)(
      "refuses a dataset tag with %s, with a refusal code",
      async (_l, tag, message) => {
        const attempt = as(provider).submit(
          intake({ datasets: [{ ...intake().datasets[0]!, datasetTag: tag }] }),
        );
        await expect(attempt).rejects.toMatchObject({ code: "invalid-dataset-tag" });
        await expect(attempt).rejects.toThrow(message);
        expect(await as(provider).listMine()).toEqual([]);
      },
    );

    it("refuses two datasets with the same tag in one request", async () => {
      const dataset = intake().datasets[0]!;
      await expect(
        as(provider).submit(intake({ datasets: [dataset, { ...dataset, name: "Other" }] })),
      ).rejects.toMatchObject({ code: "duplicate-dataset-tag" });
      expect(await as(provider).listMine()).toEqual([]);
    });

    it.each(GOOD_TAGS)("accepts the dataset tag %s", async (tag) => {
      const created = await as(provider).submit(
        intake({ datasets: [{ ...intake().datasets[0]!, datasetTag: tag }] }),
      );
      expect(created.intake.datasets[0]?.datasetTag).toBe(tag);
    });

    it("refuses an intake without a dataset", async () => {
      await expect(as(provider).submit(intake({ datasets: [] }))).rejects.toThrow(
        /at least one dataset/i,
      );
      expect(await as(provider).listMine()).toEqual([]);
    });

    it.each([
      ["initiative name", { initiativeName: " " }, /initiative name is required/i],
      [
        "business case",
        { businessCase: "too short" },
        /business justification needs more than 10/i,
      ],
      ["annual benefit", { annualBenefit: 0 }, /estimated annual benefit.*must be more than 0/i],
      ["ROI lever", { levers: [] }, /mission value levers: select at least 1/i],
      [
        "isolation answer",
        { workspaceNeeds: { isolation: "", teamSize: 6 } },
        /answer whether this work needs to be isolated/i,
      ],
      [
        "positive team size",
        { workspaceNeeds: { isolation: "shared", teamSize: 0 } },
        /enter how many people will work/i,
      ],
    ] satisfies Array<[string, Partial<OnboardingIntake>, RegExp]>)(
      "refuses an intake missing its %s",
      async (_label, overrides, message) => {
        await expect(as(provider).submit(intake(overrides))).rejects.toThrow(message);
        expect(await as(provider).listMine()).toEqual([]);
      },
    );

    it("refuses a dataset missing its domain, dataset tag or owner", async () => {
      const incomplete = intake({
        datasets: [{ name: "Case signals", domain: "", datasetTag: " ", owners: [] }],
      });
      const attempt = as(provider).submit(incomplete);
      await expect(attempt).rejects.toThrow(/domain/i);
      await expect(as(provider).submit(incomplete)).rejects.toThrow(/dataset tag/i);
      await expect(as(provider).submit(incomplete)).rejects.toThrow(/owner/i);
    });

    it("accepts 'other' as a dataset domain", async () => {
      const created = await as(provider).submit(
        intake({
          datasets: [
            {
              name: "Misc",
              domain: "other",
              datasetTag: "misc",
              owners: [{ name: "Olive", email: "olive@example.test" }],
            },
          ],
        }),
      );
      expect(created.intake.datasets[0]?.domain).toBe("other");
    });
  });

  describe("role-scoped inboxes", () => {
    it("hides a single request from other providers and the wrong-stage reviewer", async () => {
      const created = await as(provider).submit(intake());

      await expect(as(otherPerson).get(created.id)).resolves.toBeUndefined();
      await expect(as(ccb).get(created.id)).resolves.toBeUndefined();
      await expect(as(businessOffice).get(created.id)).resolves.toMatchObject({ id: created.id });
      await expect(as(provider).get(created.id)).resolves.toMatchObject({ id: created.id });

      await as(businessOffice).decide(created.id, { type: "approve" });
      await expect(as(businessOffice).get(created.id)).resolves.toBeUndefined();
      await expect(as(ccb).get(created.id)).resolves.toMatchObject({
        id: created.id,
        stage: "ccb",
      });
    });

    it("shows the business office only requests at business & ROI review, with SLA state", async () => {
      const first = await as(provider).submit(intake());
      const second = await as(provider).submit(intake({ initiativeName: "Second" }));
      await as(businessOffice).decide(second.id, { type: "approve" });

      const boInbox = await as(businessOffice).listInbox("business-office");
      expect(boInbox.map((r) => r.id)).toEqual([first.id]);
      expect(boInbox[0]?.sla).toMatchObject({
        stage: "business-roi-review",
        target: 5,
        state: "on-track",
      });

      const ccbInbox = await as(ccb).listInbox("ccb");
      expect(ccbInbox.map((r) => r.id)).toEqual([second.id]);
      expect(ccbInbox[0]?.sla).toMatchObject({ stage: "ccb", target: 5, state: "on-track" });
    });

    it("refuses an inbox to anyone outside the configured group", async () => {
      await expect(as(businessOffice).listInbox("ccb")).rejects.toThrow(
        /not a member of the configured CCB group/i,
      );
      await expect(as(provider).listInbox("business-office")).rejects.toThrow(
        /business office group/i,
      );
    });

    it("reports due-soon and breached SLA states as business days pass", async () => {
      const created = await as(provider).submit(intake());

      vi.setSystemTime(new Date("2026-10-02T09:00:00.000Z")); // Fri: 4 of 5 business days elapsed
      expect((await as(businessOffice).listInbox("business-office"))[0]?.sla?.state).toBe(
        "due-soon",
      );

      vi.setSystemTime(new Date("2026-10-06T09:00:00.000Z")); // following Tue: past the 5-day target
      const breached = await store.onboarding.get(created.id);
      expect(breached?.sla?.state).toBe("breached");
      expect(breached?.sla?.escalationAppropriate).toBe(true);
    });

    it("restarts the SLA clock when a request enters the next stage", async () => {
      const created = await as(provider).submit(intake());
      vi.setSystemTime(new Date("2026-10-06T09:00:00.000Z"));
      await as(businessOffice).decide(created.id, { type: "approve" });

      const atCcb = await as(ccb).get(created.id);
      expect(atCcb?.stageEnteredAt).toBe("2026-10-06T09:00:00.000Z");
      expect(atCcb?.sla).toMatchObject({ stage: "ccb", state: "on-track", businessDaysElapsed: 0 });
    });
  });

  describe("review decisions", () => {
    it("moves business office approval to the CCB and CCB approval to standup, recording actor and time", async () => {
      const created = await as(provider).submit(intake());

      vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
      await as(businessOffice).decide(created.id, { type: "approve", note: "Strong ROI" });
      vi.setSystemTime(new Date("2026-09-30T11:00:00.000Z"));
      const approved = await as(ccb).decide(created.id, { type: "approve" });

      expect(approved.stage).toBe("standup");
      expect(approved.sla).toBeNull(); // standup has no SLA until its automation is real
      expect(approved.decisions.slice(-2)).toEqual([
        {
          kind: "approve",
          from: "business-roi-review",
          to: "ccb",
          actorId: "scim-bo-1",
          actorName: "Bea Office",
          at: "2026-09-29T10:00:00.000Z",
          note: "Strong ROI",
        },
        {
          kind: "approve",
          from: "ccb",
          to: "standup",
          actorId: "scim-ccb-1",
          actorName: "Cal Board",
          at: "2026-09-30T11:00:00.000Z",
          note: "",
        },
      ]);
      expect(await as(ccb).listInbox("ccb")).toEqual([]);
      expect(await as(businessOffice).listInbox("business-office")).toEqual([]);
    });

    it("refuses a decision from a reviewer whose stage it is not", async () => {
      const created = await as(provider).submit(intake());
      await expect(as(ccb).decide(created.id, { type: "approve" })).rejects.toThrow(
        "Onboarding request not found.",
      );
      await expect(
        as(provider).decide(created.id, { type: "reject", note: "No ROI" }),
      ).rejects.toThrow("Onboarding request not found.");
      expect((await as(provider).get(created.id))?.stage).toBe("business-roi-review");
    });

    it("refuses any decision once a request is at standup", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      await as(ccb).decide(created.id, { type: "approve" });
      await expect(
        as({ ...ccb, reviewerRoles: ["ccb", "business-office"] }).decide(created.id, {
          type: "approve",
        }),
      ).rejects.toThrow("Onboarding request not found.");
    });

    it("refuses an unknown request id clearly", async () => {
      await expect(as(ccb).decide("ONB-NOPE", { type: "approve" })).rejects.toThrow(
        "Onboarding request not found.",
      );
    });
  });

  describe("send-back and resubmit", () => {
    it("lets the CCB send a request back to the provider, who answers and resubmits", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      const sentBack = await as(ccb).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Which workspaces need isolation?",
      });

      expect(sentBack.stage).toBe("submitted");
      expect(sentBack.openSendBack).toMatchObject({
        from: "ccb",
        questions: "Which workspaces need isolation?",
        actorId: "scim-ccb-1",
      });
      expect(sentBack.sla).toBeNull(); // waiting on the provider, not a reviewer
      expect(await as(ccb).listInbox("ccb")).toEqual([]);

      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Only the prod analytics workspace.",
        intake: edited(created, { workspaceNeeds: { isolation: "dedicated", teamSize: 6 } }),
      });
      // The CCB sent it back, so the resubmission returns to the CCB (#221).
      expect(resubmitted.stage).toBe("ccb");
      expect(resubmitted.openSendBack).toBeNull();
      expect(resubmitted.intake.workspaceNeeds.isolation).toBe("dedicated");
      expect(resubmitted.decisions.at(-1)).toMatchObject({
        kind: "resubmit",
        from: "submitted",
        to: "ccb",
        actorId: "scim-provider-1",
        note: "Only the prod analytics workspace.",
      });
      expect((await as(ccb).listInbox("ccb")).map((r) => r.id)).toEqual([created.id]);
      expect(await as(businessOffice).listInbox("business-office")).toEqual([]);
    });

    it("returns a CCB send-back to the CCB with a fresh SLA due date from the resubmission", async () => {
      // CCB three business days, business & ROI review seven: the due date shows whose target ran.
      ({ store, signIn } = make({
        ...DEFAULT_EFFECTIVE_SLA_CONFIG,
        stages: { ...DEFAULT_EFFECTIVE_SLA_CONFIG.stages, "edp-roi-review": 7, ccb: 3 },
      }));
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      vi.setSystemTime(new Date("2026-09-30T09:00:00.000Z"));
      await as(ccb).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Which streams?",
      });

      // Monday 2026-10-05: resubmitted after the original CCB clock would have run.
      vi.setSystemTime(new Date("2026-10-05T09:00:00.000Z"));
      const resubmitted = await as(provider).resubmit(created.id, { answer: "Two streams." });

      expect(resubmitted.stage).toBe("ccb");
      expect(resubmitted.stageEnteredAt).toBe("2026-10-05T09:00:00.000Z");
      // The CCB's three business days, counted from the resubmission: Thursday 2026-10-08.
      expect(resubmitted.sla).toMatchObject({
        stage: "ccb",
        state: "on-track",
        target: 3,
        businessDaysElapsed: 0,
        dueAt: "2026-10-08T09:00:00.000Z",
      });
      const atCcb = await as(ccb).get(created.id);
      expect(atCcb?.sla).toMatchObject({ stage: "ccb", dueAt: "2026-10-08T09:00:00.000Z" });
    });

    it("leaves other requests' SLA due dates alone when one resubmits", async () => {
      const waiting = await as(provider).submit(intake({ initiativeName: "Waiting" }));
      const sentBack = await as(provider).submit(intake({ initiativeName: "Sent back" }));
      const dueBefore = (await as(businessOffice).get(waiting.id))?.sla?.dueAt;
      await as(businessOffice).decide(sentBack.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify.",
      });
      vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
      await as(provider).resubmit(sentBack.id, { answer: "Clarified." });

      expect((await as(businessOffice).get(waiting.id))?.sla?.dueAt).toBe(dueBefore);
      expect(dueBefore).toBe("2026-10-05T09:00:00.000Z");
    });

    it("takes the return stage from the stored send-back, never from the resubmission body", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      await as(ccb).decide(created.id, { type: "send-back", to: "submitted", note: "Why?" });

      const resubmit = as(provider).resubmit as unknown as (...args: unknown[]) => Promise<unknown>;
      const attempt = resubmit(created.id, { answer: "Because.", to: "business-roi-review" });
      // The memory adapter ignores the extra field; the server's strict payload refuses it.
      // Either way the request never lands in business & ROI review.
      await attempt.catch(() => undefined);
      const after = await as(provider).get(created.id);
      expect(after?.stage).not.toBe("business-roi-review");
      expect(await as(businessOffice).listInbox("business-office")).toEqual([]);
    });

    it("shows the reviewer it returns to the answer and what changed since the send-back", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      await as(ccb).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Use the governed tag and say how isolated the work is.",
      });
      await as(provider).resubmit(created.id, {
        answer: "Retagged and isolated.",
        intake: edited(created, {
          datasets: [{ ...created.intake.datasets[0]!, datasetTag: "case_signals_gold" }],
          workspaceNeeds: { isolation: "dedicated", teamSize: 6 },
        }),
      });

      const [inInbox] = await as(ccb).listInbox("ccb");
      expect(inInbox?.decisions.at(-1)).toMatchObject({
        kind: "resubmit",
        to: "ccb",
        resubmission: {
          answer: "Retagged and isolated.",
          changes: [
            { field: "Dataset 1 dataset tag", before: "case_signals", after: "case_signals_gold" },
            { field: "Workspace isolation", before: "shared", after: "dedicated" },
          ],
        },
      });
      // The #215 tag-change note stays on the decision record.
      expect(inInbox?.decisions.at(-1)?.note).toBe(
        "Retagged and isolated. Dataset tag changed: case_signals -> case_signals_gold.",
      );
    });

    it("records no changes when the provider only answers", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify.",
      });
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Clarified.",
        intake: edited(created),
      });
      expect(resubmitted.decisions.at(-1)?.resubmission).toEqual({
        answer: "Clarified.",
        changes: [],
      });
    });

    it("lets the CCB decide again after a resubmission returns to it", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      await as(ccb).decide(created.id, { type: "send-back", to: "submitted", note: "Why?" });
      await as(provider).resubmit(created.id, { answer: "Because." });

      const approved = await as(ccb).decide(created.id, { type: "approve" });
      expect(approved.stage).toBe("standup");
      expect(approved.decisions.map((d) => d.kind)).toEqual([
        "submit",
        "forward",
        "approve",
        "send-back",
        "resubmit",
        "approve",
      ]);
    });

    it("refuses a CCB send-back to business & ROI review", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      const decide = as(ccb).decide as unknown as (...args: unknown[]) => Promise<unknown>;
      await expect(
        decide(created.id, {
          type: "send-back",
          to: "business-roi-review",
          note: "Recheck the ROI",
        }),
      ).rejects.toThrow(/must target the data provider at 'submitted'/i);
      expect((await as(ccb).get(created.id))?.stage).toBe("ccb");
    });

    it("refuses every send-back target other than the data provider", async () => {
      const created = await as(provider).submit(intake());
      const decide = as(businessOffice).decide as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      await expect(
        decide(created.id, {
          type: "send-back",
          to: "business-roi-review",
          note: "?",
        }),
      ).rejects.toThrow(/must target the data provider at 'submitted'/i);
      await expect(decide(created.id, { type: "send-back", to: "ccb", note: "?" })).rejects.toThrow(
        /must target the data provider at 'submitted'/i,
      );
    });

    it("returns a business-office send-back to the provider, then resubmits for business review", async () => {
      const created = await as(provider).submit(intake());
      const sentBack = await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify the benefit.",
      });
      expect(sentBack.stage).toBe("submitted");
      const resubmitted = await as(provider).resubmit(created.id, { answer: "Benefit clarified." });
      expect(resubmitted.stage).toBe("business-roi-review");
      expect(resubmitted.decisions.at(-1)).toMatchObject({
        kind: "resubmit",
        to: "business-roi-review",
      });
      expect((await as(businessOffice).listInbox("business-office")).map((r) => r.id)).toEqual([
        created.id,
      ]);
      expect(await as(ccb).listInbox("ccb")).toEqual([]);
    });

    it("requires questions on a send-back", async () => {
      const created = await as(provider).submit(intake());
      await expect(
        as(businessOffice).decide(created.id, { type: "send-back", to: "submitted", note: "  " }),
      ).rejects.toThrow(/send-back needs questions/i);
    });

    it("refuses a resubmit unless the request is waiting on the provider", async () => {
      const created = await as(provider).submit(intake());
      await expect(as(provider).resubmit(created.id, { answer: "x" })).rejects.toThrow(
        /only a request sent back to the data provider can be resubmitted/i,
      );
    });

    it("refuses a resubmit or withdrawal by anyone but the data provider", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "More detail",
      });
      await expect(as(otherPerson).resubmit(created.id, { answer: "x" })).rejects.toThrow(
        "Onboarding request not found.",
      );
      await expect(as(businessOffice).withdraw(created.id, {})).rejects.toThrow(
        "Onboarding request not found.",
      );
    });

    it("refuses a blank answer without changing a request waiting on the provider", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify the workspace.",
      });

      await expect(as(provider).resubmit(created.id, { answer: "   " })).rejects.toThrow(
        /resubmission needs an answer/i,
      );
      await expect(as(provider).get(created.id)).resolves.toMatchObject({
        stage: "submitted",
        openSendBack: { questions: "Clarify the workspace." },
      });
    });

    it("validates merged workspace answers before changing the stored intake or stage", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify the workspace.",
      });

      await expect(
        as(provider).resubmit(created.id, {
          answer: "Updated.",
          intake: edited(created, { workspaceNeeds: { isolation: "", teamSize: 0 } }),
        }),
      ).rejects.toThrow(/work needs to be isolated/i);
      await expect(as(provider).get(created.id)).resolves.toMatchObject({
        stage: "submitted",
        intake: { workspaceNeeds: { isolation: "shared", teamSize: 6 } },
      });
    });

    it("lets a provider correct dataset fields on resubmit and records tag changes", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Use the governed dataset tag.",
      });

      const [dataset] = created.intake.datasets;
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Updated the dataset metadata.",
        intake: edited(created, {
          datasets: [
            {
              ...dataset!,
              name: "Case signals gold",
              domain: "other",
              datasetTag: "case_signals_gold",
            },
          ],
        }),
      });

      expect(resubmitted.intake.datasets).toEqual([
        {
          id: dataset!.id,
          name: "Case signals gold",
          domain: "other",
          datasetTag: "case_signals_gold",
          owners: [
            { id: dataset!.owners[0]!.id, name: "Olive Owner", email: "olive.owner@example.test" },
          ],
        },
      ]);
      expect(resubmitted.decisions.at(-1)).toMatchObject({
        kind: "resubmit",
        note: "Updated the dataset metadata. Dataset tag changed: case_signals -> case_signals_gold.",
      });
    });

    it("refuses invalid resubmit dataset tags before changing the stored intake or stage", async () => {
      const created = await as(provider).submit(
        intake({
          datasets: [
            {
              name: "Case signals",
              domain: "individual-filing",
              datasetTag: "case_signals",
              owners: [{ name: "Olive Owner", email: "olive.owner@example.test" }],
            },
            {
              name: "Case indicators",
              domain: "individual-filing",
              datasetTag: "case_indicators",
              owners: [{ name: "Oscar Owner", email: "oscar.owner@example.test" }],
            },
          ],
        }),
      );
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Fix the dataset tags.",
      });

      await expect(
        as(provider).resubmit(created.id, {
          answer: "Fixed.",
          intake: edited(created, {
            datasets: [
              { ...created.intake.datasets[0]!, datasetTag: "case_signals" },
              { ...created.intake.datasets[1]!, datasetTag: "case_signals" },
            ],
          }),
        }),
      ).rejects.toMatchObject({ code: "duplicate-dataset-tag" });
      await expect(as(provider).get(created.id)).resolves.toMatchObject({
        stage: "submitted",
        intake: { datasets: created.intake.datasets },
      });
    });
  });

  describe("resubmit edits the whole intake (#222)", () => {
    /** A request with two datasets, the first with two owners, sent back by the CCB. */
    async function sentBackWithTwoDatasets() {
      const created = await as(provider).submit(
        intake({
          datasets: [
            {
              name: "Case signals",
              domain: "individual-filing",
              datasetTag: "case_signals",
              owners: [
                { name: "Olive Owner", email: "olive.owner@example.test" },
                { name: "Otto Second", email: "otto.second@example.test" },
              ],
            },
            {
              name: "Case indicators",
              domain: "individual-filing",
              datasetTag: "case_indicators",
              owners: [{ name: "Oscar Owner", email: "oscar.owner@example.test" }],
            },
          ],
        }),
      );
      await as(businessOffice).decide(created.id, { type: "approve" });
      await as(ccb).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Restate the ROI and fix the datasets.",
      });
      return (await as(provider).get(created.id))!;
    }

    it("gives every stored dataset and owner contact its own record ID", async () => {
      const created = await sentBackWithTwoDatasets();
      const ids = created.intake.datasets.flatMap((d) => [d.id, ...d.owners.map((o) => o.id)]);
      expect(ids).toHaveLength(5);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(5);
    });

    it("edits any intake answer, adds and removes datasets and owners, and keeps the request's ID", async () => {
      const created = await sentBackWithTwoDatasets();
      const [first] = created.intake.datasets;
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Restated the ROI; dropped the indicators, added the ledger.",
        intake: edited(created, {
          initiativeName: "Collections case signals v2",
          annualBenefit: 2_000_000,
          answers: { ...created.intake.answers, sourceSystem: "IDRS", priority: "High" },
          datasets: [
            {
              ...first!,
              owners: [first!.owners[0]!, { name: "Nia New", email: "Nia.New@example.test" }],
            },
            {
              name: "Collections ledger",
              domain: "enforcement-collections",
              datasetTag: "collections_ledger",
              owners: [{ name: "Lee Ledger", email: "lee.ledger@example.test" }],
            },
          ],
        }),
      });

      // The ONB code is the request's for good; a resubmission never reissues it.
      expect(resubmitted.id).toBe(created.id);
      expect((await as(ccb).listInbox("ccb")).map((r) => r.id)).toEqual([created.id]);
      expect(resubmitted.title).toBe("Collections case signals v2");
      expect(resubmitted.intake).toMatchObject({
        initiativeName: "Collections case signals v2",
        annualBenefit: 2_000_000,
        answers: { sourceSystem: "IDRS", priority: "High" },
      });
      const [kept, added] = resubmitted.intake.datasets;
      // The kept dataset and owner keep their IDs; new ones get IDs at resubmit.
      expect(kept?.id).toBe(first!.id);
      expect(kept?.owners.map((o) => o.id)).toEqual([first!.owners[0]!.id, expect.any(String)]);
      expect(kept?.owners[1]).toMatchObject({ name: "Nia New", email: "nia.new@example.test" });
      expect(added?.id).toEqual(expect.any(String));
      const knownIds = created.intake.datasets.flatMap((d) => [d.id, ...d.owners.map((o) => o.id)]);
      expect(knownIds).not.toContain(added!.id);
      expect(knownIds).not.toContain(kept!.owners[1]!.id);

      const decision = resubmitted.decisions.at(-1)!;
      expect(decision.resubmission?.changes).toEqual([
        {
          field: "Initiative name",
          before: "Collections case signals",
          after: "Collections case signals v2",
        },
        { field: "Source system", before: "IMF / Individual Master File", after: "IDRS" },
        { field: "Mission priority", before: "Mission-critical", after: "High" },
        { field: "Estimated annual benefit (USD)", before: "$1,250,000", after: "$2,000,000" },
        {
          field: "Dataset 1 owner 2 added",
          before: "",
          after: "Nia New (nia.new@example.test)",
          kind: "added",
        },
        {
          field: "Dataset 1 owner 2 removed",
          before: "Otto Second (otto.second@example.test)",
          after: "",
          kind: "removed",
        },
        {
          field: "Dataset 2 added",
          before: "",
          after: "Collections ledger (collections_ledger); owners: Lee Ledger (lee.ledger@example.test)",
          kind: "added",
        },
        {
          field: "Dataset 2 removed",
          before: "Case indicators (case_indicators); owners: Oscar Owner (oscar.owner@example.test)",
          after: "",
          kind: "removed",
        },
      ]);
      // Removals are in the decision log, not only the change record.
      expect(decision.note).toBe(
        "Restated the ROI; dropped the indicators, added the ledger. Removed owner from Case signals: Otto Second (otto.second@example.test). Removed dataset: Case indicators (case_indicators).",
      );
    });

    it("re-validates the whole intake on resubmit and changes nothing when it fails", async () => {
      const created = await sentBackWithTwoDatasets();
      await expect(
        as(provider).resubmit(created.id, {
          answer: "Cleared the domain and the delivery model.",
          intake: edited(created, {
            answers: { ...created.intake.answers, domain: "", engModel: "" },
          }),
        }),
      ).rejects.toMatchObject({
        code: "invalid-intake",
        message: expect.stringMatching(/Target domain is required.*delivery model is required/i),
      });
      await expect(as(provider).get(created.id)).resolves.toMatchObject({
        stage: "submitted",
        intake: { answers: { domain: "individual-filing", engModel: "self" } },
      });
    });

    it("refuses removing every dataset", async () => {
      const created = await sentBackWithTwoDatasets();
      await expect(
        as(provider).resubmit(created.id, {
          answer: "No datasets.",
          intake: edited(created, { datasets: [] }),
        }),
      ).rejects.toMatchObject({ code: "invalid-intake" });
      expect((await as(provider).get(created.id))?.intake.datasets).toHaveLength(2);
    });

    it("keeps the dataset tag rule and per-request tag uniqueness across added datasets", async () => {
      const created = await sentBackWithTwoDatasets();
      const added = {
        name: "Copy",
        domain: "individual-filing",
        datasetTag: "case_signals",
        owners: [{ name: "Cy Copy", email: "cy.copy@example.test" }],
      };
      await expect(
        as(provider).resubmit(created.id, {
          answer: "Added a copy.",
          intake: edited(created, { datasets: [...created.intake.datasets, added] }),
        }),
      ).rejects.toMatchObject({ code: "duplicate-dataset-tag" });
      await expect(
        as(provider).resubmit(created.id, {
          answer: "Added a copy.",
          intake: edited(created, {
            datasets: [...created.intake.datasets, { ...added, datasetTag: BAD_TAGS[0]![1] }],
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid-dataset-tag" });
    });

    it.each([
      {
        label: "a dataset ID the request doesn't have",
        datasets: (r: OnboardingRequest) => [{ ...r.intake.datasets[0]!, id: "made-up-id" }],
      },
      {
        label: "another request's dataset ID",
        datasets: (r: OnboardingRequest, other: OnboardingRequest) => [
          { ...r.intake.datasets[0]!, id: other.intake.datasets[0]!.id },
        ],
      },
      {
        label: "the same dataset ID twice",
        datasets: (r: OnboardingRequest) => [
          r.intake.datasets[0]!,
          { ...r.intake.datasets[1]!, id: r.intake.datasets[0]!.id },
        ],
      },
      {
        label: "an owner ID from another dataset",
        datasets: (r: OnboardingRequest) => [
          r.intake.datasets[0]!,
          { ...r.intake.datasets[1]!, owners: [r.intake.datasets[0]!.owners[0]!] },
        ],
      },
      {
        label: "an owner ID on a new dataset",
        datasets: (r: OnboardingRequest) => [
          ...r.intake.datasets,
          {
            name: "New",
            domain: "individual-filing",
            datasetTag: "new_one",
            owners: [r.intake.datasets[1]!.owners[0]!],
          },
        ],
      },
    ])("refuses a resubmission naming $label, before any change", async ({ datasets }) => {
      const other = await as(provider).submit(intake({ initiativeName: "Another" }));
      const created = await sentBackWithTwoDatasets();
      await expect(
        as(provider).resubmit(created.id, {
          answer: "Sneaky.",
          intake: edited(created, { datasets: datasets(created, other) }),
        }),
      ).rejects.toMatchObject({ code: "invalid-intake" });
      await expect(as(provider).get(created.id)).resolves.toMatchObject({
        stage: "submitted",
        intake: { datasets: created.intake.datasets },
      });
    });

    it("refuses a new request that names record IDs", async () => {
      await expect(
        as(provider).submit(
          intake({
            datasets: [{ ...intake().datasets[0]!, id: "chosen-by-the-browser" }],
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid-intake" });
    });

    it("takes the actor, stage and version from the server, whatever the body says", async () => {
      const created = await sentBackWithTwoDatasets();
      const resubmit = as(provider).resubmit as unknown as (...args: unknown[]) => Promise<unknown>;
      await resubmit(created.id, {
        answer: "Sneaky.",
        intake: edited(created),
        actorId: "scim-ccb-1",
        stage: "standup",
        version: 99,
      }).catch(() => undefined);
      const after = await as(provider).get(created.id);
      expect(after?.stage).not.toBe("standup");
      if (after?.stage === "ccb") {
        expect(after.decisions.at(-1)).toMatchObject({ actorId: "scim-provider-1" });
        expect(after.version).toBe(created.version + 1);
      }
    });
  });

  describe("write authorization does not reveal request existence or stage", () => {
    const hidden = "Onboarding request not found.";

    it("returns the same error for an existing and missing request", async () => {
      const created = await as(provider).submit(intake());
      await expect(as(otherPerson).decide(created.id, { type: "approve" })).rejects.toThrow(hidden);
      await expect(as(otherPerson).decide("ONB-NOPE", { type: "approve" })).rejects.toThrow(hidden);
      await expect(as(otherPerson).withdraw(created.id)).rejects.toThrow(hidden);
      await expect(as(otherPerson).withdraw("ONB-NOPE")).rejects.toThrow(hidden);
    });

    it("does not reveal rejected or withdrawn stages to a stranger", async () => {
      const rejected = await as(provider).submit(intake({ initiativeName: "Rejected" }));
      await as(businessOffice).decide(rejected.id, { type: "reject", note: "No ROI" });
      const withdrawn = await as(provider).submit(intake({ initiativeName: "Withdrawn" }));
      await as(provider).withdraw(withdrawn.id);

      await expect(as(otherPerson).decide(rejected.id, { type: "approve" })).rejects.toThrow(
        hidden,
      );
      await expect(as(otherPerson).resubmit(rejected.id, { answer: "x" })).rejects.toThrow(hidden);
      await expect(as(otherPerson).withdraw(withdrawn.id)).rejects.toThrow(hidden);
    });
  });

  describe("terminal stages", () => {
    it("makes rejection terminal", async () => {
      const created = await as(provider).submit(intake());
      const rejected = await as(businessOffice).decide(created.id, {
        type: "reject",
        note: "No ROI",
      });
      expect(rejected.stage).toBe("rejected");
      expect(rejected.sla).toBeNull();
      expect(rejected.decisions.at(-1)).toMatchObject({
        kind: "reject",
        actorId: "scim-bo-1",
        note: "No ROI",
      });

      await expect(as(businessOffice).decide(created.id, { type: "approve" })).rejects.toThrow(
        "Onboarding request not found.",
      );
      await expect(as(provider).withdraw(created.id, {})).rejects.toThrow(
        /terminal stage 'rejected'/,
      );
    });

    it("refuses a rejection without a reason, at either review stage", async () => {
      const atBusiness = await as(provider).submit(intake());
      await expect(
        as(businessOffice).decide(atBusiness.id, { type: "reject", note: "   " }),
      ).rejects.toThrow(/rejection needs a reason/i);
      const reject = as(businessOffice).decide as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      await expect(reject(atBusiness.id, { type: "reject" })).rejects.toThrow(
        /rejection needs a reason/i,
      );
      expect((await as(provider).get(atBusiness.id))?.stage).toBe("business-roi-review");

      const atCcb = await as(provider).submit(intake());
      await as(businessOffice).decide(atCcb.id, { type: "approve" });
      await expect(as(ccb).decide(atCcb.id, { type: "reject", note: "" })).rejects.toThrow(
        /rejection needs a reason/i,
      );
      expect((await as(provider).get(atCcb.id))?.stage).toBe("ccb");
    });

    it("makes withdrawal terminal and drops the request from the inbox", async () => {
      const created = await as(provider).submit(intake());
      const withdrawn = await as(provider).withdraw(created.id, { note: "Project cancelled" });

      expect(withdrawn.stage).toBe("withdrawn");
      expect(withdrawn.decisions.at(-1)).toMatchObject({
        kind: "withdraw",
        from: "business-roi-review",
        to: "withdrawn",
        actorId: "scim-provider-1",
      });
      expect(await as(businessOffice).listInbox("business-office")).toEqual([]);
      await expect(as(provider).resubmit(created.id, { answer: "x" })).rejects.toThrow(
        /terminal stage 'withdrawn'/,
      );
    });

    it("refuses to withdraw a request already approved for standup", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, { type: "approve" });
      await as(ccb).decide(created.id, { type: "approve" });
      await expect(as(provider).withdraw(created.id, {})).rejects.toThrow(
        /cannot withdraw from 'standup'/,
      );
    });
  });

  describe("the data provider's view", () => {
    it("lists only the provider's own requests with current stage and SLA state", async () => {
      const mine = await as(provider).submit(intake());
      await as(otherPerson).submit(intake({ initiativeName: "Not mine" }));

      const list = await as(provider).listMine();
      expect(list.map((r) => r.id)).toEqual([mine.id]);
      expect(list[0]).toMatchObject({ stage: "business-roi-review", sla: { state: "on-track" } });
    });

    it("returns copies, so a caller cannot mutate store state", async () => {
      const created = await as(provider).submit(intake());
      created.intake.datasets[0]!.name = "MUTATED";
      expect((await store.onboarding.get(created.id))?.intake.datasets[0]?.name).toBe(
        "Case signals (curated)",
      );
    });
  });

  describe("submit → send-back → resubmit keeps the reserved intake records", () => {
    it("preserves the dataset and owner contacts across a resubmission", async () => {
      const created = await as(provider).submit(intake());
      const datasetsAtSubmit = created.intake.datasets;

      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify the workspace.",
      });
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Clarified.",
        intake: edited(created, { workspaceNeeds: { isolation: "dedicated", teamSize: 9 } }),
      });

      // The request's public identity is stable across the resubmission: it is the
      // same record, never re-created (the Delta path keeps the reserved internal
      // initiative/dataset/owner IDs stable too — asserted in the area test).
      expect(resubmitted.id).toBe(created.id);
      // The intake's datasets and owners are reserved at submit and never re-created;
      // a resubmission only answers the reviewer and may correct the workspace.
      expect(resubmitted.intake.datasets).toEqual(datasetsAtSubmit);
      expect(resubmitted.intake.workspaceNeeds).toEqual({ isolation: "dedicated", teamSize: 9 });
      expect(resubmitted.decisions.map((d) => d.kind)).toEqual([
        "submit",
        "forward",
        "send-back",
        "resubmit",
      ]);
    });
  });

  describe("the initiative owner and dataset owners (#103)", () => {
    const someoneElse = { kind: "someone-else", name: "  Sam Else ", email: " Sam.Else@example.test " };

    it("stores Myself as the signed-in session's identity, verified", async () => {
      const created = await as(provider).submit(intake({ initiativeOwner: { kind: "self" } }));

      expect(created.intake.initiativeOwner).toEqual({ kind: "self" });
      expect(created.initiativeOwner).toEqual({
        kind: "self",
        name: "Pat Provider",
        email: "pat.provider@example.test",
        principalId: "scim-provider-1",
        verification: "verified",
      });
      expect((await as(provider).get(created.id))?.initiativeOwner).toEqual(
        created.initiativeOwner,
      );
    });

    it("never takes the owner's identity from the browser", async () => {
      const smuggled = {
        kind: "self",
        name: "Someone Important",
        email: "boss@example.test",
        principalId: "scim-boss",
      };
      // The memory adapter ignores the extra fields; the server's strict payload refuses them.
      await as(provider)
        .submit(intake({ initiativeOwner: smuggled as never }))
        .catch(() => undefined);
      for (const request of await as(provider).listMine()) {
        expect(request.initiativeOwner).toMatchObject({
          name: "Pat Provider",
          principalId: "scim-provider-1",
        });
      }
    });

    it("stores Someone else by name and normalized email, with no principal and not verified", async () => {
      const created = await as(provider).submit(intake({ initiativeOwner: someoneElse as never }));

      expect(created.intake.initiativeOwner).toEqual({
        kind: "someone-else",
        name: "Sam Else",
        email: "sam.else@example.test",
      });
      expect(created.initiativeOwner).toEqual({
        kind: "someone-else",
        name: "Sam Else",
        email: "sam.else@example.test",
        principalId: null,
        verification: "not-verified",
      });
    });

    it("refuses a request with no initiative owner, or Someone else without a valid email", async () => {
      const { initiativeOwner: _none, ...withoutOwner } = intake();
      await expect(as(provider).submit(withoutOwner)).rejects.toThrow(
        /Choose who owns the initiative/,
      );
      await expect(
        as(provider).submit(
          intake({ initiativeOwner: { kind: "someone-else", name: "Sam Else", email: "sam" } }),
        ),
      ).rejects.toThrow(/valid email address for the initiative owner/);
      expect(await as(provider).listMine()).toEqual([]);
    });

    it("marks a dataset owner picked as Myself as the signed-in user, already verified", async () => {
      const created = await as(provider).submit(
        intake({
          datasets: [
            {
              ...intake().datasets[0]!,
              owners: [
                { self: true, name: "", email: "" },
                { name: "Olive Owner", email: "olive.owner@example.test" },
              ],
            },
          ],
        }),
      );

      const [mine, olive] = created.intake.datasets[0]!.owners;
      expect(mine).toMatchObject({
        self: true,
        name: "Pat Provider",
        email: "pat.provider@example.test",
      });
      expect(olive).not.toHaveProperty("self");
      expect(created.ownerVerification).toEqual({
        [mine!.id!]: "verified",
        [olive!.id!]: "not-verified",
      });
    });

    it("drops a steward the browser sends with a new request", async () => {
      const created = await as(provider).submit(
        intake({ answers: { ...intake().answers, steward: "Crafted Steward" } }),
      );
      expect(created.intake.answers).not.toHaveProperty("steward");
      expect((await as(provider).get(created.id))?.intake.answers).not.toHaveProperty("steward");
    });

    it("ignores a steward the browser adds on a resubmission", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Restate it.",
      });
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Restated.",
        intake: edited(created, {
          answers: { ...created.intake.answers, steward: "Crafted Steward" },
        }),
      });
      expect(resubmitted.intake.answers).not.toHaveProperty("steward");
    });

    it("takes a whole-intake resubmission with no steward answer", async () => {
      const { steward: _none, ...answers } = { steward: "", ...intake().answers };
      const created = await as(provider).submit(intake({ answers }));
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Restate it.",
      });
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Restated.",
        intake: edited(created),
      });
      expect(resubmitted.stage).toBe("business-roi-review");
      expect(resubmitted.intake.answers).not.toHaveProperty("steward");
    });

    it("refuses Myself twice on one dataset, but takes it on several datasets and the initiative", async () => {
      const me = { self: true as const, name: "", email: "" };
      const dataset = intake().datasets[0]!;
      await expect(
        as(provider).submit(intake({ datasets: [{ ...dataset, owners: [me, me] }] })),
      ).rejects.toThrow(/Dataset 1, owner 2: Myself is already owner 1 of this dataset/);
      expect(await as(provider).listMine()).toEqual([]);

      const created = await as(provider).submit(
        intake({
          initiativeOwner: { kind: "self" },
          datasets: [
            { ...dataset, owners: [me] },
            { ...dataset, name: "Other", datasetTag: "other_tag", owners: [me] },
          ],
        }),
      );
      expect(Object.values(created.ownerVerification)).toEqual(["verified", "verified"]);
      expect(created.initiativeOwner?.verification).toBe("verified");
    });

    it("lets a resubmission switch a dataset owner from Someone else to Myself on the same record", async () => {
      const created = await as(provider).submit(intake());
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Are you the owner?",
      });
      const stored = created.intake.datasets[0]!;
      const ownerId = stored.owners[0]!.id!;
      expect(created.ownerVerification).toEqual({ [ownerId]: "not-verified" });

      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Yes, me.",
        intake: edited(created, {
          datasets: [{ ...stored, owners: [{ id: ownerId, self: true, name: "", email: "" }] }],
        }),
      });

      const owner = resubmitted.intake.datasets[0]!.owners[0]!;
      expect(owner).toMatchObject({ id: ownerId, self: true, name: "Pat Provider" });
      expect(resubmitted.ownerVerification).toEqual({ [ownerId]: "verified" });
    });

    it("lets a resubmission change the owner: Myself to Someone else clears the principal", async () => {
      const created = await as(provider).submit(
        intake({
          datasets: [{ ...intake().datasets[0]!, owners: [{ self: true, name: "", email: "" }] }],
        }),
      );
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Who owns this?",
      });
      const stored = created.intake.datasets[0]!;
      const resubmitted = await as(provider).resubmit(created.id, {
        answer: "Sam owns it.",
        intake: edited(created, {
          initiativeOwner: someoneElse as never,
          datasets: [
            {
              ...stored,
              owners: [{ id: stored.owners[0]!.id, name: "Sam Else", email: "sam.else@example.test" }],
            },
          ],
        }),
      });

      expect(resubmitted.initiativeOwner).toMatchObject({
        kind: "someone-else",
        principalId: null,
        verification: "not-verified",
      });
      // The same owner record (#222), no longer the signed-in user.
      const owner = resubmitted.intake.datasets[0]!.owners[0]!;
      expect(owner.id).toBe(stored.owners[0]!.id);
      expect(owner).not.toHaveProperty("self");
      expect(resubmitted.ownerVerification).toEqual({ [owner.id!]: "not-verified" });
      expect(resubmitted.decisions.at(-1)?.resubmission?.changes).toContainEqual({
        field: "Initiative owner",
        before: "Myself (Pat Provider, pat.provider@example.test)",
        after: "Sam Else (sam.else@example.test)",
      });

      // And back again: Myself is the session's identity, never the typed one.
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Actually?",
      });
      const back = await as(provider).resubmit(created.id, {
        answer: "It's me after all.",
        intake: edited(resubmitted, { initiativeOwner: { kind: "self" } }),
      });
      expect(back.initiativeOwner).toMatchObject({
        kind: "self",
        principalId: "scim-provider-1",
        verification: "verified",
      });
    });

    it("keeps the owner as it was when a resubmission sends only an answer", async () => {
      const created = await as(provider).submit(intake({ initiativeOwner: someoneElse as never }));
      await as(businessOffice).decide(created.id, {
        type: "send-back",
        to: "submitted",
        note: "Clarify.",
      });
      const resubmitted = await as(provider).resubmit(created.id, { answer: "Clarified." });
      expect(resubmitted.initiativeOwner).toEqual(created.initiativeOwner);
    });
  });

  describe("the actor comes from the signed-in session, never the caller", () => {
    // The repository's methods take no actor; these calls smuggle one in anyway.
    type Smuggling = (...args: unknown[]) => Promise<unknown>;

    it("ignores reviewer roles a caller tries to pass to an inbox read", async () => {
      await as(provider).submit(intake());
      const listInbox = as(provider).listInbox as unknown as Smuggling;
      await expect(listInbox("business-office", businessOffice)).rejects.toThrow(
        /Pat Provider is not a member of the configured EDP business office group/,
      );
    });

    it("ignores an actor a caller tries to pass to a decision", async () => {
      const created = await as(provider).submit(intake());
      const decide = as(provider).decide as unknown as Smuggling;
      await expect(decide(created.id, { type: "approve" }, businessOffice)).rejects.toThrow(
        "Onboarding request not found.",
      );
      expect((await as(provider).get(created.id))?.decisions.at(-1)?.kind).toBe("forward");
    });

    it("records the submitting provider from the session, not a passed identity", async () => {
      const submit = as(provider).submit as unknown as Smuggling;
      const created = (await submit(intake(), otherPerson)) as { providerId: string };
      expect(created.providerId).toBe("scim-provider-1");
    });

    it("re-reads the session on every call, so a role granted then revoked stops working", async () => {
      const created = await as(provider).submit(intake());
      expect(await as(businessOffice).listInbox("business-office")).toHaveLength(1);
      await expect(
        as({ ...businessOffice, reviewerRoles: [] }).decide(created.id, { type: "approve" }),
      ).rejects.toThrow("Onboarding request not found.");
    });
  });
});

describe("one write resolves the signed-in user once (memory adapter, #103)", () => {
  // The session as a write sees it: `first` on its first read, `later` on any
  // after that. One write must act, record and resolve Myself as one person.
  function flakySession(first: OnboardingActor, later: OnboardingActor) {
    let reads = 0;
    let signedIn = first;
    return {
      currentUser: async () => profileFor(reads++ === 0 ? signedIn : later),
      /** Start a new write signed in as `actor`. */
      next(actor: OnboardingActor) {
        reads = 0;
        signedIn = actor;
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SUBMITTED_AT);
  });
  afterEach(() => vi.useRealTimers());

  const mine = () =>
    intake({
      datasets: [{ ...intake().datasets[0]!, owners: [{ self: true, name: "", email: "" }] }],
    });

  it("stores Myself as the same person a submit records as the provider", async () => {
    const session = flakySession(provider, otherPerson);
    const store = createMemoryOnboardingStore({ currentUser: session.currentUser });

    const created = await store.submit(mine());

    expect(created.providerId).toBe("scim-provider-1");
    expect(created.decisions[0]?.actorId).toBe("scim-provider-1");
    expect(created.initiativeOwner).toMatchObject({
      principalId: "scim-provider-1",
      name: "Pat Provider",
    });
    expect(created.intake.datasets[0]?.owners[0]).toMatchObject({ name: "Pat Provider" });
  });

  it("stores Myself as the same person a resubmission records as acting", async () => {
    const session = flakySession(provider, otherPerson);
    const store = createMemoryOnboardingStore({ currentUser: session.currentUser });
    const created = await store.submit(mine());
    session.next(businessOffice);
    await store.decide(created.id, { type: "send-back", to: "submitted", note: "Who?" });

    session.next(provider);
    const resubmitted = await store.resubmit(created.id, {
      answer: "Me.",
      intake: edited(created),
    });

    expect(resubmitted.decisions.at(-1)?.actorId).toBe("scim-provider-1");
    expect(resubmitted.initiativeOwner).toMatchObject({
      principalId: "scim-provider-1",
      name: "Pat Provider",
    });
    expect(resubmitted.intake.datasets[0]?.owners[0]).toMatchObject({ name: "Pat Provider" });
  });
});

describe("the old seven-stage model alongside (memory adapter)", () => {
  let store: DataStore;
  let signedIn: UserProfile;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SUBMITTED_AT);
    signedIn = profileFor(provider);
    store = createMemoryStore(makeSnapshot(), { currentUser: async () => signedIn });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps access requests on their own repository, untouched by onboarding requests", async () => {
    await store.onboarding.submit(intake());
    await store.requests.createRequest(makeNewRequest());
    expect((await store.requests.listRequests()).map((r) => r.id)).toEqual([
      "REQ-9001",
      "REQ-2038",
      "REQ-2052",
    ]);
    expect(await store.status.listStages()).toHaveLength(6);
  });
});
