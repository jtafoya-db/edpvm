import {
  DEFAULT_DUE_SOON_THRESHOLD,
  DEFAULT_SLA_CONFIG,
  type HolidayCalendar,
  type SlaConfig,
} from "./sla.ts";

export interface EffectiveSlaConfig {
  stages: {
    "edp-roi-review": number;
    ccb: number;
    "eir-validation": number;
    "access-request-decision": number;
  };
  dueSoonThresholdBusinessDays: number;
  holidays: readonly string[];
  eirValidityDays: number;
  accessRequestSlaProvisional: boolean;
}

export const DEFAULT_EFFECTIVE_SLA_CONFIG: EffectiveSlaConfig = {
  stages: {
    "edp-roi-review": DEFAULT_SLA_CONFIG["edp-roi-review"],
    ccb: DEFAULT_SLA_CONFIG.ccb,
    "eir-validation": 3,
    "access-request-decision": 3,
  },
  dueSoonThresholdBusinessDays: DEFAULT_DUE_SOON_THRESHOLD,
  holidays: [],
  eirValidityDays: 365,
  accessRequestSlaProvisional: true,
};

export function cloneEffectiveSlaConfig(
  config: EffectiveSlaConfig = DEFAULT_EFFECTIVE_SLA_CONFIG,
): EffectiveSlaConfig {
  return {
    stages: { ...config.stages },
    dueSoonThresholdBusinessDays: config.dueSoonThresholdBusinessDays,
    holidays: [...config.holidays],
    eirValidityDays: config.eirValidityDays,
    accessRequestSlaProvisional: config.accessRequestSlaProvisional,
  };
}

export function configuredLifecycleSla(config: EffectiveSlaConfig): SlaConfig {
  return {
    ...DEFAULT_SLA_CONFIG,
    "edp-roi-review": config.stages["edp-roi-review"],
    ccb: config.stages.ccb,
  };
}

export function configuredHolidays(config: EffectiveSlaConfig): HolidayCalendar {
  return config.holidays;
}
