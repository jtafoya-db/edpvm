import type { LifecycleStage } from "./lifecycle";

export type SlaStage = Exclude<LifecycleStage, "active"> | "eir-validation";
export type SlaState = "on-track" | "due-soon" | "breached";
export type HolidayCalendar = readonly string[] | ReadonlySet<string>;
export type SlaConfig = Readonly<Record<LifecycleStage, number | null>>;

export const DEFAULT_SLA_CONFIG = {
  submitted: 0,
  "domain-review": 3,
  "edp-roi-review": 5,
  ccb: 5,
  "live-data-waiver": 3,
  provisioning: 5,
  active: null,
} as const satisfies SlaConfig;

export const DEFAULT_DUE_SOON_THRESHOLD = 1;

export interface SlaStatus {
  stage: SlaStage;
  target: number;
  dueAt: string;
  businessDaysElapsed: number;
  businessDaysRemaining: number;
  state: SlaState;
  escalationAppropriate: boolean;
}

export interface SlaOptions {
  config?: SlaConfig;
  holidays?: HolidayCalendar;
  dueSoonThreshold?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MS = 86_400_000;

function toDate(value: Date | string): Date {
  const date = new Date(value instanceof Date ? value.getTime() : value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function holidaySet(holidays: HolidayCalendar = []): ReadonlySet<string> {
  const result = holidays instanceof Set ? holidays : new Set(holidays);
  for (const holiday of result) {
    if (!ISO_DATE.test(holiday)) {
      throw new RangeError(`Invalid holiday date: ${holiday}`);
    }
  }
  return result;
}

function isBusinessDay(date: Date, holidays: ReadonlySet<string>): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(isoDate(date));
}

/** Adds whole business days while retaining the input time of day. */
export function addBusinessDays(
  start: Date | string,
  days: number,
  holidays: HolidayCalendar = [],
): Date {
  if (!Number.isInteger(days)) throw new RangeError("Business days must be an integer");

  const result = toDate(start);
  const calendar = holidaySet(holidays);
  const direction = Math.sign(days);
  let remaining = Math.abs(days);

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + direction);
    if (isBusinessDay(result, calendar)) remaining -= 1;
  }

  return result;
}

/** Counts business-day boundaries from a to b; reversing the dates reverses the sign. */
export function businessDaysBetween(
  a: Date | string,
  b: Date | string,
  holidays: HolidayCalendar = [],
): number {
  const start = toDate(a);
  const end = toDate(b);
  if (start.getTime() === end.getTime()) return 0;

  const direction = start < end ? 1 : -1;
  const calendar = holidaySet(holidays);
  const cursor = toDate(start);
  let count = 0;

  while (true) {
    cursor.setUTCDate(cursor.getUTCDate() + direction);
    if (direction > 0 ? cursor.getTime() > end.getTime() : cursor.getTime() < end.getTime()) break;
    if (isBusinessDay(cursor, calendar)) count += direction;
  }

  return count;
}

export function computeSlaStatus(
  stage: Exclude<LifecycleStage, "active">,
  enteredAt: Date | string,
  now: Date | string,
  options: SlaOptions = {},
): SlaStatus {
  const target = (options.config ?? DEFAULT_SLA_CONFIG)[stage];
  return computePeriodSlaStatus(stage, enteredAt, now, target, options);
}

/** Compute SLA state for a lifecycle outside the onboarding-stage configuration. */
export function computePeriodSlaStatus(
  stage: SlaStage,
  enteredAt: Date | string,
  now: Date | string,
  target: number | null,
  options: Omit<SlaOptions, "config"> = {},
): SlaStatus {
  const threshold = options.dueSoonThreshold ?? DEFAULT_DUE_SOON_THRESHOLD;
  if (target === null || !Number.isInteger(target) || target < 0) {
    throw new RangeError(`Invalid SLA target for stage '${stage}'`);
  }
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new RangeError("Due-soon threshold must be a non-negative integer");
  }

  const entered = toDate(enteredAt);
  const current = toDate(now);
  const due = addBusinessDays(entered, target, options.holidays);
  const elapsed = Math.max(0, businessDaysBetween(entered, current, options.holidays));
  const remaining = Math.max(0, target - elapsed);
  const breached = target > 0 && current.getTime() > due.getTime();
  const state: SlaState =
    target === 0
      ? "on-track"
      : breached
        ? "breached"
        : remaining <= threshold
          ? "due-soon"
          : "on-track";

  return {
    stage,
    target,
    dueAt: due.toISOString(),
    businessDaysElapsed: elapsed,
    businessDaysRemaining: remaining,
    state,
    escalationAppropriate: state === "breached",
  };
}

/** Project current SLA state from due dates stored when the stage was entered. */
export function computeStoredSlaStatus(
  stage: SlaStage,
  enteredAt: Date | string,
  now: Date | string,
  dueAt: Date | string,
  dueSoonAt?: Date | string | null,
  options: Pick<SlaOptions, "holidays"> = {},
): SlaStatus {
  const entered = toDate(enteredAt);
  const current = toDate(now);
  const due = toDate(dueAt);
  const dueSoon = dueSoonAt ? toDate(dueSoonAt) : due;
  const target = Math.max(0, businessDaysBetween(entered, due, options.holidays));
  const elapsed = Math.max(0, businessDaysBetween(entered, current, options.holidays));
  const remaining = Math.max(0, target - elapsed);
  const breached = target > 0 && current.getTime() > due.getTime();
  const state: SlaState =
    target === 0
      ? "on-track"
      : breached
        ? "breached"
        : current.getTime() >= dueSoon.getTime()
          ? "due-soon"
          : "on-track";

  return {
    stage,
    target,
    dueAt: due.toISOString(),
    businessDaysElapsed: elapsed,
    businessDaysRemaining: remaining,
    state,
    escalationAppropriate: state === "breached",
  };
}
