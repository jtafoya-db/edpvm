import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_STAGES,
  applyTransition,
  fromAccessRequest,
  fromPipelineEntry,
  toAccessRequest,
  toPipelineEntry,
  type CanonicalRequest,
  type LifecycleStage,
} from "../index";
import type { AccessRequest, PipelineEntry } from "../types";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    id: "REQ-1",
    title: "A request",
    tenant: "Tenant A",
    requester: "Rae Requester",
    submittedAt: "2026-09-20T00:00:00.000Z",
    domainId: "individual-filing",
    intake: {
      purpose: "Analysis",
      answers: {
        domain: "individual-filing",
        steward: "Marcus Liu",
        businessCase: "Reduce manual work",
      },
      items: [{ kind: "Dataset", id: "asset-1" }],
      subRequests: [{ system: "Domain owner review", status: "active", detail: "Reviewing" }],
    },
    stage: "submitted",
    owner: "Domain team",
    priority: "high",
    livesOnLiveData: false,
    decisions: [],
    events: [],
    ...overrides,
  };
}

const context = { actor: "Alex Approver", note: "Looks good", now: "2026-09-29T12:00:00.000Z" };

describe("canonical lifecycle", () => {
  it("defines the seven ordered stages and accepts every adjacent forward transition", () => {
    expect(LIFECYCLE_STAGES.map(({ key }) => key)).toEqual([
      "submitted",
      "domain-review",
      "edp-roi-review",
      "ccb",
      "live-data-waiver",
      "provisioning",
      "active",
    ]);

    for (let index = 0; index < LIFECYCLE_STAGES.length - 1; index += 1) {
      const from = LIFECYCLE_STAGES[index]!.key;
      const to = LIFECYCLE_STAGES[index + 1]!.key;
      expect(
        applyTransition(
          request({ stage: from, livesOnLiveData: true }),
          { type: "forward", to },
          context,
        ).stage,
      ).toBe(to);
    }
  });

  it("throws clearly for non-adjacent and backward forward transitions", () => {
    expect(() => applyTransition(request(), { type: "forward", to: "ccb" }, context)).toThrow(
      "cannot move forward from 'submitted' to 'ccb'",
    );
    expect(() =>
      applyTransition(request({ stage: "ccb" }), { type: "forward", to: "domain-review" }, context),
    ).toThrow("cannot move forward from 'ccb' to 'domain-review'");
  });

  it("records an event but no decision for a plain forward transition", () => {
    const advanced = applyTransition(request(), { type: "forward", to: "domain-review" }, context);

    expect(advanced.decisions).toEqual([]);
    expect(advanced.events).toEqual([
      expect.objectContaining({
        type: "forward",
        fromStage: "submitted",
        toStage: "domain-review",
      }),
    ]);
  });

  it("records a decision for an approval transition", () => {
    const approved = applyTransition(request(), { type: "approve", to: "domain-review" }, context);

    expect(approved.decisions).toEqual([
      expect.objectContaining({ decision: "Approved", actor: context.actor }),
    ]);
  });

  it("sends a request back, records the decision and event, and permits it to advance again without mutation", () => {
    const original = request({ stage: "ccb", owner: "CCB" });
    const returned = applyTransition(
      original,
      { type: "send-back", to: "edp-roi-review", owner: "Business office" },
      { ...context, note: "Clarify the ROI" },
    );

    expect(original).toMatchObject({ stage: "ccb", decisions: [], events: [] });
    expect(returned).toMatchObject({
      stage: "edp-roi-review",
      owner: "Business office",
      decisions: [{ decision: "Questions requested", note: "Clarify the ROI" }],
      events: [{ type: "send-back", fromStage: "ccb", toStage: "edp-roi-review" }],
    });
    expect(applyTransition(returned, { type: "forward", to: "ccb" }, context).stage).toBe("ccb");
  });

  it("enforces the conditional live-data waiver gate", () => {
    expect(() =>
      applyTransition(
        request({ stage: "ccb", livesOnLiveData: true }),
        { type: "forward", to: "provisioning" },
        context,
      ),
    ).toThrow("live-data requests must pass live-data-waiver");
    expect(
      applyTransition(
        request({ stage: "ccb", livesOnLiveData: false }),
        { type: "forward", to: "provisioning" },
        context,
      ).stage,
    ).toBe("provisioning");
  });

  it.each(["active", "rejected", "withdrawn"] as const)(
    "prevents transitions out of terminal stage %s",
    (stage) => {
      expect(() => applyTransition(request({ stage }), { type: "reject" }, context)).toThrow(
        `terminal stage '${stage}'`,
      );
    },
  );
});

