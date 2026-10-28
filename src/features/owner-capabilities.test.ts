import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FEATURES } from "./registry";

// #103 follow-up A (#260): the registry says exactly what's real about owners.
// Myself is verified from sign-in, Someone else is format-checked and not
// verified, a staff match is entered by staff and not verified, and there is
// no directory lookup until #249.
describe("owner capabilities", () => {
  it("lists choosing owners at intake as live, with each choice's verification", () => {
    const owners = FEATURES["intake-owners"];

    expect(owners.status).toBe("live");
    expect(owners.notes).toMatch(/initiative point of contact/i);
    expect(owners.notes).toMatch(/dataset/i);
    expect(owners.notes).toMatch(/Myself is verified from the account they're signed in with/);
    expect(owners.notes).toMatch(/Someone else/);
    expect(owners.notes).toMatch(/checked for format only/);
    expect(owners.notes).toMatch(/not verified/);
    expect(owners.notes).toMatch(/doesn't make them a dataset owner/);
    expect(owners.notes).toMatch(/owner-matching/);
    expect(owners.notes).toMatch(/owner-directory-verification/);
    expect(owners.notes).not.toMatch(/search|look(ed)? up/i);
  });

  it("lists staff matching as live, entered by staff and not verified, with no pending #269", () => {
    const matching = FEATURES["owner-matching"];

    expect(matching.status).toBe("live");
    expect(matching.notes).toMatch(/Databricks account ID/);
    expect(matching.notes).toMatch(/entered by staff, not verified/);
    expect(matching.notes).toMatch(/direct members of the EDP admin group/);
    expect(matching.notes).not.toMatch(/#269/);
  });

  it("lists directory lookup as planned on #249, not built", () => {
    const directory = FEATURES["owner-directory-verification"];

    expect(directory.status).toBe("planned");
    expect(directory.phase).toBeGreaterThan(0);
    expect(directory.notes).toMatch(/#249/);
    expect(directory.notes).toMatch(/Databricks account ID/);
  });
});

describe("GLOSSARY: Initiative point of contact", () => {
  const glossary = readFileSync(join(process.cwd(), "GLOSSARY.md"), "utf8");
  const entry = /\*\*Initiative point of contact\*\*:\n([^\n]+)\n_Avoid_: ([^\n]+)/.exec(glossary);

  it("defines an initiative point of contact, distinct from a dataset owner", () => {
    expect(entry).not.toBeNull();
    const [, definition, avoid] = entry!;
    expect(definition).toMatch(/initiative/);
    expect(definition).toMatch(/shepherds the request/);
    expect(definition).toMatch(/Myself/);
    expect(definition).toMatch(/isn't a dataset owner/);
    expect(definition).toMatch(/standup/i);
    expect(avoid).toMatch(/Initiative owner/);
    expect(avoid).toMatch(/Dataset owner/);
  });
});
