import { describe, expect, it } from "vitest";

import { FEATURES, FEATURE_STATUSES } from "./registry";

describe("FEATURES", () => {
  it("has one uniquely identified entry for every governed capability", () => {
    const entries = Object.values(FEATURES);
    const ids = entries.map((feature) => feature.id);

    expect(entries).toHaveLength(26);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(FEATURES)).toEqual(ids);
  });

  it("uses valid statuses and assigns a phase to every planned capability", () => {
    for (const feature of Object.values(FEATURES)) {
      expect(FEATURE_STATUSES).toContain(feature.status);
      if (feature.status === "planned") {
        expect(feature.phase).toBeTypeOf("number");
        expect(feature.phase).toBeGreaterThan(0);
      }
    }
  });

  it("marks only the genuinely-real surfaces live, and every mock-backed surface coming-soon", () => {
    // The MVP contract: exactly these capabilities are real.
    const live = Object.values(FEATURES)
      .filter((f) => f.status === "live")
      .map((f) => f.id)
      .sort();
    expect(live).toEqual([
      "access-requests",
      "admin-form-editor",
      "change-list",
      "dataset-access-persistence",
      "dataset-team",
      "eir-definition-publishing",
      "eir-form-fields",
      "eir-lifecycle",
      "group-membership-reader",
      "onboarding-request-persistence",
      "onboarding-request-status",
      "onboarding-review",
      "onboarding-wizard",
    ]);

    // Session-only access request state remains an explicit stub.
    expect(FEATURES["access-request-persistence"].status).toBe("stub");

    // Every mock-backed screen surface must be an honest coming-soon.
    for (const id of [
      "data-discovery",
      "access-bundles",
      "request-cart",
      "request-status-tracking",
      "cross-system-access",
      "admin-operations",
    ] as const) {
      expect(FEATURES[id].status).toBe("coming-soon");
    }
  });

  it("labels the #86 intake stubs as stubs", () => {
    expect(FEATURES["dedicated-workspace-criteria"].status).toBe("stub");
    expect(FEATURES["compute-policy-change-requests"].status).toBe("stub");
  });
});
