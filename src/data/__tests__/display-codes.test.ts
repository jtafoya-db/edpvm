/**
 * Display codes (ADR-0007 decision 2, amended 2026-10-10): the counter-free
 * `EIR-7K3QFD` a person quotes to EDP staff, and the old counter numbers
 * (`EIR-1042`) that records made before it keep.
 */
import { describe, expect, it } from "vitest";

import {
  DISPLAY_CODE_ALPHABET,
  DISPLAY_CODE_LENGTH,
  displayLabel,
  newDisplayCode,
  parseDisplayLabel,
} from "../display-codes";

/** Random bytes that are the given values in turn, then repeat. */
const bytes = (...values: number[]) => {
  let i = 0;
  return (target: Uint8Array) => {
    for (let j = 0; j < target.length; j++) target[j] = values[i++ % values.length]!;
    return target;
  };
};

describe("display codes", () => {
  it("are the prefix and six characters of a 32-character alphabet without I, L, O or U", () => {
    expect(DISPLAY_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(DISPLAY_CODE_ALPHABET).size).toBe(32);
    expect(DISPLAY_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(DISPLAY_CODE_LENGTH).toBe(6);
    for (let i = 0; i < 500; i++) {
      expect(newDisplayCode("ONB")).toMatch(/^ONB-[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  it("draws each character from one random byte, unbiased (256 is a multiple of 32)", () => {
    // 0 → '0', 31 → 'Z', 32 → '0' again, 255 → 'Z'.
    expect(newDisplayCode("EIR", bytes(10, 31, 32, 255, 42, 17))).toBe("EIR-AZ0ZAH");
  });

  it("never draws an all-digit code, which would read like an old counter number", () => {
    // The first six bytes spell 104211; the next six don't.
    expect(newDisplayCode("EIR", bytes(1, 0, 4, 2, 1, 1, 7, 20, 3, 19, 15, 13))).toBe("EIR-7M3KFD");
  });

  it("labels a record by its code, or by its old number when it has no code", () => {
    expect(displayLabel("ONB", { display_code: "ONB-7K3QFD", display_number: null })).toBe(
      "ONB-7K3QFD",
    );
    expect(displayLabel("ONB", { display_code: null, display_number: 1000 })).toBe("ONB-1000");
    expect(displayLabel("EIR", { display_number: "1042" })).toBe("EIR-1042");
    expect(displayLabel("EIR", {})).toBeUndefined();
  });

  it("reads a quoted label back as a code or an old number, forgivingly", () => {
    expect(parseDisplayLabel("ONB", "ONB-7K3QFD")).toEqual({ code: "ONB-7K3QFD" });
    // Lower case and Crockford's look-alikes, as a person might type them.
    expect(parseDisplayLabel("ONB", " onb-7k3qfd ")).toEqual({ code: "ONB-7K3QFD" });
    expect(parseDisplayLabel("EIR", "EIR-7KIQFO")).toEqual({ code: "EIR-7K1QF0" });
    expect(parseDisplayLabel("ONB", "ONB-1000")).toEqual({ number: 1000 });
    expect(parseDisplayLabel("EIR", "EIR-1042")).toEqual({ number: 1042 });
    for (const bad of ["ONB-", "ONB-7K3QF", "ONB-7K3QFDX", "ONB-7K3QF!", "EIR-7K3QFD", "7K3QFD"]) {
      expect(parseDisplayLabel("ONB", bad)).toBeUndefined();
    }
  });
});
