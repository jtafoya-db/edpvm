// @vitest-environment node
/**
 * The staff app's EIR definition check (#201): `POST /api/eir-definitions/check`
 * validates a Safeguards author's YAML and previews it, on the server, with the
 * #200 definition service. Nothing it does publishes or activates.
 */
import { describe, expect, it } from "vitest";

import { readBootstrapEirSource } from "../../data/eir/definition/bootstrap-source.ts";
import type { AppSurface, SessionUser } from "../delta/registry.ts";
import { handleEirDefinitionCheckRequest } from "../eir-definition-check.ts";

const person = (principalId: string, roles: Partial<SessionUser> = {}): SessionUser => ({
  principalId,
  displayName: `Person ${principalId}`,
  email: `p${principalId}@example.gov`,
  isAdmin: false,
  onboardingReviewerRoles: [],
  isSafeguardsValidator: false,
  ...roles,
});

const SAFEGUARDS = person("4001", { isSafeguardsValidator: true });
const BOOTSTRAP = readBootstrapEirSource("bootstrap")!;

function check(yaml: unknown, user: SessionUser = SAFEGUARDS, serves: AppSurface[] = ["staff"]) {
  return handleEirDefinitionCheckRequest(
    new Request("https://app/api/eir-definitions/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceYaml: yaml }),
    }),
    { resolveUser: async () => user, serves },
  );
}

describe("POST /api/eir-definitions/check", () => {
  it("validate returns parse/schema/semantic diagnostics with locations", async () => {
    const parse = await (await check("form: [\n  title: x\n")).json();
    expect(parse).toMatchObject({ ok: false, publishable: false });
    expect(parse.diagnostics[0]).toMatchObject({ code: "parse-error", line: expect.any(Number) });

    const schema = await (
      await check(BOOTSTRAP.replace("validityDays: 365", "validityDays: 365\ncolour: blue"))
    ).json();
    expect(schema.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown-key", path: ["colour"], line: 24 }),
    ]);

    const semantic = await (
      await check(BOOTSTRAP.replace("field: ndaSigned", "field: ndaSignedd"))
    ).json();
    expect(semantic).toMatchObject({ ok: false, publishable: false });
    expect(semantic.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing-reference", path: ["rules", 6, "field"] }),
    );
  });

  it("preview renders the form and runs all scenarios without publishing or activating", async () => {
    const preview = await (await check(BOOTSTRAP)).json();
    expect(preview).toMatchObject({
      ok: true,
      publishable: true,
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      // Not published, so not numbered (#224).
      definition: { form: { version: "unpublished" } },
    });
    expect(preview.definition.form.sections.map((s: { id: string }) => s.id)).toEqual([
      "user",
      "manager",
      "compliance",
    ]);
    expect(
      preview.scenarios.map((s: { id: string; actual: string; ok: boolean }) => [
        s.id,
        s.actual,
        s.ok,
      ]),
    ).toEqual([
      ["pass", "pass", true],
      ["blocking-user-id", "blocking", true],
      ["warning-mbi-dates", "warning", true],
      ["manual-review-nda", "manual-review", true],
    ]);

    // A scenario that doesn't produce what it declares: it loads, but can't be published.
    const wrong = await (
      await check(BOOTSTRAP.replace('ndaSigned: "no"', 'ndaSigned: "yes"'))
    ).json();
    expect(wrong).toMatchObject({ ok: true, publishable: false });
    expect(wrong.scenarios.find((s: { id: string }) => s.id === "manual-review-nda")).toMatchObject(
      {
        expected: "manual-review",
        actual: "pass",
        ok: false,
      },
    );
  });
});

describe("POST /api/eir-definitions/check with scenarios that have no clocks (#217 schema review)", () => {
  it("answers 200 with diagnostics, not a 500", async () => {
    const yaml = BOOTSTRAP.replace(
      '    formStartedAt: "2026-09-01"\n    submittedAt: "2026-09-02"\n',
      "",
    );
    expect(yaml).not.toContain("submittedAt");
    const response = await check(yaml);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      publishable: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "invalid-value", path: ["scenarios", 0, "submittedAt"] }),
      ]),
    });
  });
});
