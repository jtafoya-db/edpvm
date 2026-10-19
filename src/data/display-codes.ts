/**
 * Display codes: the short label a person quotes to EDP staff ("where's
 * ONB-7K3QFD at?"). ADR-0007 decision 2, as amended 2026-10-10.
 *
 * EIRs, onboarding requests and access requests get the prefix and six
 * characters of Crockford's base32 (no I, L, O or U) from a CSPRNG. Codes are
 * unique, not sequential: the Delta create refuses a code its table already
 * has and retries with a fresh one (`allocateDisplayCode` in
 * `src/server/delta/write-helpers.ts`). Change-list entries (`CL-0042`) stay
 * on the counter.
 *
 * Records numbered by the old counter keep their numbers (`EIR-1042`,
 * `ONB-1000`) in `display_number`; {@link displayLabel} and
 * {@link parseDisplayLabel} take both.
 *
 * Web Crypto only, so this runs in the browser and on the server.
 */

/** Crockford's base32 alphabet. */
export const DISPLAY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DISPLAY_CODE_LENGTH = 6;

/** Fills a byte array with random bytes; `crypto.getRandomValues` by default. */
export type RandomBytes = (target: Uint8Array) => Uint8Array;

const cryptoBytes: RandomBytes = (target) => globalThis.crypto.getRandomValues(target);

/**
 * A fresh code for `prefix`, e.g. `ONB-7K3QFD`. One byte per character (256
 * is a multiple of 32, so it's unbiased). An all-digit draw is skipped, so
 * `EIR-104211` can only ever be an old counter number.
 */
export function newDisplayCode(prefix: string, random: RandomBytes = cryptoBytes): string {
  for (;;) {
    const drawn = random(new Uint8Array(DISPLAY_CODE_LENGTH));
    const code = Array.from(drawn, (byte) => DISPLAY_CODE_ALPHABET[byte % 32]).join("");
    if (!/^\d+$/.test(code)) return `${prefix}-${code}`;
  }
}

/** A record's label: its code, or `<prefix>-<n>` from the old counter. */
export function displayLabel(
  prefix: string,
  row: { display_code?: string | null; display_number?: number | string | null },
): string | undefined {
  if (row.display_code) return row.display_code;
  if (row.display_number === null || row.display_number === undefined) return undefined;
  return `${prefix}-${Number(row.display_number)}`;
}

/**
 * What a quoted label stands for: a code (normalised to upper case, with
 * Crockford's look-alikes `I`/`L` → 1 and `O` → 0) or an old counter number.
 * `undefined` for anything else.
 */
export function parseDisplayLabel(
  prefix: string,
  label: string,
): { code: string } | { number: number } | undefined {
  const text = label.trim().toUpperCase();
  const head = `${prefix.toUpperCase()}-`;
  if (!text.startsWith(head)) return undefined;
  const tail = text.slice(head.length);
  // Codes are never all digits, so digits are an old counter number.
  if (/^\d+$/.test(tail)) return { number: Number(tail) };
  const code = tail.replace(/[IL]/g, "1").replace(/O/g, "0");
  if (code.length !== DISPLAY_CODE_LENGTH) return undefined;
  if ([...code].some((c) => !DISPLAY_CODE_ALPHABET.includes(c))) return undefined;
  return { code: `${head}${code}` };
}
