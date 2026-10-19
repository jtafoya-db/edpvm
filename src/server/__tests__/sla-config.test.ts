import { afterEach, describe, expect, it, vi } from "vitest";

import { readEffectiveSlaConfig } from "../sla-config";

describe("deploy-time SLA config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads every deploy-time setting from env", () => {
    expect(
      readEffectiveSlaConfig({
        EDP_SLA_EDP_ROI_REVIEW_BUSINESS_DAYS: "6",
        EDP_SLA_CCB_BUSINESS_DAYS: "7",
        EDP_SLA_EIR_VALIDATION_BUSINESS_DAYS: "4",
        EDP_SLA_ACCESS_REQUEST_DECISION_BUSINESS_DAYS: "5",
        EDP_SLA_DUE_SOON_BUSINESS_DAYS: "2",
        EDP_SLA_HOLIDAYS: "2026-10-12, 2026-11-11",
        EDP_EIR_VALIDITY_DAYS: "400",
        EDP_ACCESS_REQUEST_SLA_PROVISIONAL: "false",
      }),
    ).toEqual({
      stages: {
        "edp-roi-review": 6,
        ccb: 7,
        "eir-validation": 4,
        "access-request-decision": 5,
      },
      dueSoonThresholdBusinessDays: 2,
      holidays: ["2026-10-12", "2026-11-11"],
      eirValidityDays: 400,
      accessRequestSlaProvisional: false,
    });
  });

  it.each([
    ["EDP_SLA_EIR_VALIDATION_BUSINESS_DAYS", "-1"],
    ["EDP_SLA_DUE_SOON_BUSINESS_DAYS", "1.5"],
    ["EDP_EIR_VALIDITY_DAYS", "abc"],
  ])("rejects invalid integer config %s=%s", (name, value) => {
    expect(() => readEffectiveSlaConfig({ [name]: value })).toThrow(/integer between/);
  });

  it("rejects invalid holiday dates", () => {
    expect(() => readEffectiveSlaConfig({ EDP_SLA_HOLIDAYS: "2026-13-01" })).toThrow(
      /invalid ISO date/,
    );
    expect(() => readEffectiveSlaConfig({ EDP_SLA_HOLIDAYS: "2026-02-30" })).toThrow(
      /invalid ISO date/,
    );
  });

  it("treats the bundle's [] holiday sentinel as an empty list", () => {
    expect(readEffectiveSlaConfig({ EDP_SLA_HOLIDAYS: "[]" }).holidays).toEqual([]);
  });

  it("rejects blank values, out-of-range values and zero SLA targets", () => {
    expect(() => readEffectiveSlaConfig({ EDP_SLA_CCB_BUSINESS_DAYS: "" })).toThrow(
      /must not be blank/,
    );
    expect(() => readEffectiveSlaConfig({ EDP_SLA_CCB_BUSINESS_DAYS: "0" })).toThrow(
      /between 1 and 60/,
    );
    expect(() => readEffectiveSlaConfig({ EDP_SLA_CCB_BUSINESS_DAYS: "61" })).toThrow(
      /between 1 and 60/,
    );
    expect(() => readEffectiveSlaConfig({ EDP_EIR_VALIDITY_DAYS: "3651" })).toThrow(
      /between 1 and 3650/,
    );
  });

  it("prefers a platform-passed env object over process.env", () => {
    vi.stubEnv("EDP_SLA_CCB_BUSINESS_DAYS", "5");

    expect(readEffectiveSlaConfig({ EDP_SLA_CCB_BUSINESS_DAYS: "9" }).stages.ccb).toBe(9);
  });
});
