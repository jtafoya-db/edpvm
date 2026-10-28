/**
 * The one table of EIR approval settings (#204) that both parsers must pass:
 * the server's (`src/server/eir-approval-mode.ts`) and the startup check in
 * `databricks-app/serve.mjs`, which can't import it (it runs before the
 * server bundle loads). `eir-approval-mode.test.ts` runs every row through both.
 */
export const MODE_ENV = "EDP_EIR_APPROVAL_MODE";
export const OUTCOMES_ENV = "EDP_EIR_AUTOMATIC_VALIDITY_OUTCOMES";

export const ACCEPTED_MODES = ["manual-validator", "automatic"] as const;
export const REFUSED_MODES = ["", "Automatic", "auto", "manual", "true"] as const;
export const MODE_REFUSAL = 'EDP_EIR_APPROVAL_MODE must be "manual-validator" or "automatic".';

/** Accepted qualifying-result lists and what they mean. */
export const ACCEPTED_OUTCOMES: readonly (readonly [string, readonly string[]])[] = [
  ["pass", ["pass"]],
  ["warning", ["warning"]],
  ["pass,warning", ["pass", "warning"]],
  [" warning , pass ,pass", ["warning", "pass"]],
];

/** Refused lists, with the reason each is refused for. */
export const REFUSED_OUTCOMES: readonly (readonly [string, string])[] = [
  ["pass,blocking", "can never include blocking"],
  ["block", "can never include blocking"],
  ["manual-review", "can't include manual-review"],
  ["", "must name pass, warning, or both"],
  ["   ", "must name pass, warning, or both"],
  ["pass;warning", "must name pass, warning, or both"],
  ["PASS", "must name pass, warning, or both"],
  // A malformed list never quietly means a shorter one (#308 review).
  ["pass,", "must not have an empty item"],
  [",pass", "must not have an empty item"],
  ["pass,,warning", "must not have an empty item"],
  ["pass, ,warning", "must not have an empty item"],
  [",", "must not have an empty item"],
  [" , ", "must not have an empty item"],
];
