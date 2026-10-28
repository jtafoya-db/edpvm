// @vitest-environment node
/**
 * #235: the browser's instant pre-check runs the shared rule engine
 * (`evaluateEirRules`) on the screen's answers, on the clock the server
 * would use, and answers "blocking" only when the server is certain to block
 * the same way. Anything else (a pass, a warning, a rule it can't run, a
 * result that depends on which side of midnight UTC the server's clock is)
 * goes to the server. Expected outcomes are written by hand from the
 * bootstrap-2 definition (#217): every rule blocks.
 */
import { describe, expect, it } from "vitest";

import { readBootstrapEirSource } from "../eir/definition/bootstrap-source.ts";
import { builtInById } from "../eir/definition/built-in.ts";
import { loadDefinition } from "../eir/definition/load.ts";
import type { EirDefinition } from "../eir/definition/types.ts";
import { createMemoryEirRepository } from "../eir/repository.ts";
import { preflightEir } from "../eir/preflight.ts";
import type { EirFormValues } from "../eir/types.ts";

const BOOTSTRAP_2 = builtInById("bootstrap-2")!;

/** Every bootstrap-2 rule met on 2026-10-01 (training within a year, MBI current). */
const PASSING: EirFormValues = {
  userId: "TST0001",
  firstName: "Test",
  lastName: "Person",
  workEmail: "test.person@example.gov",
  team: "Synthetic Team",
  subTeam: "",
  contractingCompany: "",
  managerFirstName: "Sample",
  managerLastName: "Manager",
  managerId: "TST0002",
  managerEmail: "sample.manager@example.gov",
  unauthorizedAccessTrainingDate: "2026-06-01",
  privacyTrainingDate: "2026-06-01",
  cyberAwarenessTrainingDate: "2026-06-01",
  irmAcknowledged: "yes",
  ndaSigned: "yes",
  mbiInitialDate: "2025-01-15",
  mbiExpirationDate: "2030-01-15",
  mbiPreliminary: "no",
  declarationAgreed: "yes",
};

const NOON = new Date("2026-10-01T12:00:00.000Z");

