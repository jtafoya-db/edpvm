/**
 * Whether a value is a person's name or only an identifier — the one rule
 * the server's display-name resolution (`src/server/identity.ts`) and the
 * EIR name prefill (`src/data/eir/form.ts`) share.
 *
 * Deterministic, with no guessing at what a real name looks like: a single
 * word like "Cher" is a name. A value is NOT a name when it is blank,
 * contains `@` (an email, or GovCloud's `<userId>@<workspaceId>`), is a
 * digit-shaped id in any script ({@link isDigitIdentifier}), or equals —
 * trimmed, ignoring case — the email, its local part, or a username. Known
 * limit: a person whose real name equals their username is treated as having
 * none.
 */

import type { NameSource } from "./types";

/**
 * Whether a server-resolved display name is a person's name: anything but the
 * email, username or placeholder fallbacks. A session without a source (seed
 * and dev users) has a real name.
 */
export function isPersonNameSource(source: NameSource | undefined): boolean {
  return source !== "email" && source !== "username" && source !== "none";
}

/** The identifiers a name must not merely repeat. */
export interface PersonIdentifiers {
  email?: string | null | undefined;
  /** The SCIM `userName`, the forwarded preferred username, … */
  usernames?: ReadonlyArray<string | null | undefined>;
}

/** Digit groups split by spaces, optionally `@` more of them: decimal digits in any script. */
const DIGIT_ID = /^\p{Nd}+(?:\s+\p{Nd}+)*(?:@\p{Nd}+(?:\s+\p{Nd}+)*)?$/u;

/**
 * Whether a value, trimmed, is only a digit-shaped id: digit groups, or the
 * `<digits>@<digits>` form, in decimal digits of any script (`1234`, `１２３４`,
 * `١٢٣٤ ٥٦٧٨`). The one rule both a name and the server's email/username
 * display fallback (`src/server/identity.ts`) are checked against.
 */
export function isDigitIdentifier(value: string): boolean {
  return DIGIT_ID.test(value.trim());
}

export function isPersonName(
  value: string | null | undefined,
  identifiers: PersonIdentifiers,
): value is string {
  const name = value?.trim().toLowerCase();
  if (!name || name.includes("@") || isDigitIdentifier(name)) return false;
  const email = identifiers.email?.trim().toLowerCase();
  const taken = [email, email?.split("@")[0], ...(identifiers.usernames ?? [])]
    .map((id) => id?.trim().toLowerCase())
    .filter(Boolean);
  return !taken.includes(name);
}
