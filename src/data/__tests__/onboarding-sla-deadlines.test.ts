/**
 * The persisted SLA deadlines a request carries from the moment it enters a
 * stage (#125). Both timestamps are set at a review stage and null wherever no
 * reviewer owes a decision (`docs/data-model.md`), so a job or escalation query
 * reads them straight from the row instead of recomputing at read time.
 */
import { describe, expect, it } from "vitest";

import { onboardingSlaDeadlines } from "../onboarding/lifecycle";

// Monday 2026-09-28 09:00 UTC — business days counted from here.
const ENTERED = "2026-09-28T09:00:00.000Z";

describe("onboardingSlaDeadlines", () => {
  it("sets both deadlines at a review stage, five business days out", () => {
    expect(onboardingSlaDeadlines("business-roi-review", ENTERED)).toEqual({
      dueAt: "2026-10-05T09:00:00.000Z", // Mon + 5 business days
      dueSoonAt: "2026-10-02T09:00:00.000Z", // one business day before the target
    });
    expect(onboardingSlaDeadlines("ccb", ENTERED)).toEqual({
      dueAt: "2026-10-05T09:00:00.000Z",
      dueSoonAt: "2026-10-02T09:00:00.000Z",
    });
  });

  it("is null wherever no reviewer owes a decision", () => {
    expect(onboardingSlaDeadlines("submitted", ENTERED)).toBeNull();
    expect(onboardingSlaDeadlines("standup", ENTERED)).toBeNull();
    expect(onboardingSlaDeadlines("rejected", ENTERED)).toBeNull();
    expect(onboardingSlaDeadlines("withdrawn", ENTERED)).toBeNull();
  });
});