describe("legacy mappings", () => {
  it("carries the stable domain id and required intake domain/steward answers", () => {
    const canonical = request();

    expect(canonical.domainId).toBe("individual-filing");
    expect(canonical.intake.answers).toMatchObject({
      domain: "individual-filing",
      steward: "Marcus Liu",
    });
    expect(fromAccessRequest(toAccessRequest(canonical))).toMatchObject({
      domainId: "",
      intake: { answers: { domain: "", steward: "" } },
    });
  });

  it("round-trips every field carried by AccessRequest and derives lifecycle display fields", () => {
    const legacy: AccessRequest = {
      id: "REQ-2",
      title: "Dataset access",
      submittedAt: "2026-09-20T00:00:00.000Z",
      status: "In progress",
      overall: "EDP business & ROI review",
      purpose: "Research",
      items: [{ kind: "Dataset", id: "dataset-1" }],
      subRequests: [{ system: "Review", status: "active", detail: "Under review", ticket: "T-1" }],
      stageIndex: 2,
    };

    expect(toAccessRequest(fromAccessRequest(legacy))).toEqual(legacy);
    expect(toAccessRequest(request({ stage: "active" }))).toMatchObject({
      status: "Completed",
      overall: "Access active",
      stageIndex: 5,
    });
  });

  it.each([
    ["ccb", 3],
    ["live-data-waiver", 4],
    ["provisioning", 4],
    ["active", 5],
  ] as const)("maps canonical stage %s to in-range legacy index %i", (stage, stageIndex) => {
    const legacy = toAccessRequest(request({ stage }));

    expect(legacy.stageIndex).toBe(stageIndex);
    expect(legacy.stageIndex).toBeLessThan(6);
    expect(toAccessRequest(fromAccessRequest(legacy)).stageIndex).toBe(stageIndex);
  });

  it("round-trips every substantive field carried by PipelineEntry while deriving age and display state", () => {
    const legacy: PipelineEntry = {
      id: "ONB-1",
      kind: "onboard",
      title: "New feed",
      tenant: "Tenant B",
      requester: "Robin",
      submittedAt: "2026-09-20T00:00:00.000Z",
      state: "ccb",
      stage: "EDP intake CCB",
      nextAction: "Vote",
      owner: "CCB",
      ageDays: 9,
      jira: "EDP-2",
      jiraStatus: "Review",
      monthlyCost: 1200,
      roi: 2.4,
      sensitivity: "SBU (FTI)",
      pattern: "Approved pattern",
      delivery: "Self-build",
      decisions: [
        { at: "Sep 20", actor: "Robin", decision: "Submitted", note: "Ready", jira: "EDP-1" },
      ],
    };

    expect(
      toPipelineEntry(fromPipelineEntry(legacy), new Date("2026-09-29T00:00:00.000Z")),
    ).toEqual(legacy);
    expect(
      toPipelineEntry(request({ stage: "provisioning" }), new Date("2026-09-29T00:00:00.000Z")),
    ).toMatchObject({
      state: "provisioning",
      stage: "BEARS entitlements + Databricks provisioning",
      ageDays: 9,
    });
  });

  it("maps all canonical stages into valid legacy projections", () => {
    for (const { key } of LIFECYCLE_STAGES) {
      const stage: LifecycleStage = key;
      expect(toAccessRequest(request({ stage })).stageIndex).toBeGreaterThanOrEqual(0);
      expect(toAccessRequest(request({ stage })).stageIndex).toBeLessThan(6);
      expect(toPipelineEntry(request({ stage })).stage).not.toBe("");
    }
  });

  it.each([
    ["blocked", "Databricks provisioning"],
    ["returned", "Architecture consultation"],
  ] as const)(
    "preserves exceptional pipeline state %s even when its stage label differs",
    (state, stage) => {
      const legacy: PipelineEntry = {
        id: `ONB-${state}`,
        kind: "onboard",
        title: "Exceptional state",
        tenant: "Tenant B",
        requester: "Robin",
        submittedAt: "2026-09-20T00:00:00.000Z",
        state,
        stage,
        nextAction: "Resolve issue",
        owner: "Platform team",
        ageDays: 9,
        jira: "EDP-3",
        jiraStatus: "Open",
        monthlyCost: 100,
        roi: null,
        sensitivity: "SBU",
        pattern: "Custom",
        delivery: "Guided",
        decisions: [],
      };

      expect(
        toPipelineEntry(fromPipelineEntry(legacy), new Date("2026-09-29T00:00:00.000Z")).state,
      ).toBe(state);
    },
  );
});
