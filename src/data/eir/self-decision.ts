/**
 * A safeguards validator's decision on their own EIR. Refused everywhere by
 * default. Only a PR preview's test mode allows it, and that is decided on
 * the server (`src/server/eir-test-mode.ts`, two guards) and passed in when
 * the rules are built (`createMemoryEirRepository({ selfDecisionTestMode })`).
 * The rules never read it from a session, a profile or anything a client
 * sends.
 *
 * The record of it is structured, and set only by the rules: the action
 * carries `selfDecisionTestMode: true`, stored as the action row's `payload`
 * (`{"selfDecisionTestMode":true}`). Notes and responses are stored as people
 * wrote them. The audit view derives its marker from `payload` alone
 * (`audit.eir_branch` in `resources/store-eir.sql`). So that no free text can
 * pass for that marker, every note or response that reaches an action row
 * goes through {@link refuseForgedMarker}.
 */

export const SELF_DECISION_TEST_MODE_NOTE = "[Self-decision under preview test mode]";

export const OWN_EIR_REFUSAL = "Safeguards validators can't decide their own EIR.";

export const FORGED_MARKER_REFUSAL = `A note or response can't start with "${SELF_DECISION_TEST_MODE_NOTE}": only the app marks a self-decision, in a preview's test mode.`;

// Whitespace and the invisible characters a start could hide behind
// (soft hyphen, zero-width and directional marks, word joiners, BOM).
const LEADING_INVISIBLE =
  /^[\s\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\uFEFF]+/u;

/**
 * True when free text starts with the marker: compared after NFKC
 * normalisation, ignoring leading whitespace and zero-width characters, in
 * any case.
 */
export function startsWithSelfDecisionMarker(text: string | null | undefined): boolean {
  const normalised = (text ?? "").normalize("NFKC").replace(LEADING_INVISIBLE, "").toLowerCase();
  return normalised.startsWith(SELF_DECISION_TEST_MODE_NOTE.toLowerCase());
}

/**
 * The one check for every free-text value that becomes an action's note:
 * decision notes, and responses on a submission, resubmission, renewal or
 * Send response.
 */
export function refuseForgedMarker<E extends Error>(
  text: string | null | undefined,
  refuse: (message: string) => E,
): void {
  if (startsWithSelfDecisionMarker(text)) throw refuse(FORGED_MARKER_REFUSAL);
}

/**
 * A note as people read it. Rounds 7 and 8 of PR #134 (previews only) wrote
 * the marker into the note text; it's dropped here, and shown only from the
 * structured flag.
 */
export function withoutLegacyMarker(note: string | null | undefined): string | undefined {
  if (note == null) return undefined;
  if (!note.startsWith(SELF_DECISION_TEST_MODE_NOTE)) return note;
  const rest = note.slice(SELF_DECISION_TEST_MODE_NOTE.length).trim();
  return rest || undefined;
}
