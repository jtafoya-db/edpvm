/**
 * The SLA on dataset owners' decisions (docs/mvp-access-model.md, "SLAs").
 * Reuses the business-day clock in src/data/sla.ts; the stage-keyed config
 * there belongs to the retired seven-stage lifecycle, so the target comes
 * from the access-request config (config.ts) instead.
 */
import { addBusinessDays, businessDaysBetween, type HolidayCalendar } from "../sla";
import type { AccessRequestSlaConfig } from "./config";
import type { AccessRequestSla } from "./types";

export function accessRequestSla(
  requestedAt: string,
  now: Date,
  config: AccessRequestSlaConfig,
  holidays: HolidayCalendar = [],
): AccessRequestSla {
  const target = config.targetBusinessDays;
  const due = addBusinessDays(requestedAt, target, holidays);
  const elapsed = Math.max(0, businessDaysBetween(requestedAt, now, holidays));
  const remaining = Math.max(0, target - elapsed);
  const state =
    now.getTime() > due.getTime()
      ? "breached"
      : remaining <= config.dueSoonBusinessDays
        ? "due-soon"
        : "on-track";
  return {
    targetBusinessDays: target,
    provisional: config.provisional,
    dueAt: due.toISOString(),
    businessDaysRemaining: remaining,
    state,
    escalationAppropriate: state === "breached",
  };
}
