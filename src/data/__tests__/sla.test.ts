import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLA_CONFIG,
  addBusinessDays,
  businessDaysBetween,
  computeSlaStatus,
  type SlaConfig,
} from "../sla";

describe("business-day calendar math", () => {
  it.each([
    ["2026-09-25T14:30:00.000Z", 1, "2026-09-28T14:30:00.000Z"],
    ["2026-09-25T14:30:00.000Z", 3, "2026-09-30T14:30:00.000Z"],
    ["2026-09-28T14:30:00.000Z", -1, "2026-09-25T14:30:00.000Z"],
    ["2026-09-26T14:30:00.000Z", 0, "2026-09-26T14:30:00.000Z"],
  ])("adds %i business days to %s", (start, days, expected) => {
    expect(addBusinessDays(start, days).toISOString()).toBe(expected);
  });

  it("skips injected holidays supplied as either an array or Set", () => {
    const holiday = "2026-09-28";
    const start = "2026-09-25T09:00:00.000Z";

    expect(addBusinessDays(start, 1, [holiday]).toISOString()).toBe("2026-09-29T09:00:00.000Z");
    expect(businessDaysBetween(start, "2026-09-29T09:00:00.000Z", new Set([holiday]))).toBe(1);
  });

  it.each([
    ["2026-09-25T09:00:00.000Z", "2026-09-28T09:00:00.000Z", 1],
    ["2026-09-25T09:00:00.000Z", "2026-09-30T09:00:00.000Z", 3],
    ["2026-09-28T09:00:00.000Z", "2026-09-25T09:00:00.000Z", -1],
    ["2026-09-26T09:00:00.000Z", "2026-09-27T09:00:00.000Z", 0],
  ])("counts business days between %s and %s", (a, b, expected) => {
    expect(businessDaysBetween(a, b)).toBe(expected);
  });
});

describe("SLA status", () => {
  const entered = "2026-09-21T09:00:00.000Z";

  it("ships the per-stage defaults as configurable data", () => {
    expect(DEFAULT_SLA_CONFIG).toEqual({
      submitted: 0,
      "domain-review": 3,
      "edp-roi-review": 5,
      ccb: 5,
      "live-data-waiver": 3,
      provisioning: 5,
      active: null,
    });
  });

  it("accepts an override config", () => {
    const config: SlaConfig = { ...DEFAULT_SLA_CONFIG, "domain-review": 2 };
    expect(computeSlaStatus("domain-review", entered, entered, { config })).toMatchObject({
      target: 2,
      dueAt: "2026-09-23T09:00:00.000Z",
    });
  });

  it("marks the exact configurable due-soon boundary without breaching", () => {
    expect(
      computeSlaStatus("domain-review", entered, "2026-09-23T09:00:00.000Z", {
        dueSoonThreshold: 1,
      }),
    ).toMatchObject({
      businessDaysElapsed: 2,
      businessDaysRemaining: 1,
      state: "due-soon",
      escalationAppropriate: false,
    });
  });

  it.each([
    ["2026-09-21T15:00:00.000Z", 0, 3],
    ["2026-09-22T15:00:00.000Z", 1, 2],
  ])(
    "counts only elapsed business days when now has a later time of day (%s)",
    (now, businessDaysElapsed, businessDaysRemaining) => {
      expect(computeSlaStatus("domain-review", entered, now)).toMatchObject({
        businessDaysElapsed,
        businessDaysRemaining,
      });
    },
  );

  it("breaches immediately after the due timestamp", () => {
    expect(computeSlaStatus("domain-review", entered, "2026-09-24T09:00:00.001Z")).toMatchObject({
      dueAt: "2026-09-24T09:00:00.000Z",
      state: "breached",
      escalationAppropriate: true,
    });
  });

  it.each([
    ["2026-09-21T09:00:00.000Z", 0, 5],
    ["2026-09-22T09:00:00.000Z", 1, 4],
    ["2026-09-25T09:00:00.000Z", 4, 1],
    ["2026-09-28T09:00:00.000Z", 5, 0],
  ])("keeps elapsed and remaining symmetric at %s", (now, elapsed, remaining) => {
    const result = computeSlaStatus("edp-roi-review", entered, now);
    expect(result.businessDaysElapsed).toBe(elapsed);
    expect(result.businessDaysRemaining).toBe(remaining);
    expect(result.businessDaysElapsed + result.businessDaysRemaining).toBe(result.target);
  });

  it("keeps a zero-day stage on track after time passes", () => {
    expect(computeSlaStatus("submitted", entered, "2026-10-01T15:00:00.000Z")).toMatchObject({
      target: 0,
      dueAt: entered,
      businessDaysElapsed: 8,
      businessDaysRemaining: 0,
      state: "on-track",
      escalationAppropriate: false,
    });
  });

  it("is deterministic for an injected now", () => {
    const args = ["ccb", entered, "2026-09-22T12:00:00.000Z"] as const;
    expect(computeSlaStatus(...args)).toEqual(computeSlaStatus(...args));
  });

  it.each([
    ["2026-09-21T09:00:00.000Z", "on-track", false],
    ["2026-09-23T09:00:00.000Z", "due-soon", false],
    ["2026-09-24T09:00:00.001Z", "breached", true],
  ] as const)("only escalates a breached SLA at %s", (now, state, escalationAppropriate) => {
    expect(computeSlaStatus("domain-review", entered, now)).toMatchObject({
      state,
      escalationAppropriate,
    });
  });

  it("applies holidays to due, elapsed, and remaining calculations", () => {
    expect(
      computeSlaStatus("domain-review", entered, "2026-09-23T09:00:00.000Z", {
        holidays: ["2026-09-22"],
      }),
    ).toMatchObject({
      dueAt: "2026-09-25T09:00:00.000Z",
      businessDaysElapsed: 1,
      businessDaysRemaining: 2,
      state: "on-track",
    });
  });
});
