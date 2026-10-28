// Who counts as a sample requester (#312). Matching only: the server refuses
// to add one outside sample mode, so an alias of a sample's email mustn't
// slip through. Nothing stored is changed by this.
import { describe, expect, it } from "vitest";

import { isSampleRequester, SAMPLE_REQUESTERS } from "../access-requests/seed";

describe("isSampleRequester", () => {
  it.each([
    ["the seed email", "priya.natarajan@example.gov"],
    ["mixed case", "Priya.NATARAJAN@Example.Gov"],
    ["padding", "  tom.becker@example.gov\t"],
    ["a +tag alias", "priya.natarajan+tag@example.gov"],
    ["a +tag alias in mixed case", "Tom.Becker+Pilot.2026@EXAMPLE.gov"],
    ["an empty +tag", "tom.becker+@example.gov"],
    ["a fullwidth lookalike (NFKC)", "ｐｒｉｙａ.natarajan@ｅｘａｍｐｌｅ.gov"],
    ["a mathematical-letter lookalike (NFKC)", "𝐭𝐨𝐦.becker@example.gov"],
    ["a fullwidth plus and at (NFKC)", "priya.natarajan＋x＠example.gov"],
  ])("matches %s", (_label, email) => {
    expect(isSampleRequester({ email })).toBe(true);
  });

  it.each([
    ["someone else", "pat.owner@example.gov"],
    ["the same local part elsewhere", "priya.natarajan@other.example.gov"],
    ["a longer local part", "priya.natarajan2@example.gov"],
    ["a different domain", "tom.becker@example.gov.evil"],
    ["empty", ""],
  ])("doesn't match %s", (_label, email) => {
    expect(isSampleRequester({ email })).toBe(false);
  });

  it("matches the seed principal IDs exactly", () => {
    for (const sample of SAMPLE_REQUESTERS) {
      expect(isSampleRequester({ principalId: sample.principalId })).toBe(true);
    }
    expect(isSampleRequester({ principalId: "seed-dana-whitfield" })).toBe(false);
    expect(isSampleRequester({ principalId: null, email: null })).toBe(false);
  });
});
