import { describe, expect, it } from "vitest";

import { isDigitIdentifier, isPersonName } from "../person-name";

const IDS = { email: "Casey.Rivera@example.gov", usernames: ["crivera", undefined, null] };

describe("isPersonName — the one identifier-shaped predicate (server and client)", () => {
  it.each([
    ["blank", ""],
    ["whitespace", "   "],
    ["an email", "someone@example.gov"],
    ["the numeric <userId>@<workspaceId>", "1234567890123456@7890123456789012"],
    ["all digits", "1234567890"],
    ["fullwidth digits", "１２３４"],
    ["Arabic-Indic digits", "١٢٣٤"],
    ["mixed-script digits", "12١٢３"],
    ["space-separated digits", "١٢٣٤ ٥٦٧٨"],
    ["the spaced Unicode-digit '@' form", "١٢٣٤ ٥٦٧٨@٩٠١٢ ٣٤٥٦"],
    ["the Unicode-digit <userId>@<workspaceId>", "１２３４@５６７８"],
    ["the email, any case", " casey.rivera@example.gov "],
    ["the email's local part", "CASEY.RIVERA"],
    ["the username", "CRivera"],
  ])("is not a person name: %s", (_label, value) => {
    expect(isPersonName(value, IDS)).toBe(false);
  });

  it("rejects absent values", () => {
    expect(isPersonName(undefined, IDS)).toBe(false);
    expect(isPersonName(null, IDS)).toBe(false);
  });

  it.each([["Casey Rivera"], ["Cher"], ["Rivera"], ["O'Brien-Smith"]])(
    "is a person name: %s",
    (value) => {
      expect(isPersonName(value, IDS)).toBe(true);
    },
  );

  it("needs no identifiers to reject the structural shapes", () => {
    expect(isPersonName("a@b", {})).toBe(false);
    expect(isPersonName("Casey", {})).toBe(true);
  });

  it("known limit: a real name that equals the username or email local part is not a name", () => {
    expect(isPersonName("Cher", { email: "cher@example.gov" })).toBe(false);
  });
});

describe("isDigitIdentifier — the one digit-shaped id rule (any script)", () => {
  it.each([
    ["1234567890"],
    ["1234567890123456@7890123456789012"],
    ["１２３４"],
    ["١٢٣٤ ٥٦٧٨"],
    ["１２３４ ５６７８@９０１２"],
    ["  12١٢３  "],
  ])("is an identifier: %s", (value) => {
    expect(isDigitIdentifier(value)).toBe(true);
  });

  it.each([[""], ["   "], ["@"], ["1234@"], ["@1234"], ["1234@5678@90"], ["Casey 2"], ["crivera"]])(
    "is not a digit identifier: %j",
    (value) => {
      expect(isDigitIdentifier(value)).toBe(false);
    },
  );
});