describe("preflightEir: the instant pre-check (#235)", () => {
  it("blocks an unsigned NDA at once, with the rule's reason code and guidance", () => {
    const result = preflightEir({
      definition: BOOTSTRAP_2,
      values: { ...PASSING, ndaSigned: "no" },
      draftVersion: 0,
      now: NOON,
    });
    expect(result).toMatchObject({
      outcome: "blocking",
      evaluation: {
        definitionVersion: "bootstrap-2",
        effectiveAt: "2026-10-01T12:00:00.000Z",
        outcome: "blocking",
        outcomes: [
          {
            field: "ndaSigned",
            reasonCode: "EIR-NDA-NOT-SIGNED",
            disposition: "blocking",
            guidance: "[Placeholder wording] Sign the IRS NDA, then answer Yes.",
          },
        ],
      },
    });
  });

  /** The server's answer: the memory repository's evaluation at the same instant, the rules Delta runs. */
  async function serverEvaluation(
    definition: EirDefinition,
    values: EirFormValues,
    clock: { firstSave: Date; evaluate: Date },
  ) {
    let now = clock.firstSave;
    const repository = createMemoryEirRepository({
      clock: () => now,
      definitions: { active: () => definition, byId: () => definition },
    });
    await repository.saveDraft("p-1", values);
    now = clock.evaluate;
    const saved = await repository.saveDraft("p-1", values);
    return { saved, evaluation: await repository.evaluateDraft("p-1") };
  }

  it.each([
    ["an unsigned NDA", { ndaSigned: "no" }],
    ["a malformed user ID", { userId: "not an id!" }],
    ["Privacy training over a year old", { privacyTrainingDate: "2025-09-01" }],
    ["an expired MBI", { mbiExpirationDate: "2026-09-30" }],
    ["an MBI start in the future", { mbiInitialDate: "2026-12-01" }],
    ["two failing rules", { ndaSigned: "no", mbiPreliminary: "yes" }],
  ])("blocks %s exactly as the server does on the same clock", async (_label, changed) => {
    const values = { ...PASSING, ...changed };
    const server = await serverEvaluation(BOOTSTRAP_2, values, { firstSave: NOON, evaluate: NOON });
    expect(server.evaluation.outcome).toBe("blocking");
    const result = preflightEir({ definition: BOOTSTRAP_2, values, draftVersion: 0, now: NOON });
    expect(result.outcome).toBe("blocking");
    if (result.outcome !== "blocking") return;
    expect(result.evaluation.outcomes).toEqual(server.evaluation.outcomes);
    expect(result.evaluation.definitionVersion).toBe(server.evaluation.definitionVersion);
  });

  it("sends a passing draft to the server: the browser never says pass", () => {
    expect(
      preflightEir({ definition: BOOTSTRAP_2, values: PASSING, draftVersion: 3, now: NOON }),
    ).toEqual({ outcome: "server", reason: "not-blocking" });
  });

  it("sends the draft to the server when the browser doesn't have its pinned definition", () => {
    expect(
      preflightEir({
        definition: undefined,
        values: { ...PASSING, ndaSigned: "no" },
        draftVersion: 0,
        now: NOON,
      }),
    ).toEqual({ outcome: "server", reason: "no-definition" });
  });

  it("sends the draft to the server when a rule can't run in the browser, never a pass or a block", () => {
    const unknownOperator = {
      ...BOOTSTRAP_2,
      rules: [...BOOTSTRAP_2.rules, { ...BOOTSTRAP_2.rules[0]!, operator: "newer-check" }],
    } as unknown as EirDefinition;
    expect(
      preflightEir({
        definition: unknownOperator,
        values: { ...PASSING, ndaSigned: "no" },
        draftVersion: 0,
        now: NOON,
      }),
    ).toEqual({ outcome: "server", reason: "error" });
  });

  it("near midnight UTC, an answer that blocks on one side of the day goes to the server", () => {
    // Expires 1 October. Checked at 00:05 on 2 October it has expired; ten
    // minutes earlier, on a server clock a little behind, it hasn't.
    const values = { ...PASSING, mbiExpirationDate: "2026-10-01" };
    expect(
      preflightEir({
        definition: BOOTSTRAP_2,
        values,
        draftVersion: 0,
        now: new Date("2026-10-02T00:05:00.000Z"),
      }),
    ).toEqual({ outcome: "server", reason: "uncertain" });
    // At noon the block is certain either way.
    expect(
      preflightEir({
        definition: BOOTSTRAP_2,
        values,
        draftVersion: 0,
        now: new Date("2026-10-02T12:00:00.000Z"),
      }).outcome,
    ).toBe("blocking");
  });

  describe("a form-started timeline counts from the draft's start", () => {
    // bootstrap-2 with its training timeline anchored where bootstrap and form 1.2 anchor it.
    const loaded = loadDefinition(
      readBootstrapEirSource("bootstrap-2")!.replace(
        /^(\s+)anchor: evaluated$/m,
        "$1anchor: form-started",
      ),
      "bootstrap-2",
    );
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
    const FORM_STARTED = loaded.definition;
    // Done 1 September 2025: within a year of a draft started 15 October 2025,
    // but over a year before 1 October 2026.
    const values = { ...PASSING, privacyTrainingDate: "2025-09-01" };
    const STARTED = new Date("2025-10-15T09:00:00.000Z");

    it("(the fixture really is anchored at the form's start)", () => {
      expect(FORM_STARTED.timelines.map((timeline) => timeline.anchor)).toEqual(["form-started"]);
    });

    it("a saved draft's start: the server passes it, so the browser doesn't block", async () => {
      const server = await serverEvaluation(FORM_STARTED, values, {
        firstSave: STARTED,
        evaluate: NOON,
      });
      expect(server.saved.draftStartedAt).toBe(STARTED.toISOString());
      expect(server.evaluation.outcome).toBe("pass");
      expect(
        preflightEir({
          definition: FORM_STARTED,
          values,
          savedDraftStartedAt: server.saved.draftStartedAt!,
          draftVersion: 2,
          now: NOON,
        }),
      ).toEqual({ outcome: "server", reason: "not-blocking" });
    });

    it("an unsaved draft starts with this Download: the provisional start is the click, as on the server", async () => {
      const server = await serverEvaluation(FORM_STARTED, values, {
        firstSave: NOON,
        evaluate: NOON,
      });
      expect(server.evaluation.outcome).toBe("blocking");
      const result = preflightEir({ definition: FORM_STARTED, values, draftVersion: 0, now: NOON });
      expect(result.outcome).toBe("blocking");
      if (result.outcome === "blocking") {
        expect(result.evaluation.outcomes).toEqual(server.evaluation.outcomes);
      }
    });

    it("an unsaved draft near midnight UTC: the server's start is its own clock, so a block that turns on it goes to the server", () => {
      // Done 1 October 2025: over a year before a draft started 2 October
      // 2026, but not before one started ten minutes earlier, on 1 October.
      expect(
        preflightEir({
          definition: FORM_STARTED,
          values: { ...PASSING, privacyTrainingDate: "2025-10-01" },
          draftVersion: 0,
          now: new Date("2026-10-02T00:05:00.000Z"),
        }),
      ).toEqual({ outcome: "server", reason: "uncertain" });
    });
  });
});
