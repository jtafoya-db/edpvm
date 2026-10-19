// Shared cases for the dataset tag rule's tests, at every place it's enforced:
// the rule itself, the intake form, both onboarding stores and the pilot config.

/** Tags the rule refuses, with what the person is told. */
export const BAD_TAGS: ReadonlyArray<[string, string, RegExp]> = [
  ["spaces", "refund anomaly scores", /only use lowercase letters, numbers and underscores/],
  ["uppercase", "Refund_Scores", /only use lowercase letters, numbers and underscores/],
  ["a hyphen", "refund-scores", /only use lowercase letters, numbers and underscores/],
  ["a leading digit", "2024_refunds", /must start with a letter/],
  ["a leading underscore", "_refunds", /must start with a letter/],
  ["a double underscore", "refund__scores", /two in a row/],
  ["a trailing underscore", "refunds_", /end with an underscore/],
  ["too short", "ab", /3 to 64 characters/],
  ["too long", `r${"a".repeat(64)}`, /3 to 64 characters/],
];

export const GOOD_TAGS = [
  "refund_anomaly_scores",
  "abc",
  "case_signals",
  "a1_b2_c3",
  `r${"a".repeat(63)}`, // exactly 64
];
