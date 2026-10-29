// @vitest-environment node
/**
 * #204's durable evaluation order: every recorded pre-check of a draft gets
 * the next `evaluation_sequence` in the block that writes it, so "the
 * latest" is the one written last, even when two share a millisecond (their
 * `occurred_at` ties and their IDs are random UUIDs). Rows from before the
 * column existed have none; they're older than every row that has one.
 */
import { describe, expect, it } from "vitest";

import { evaluateEirDraft } from "../../../data/eir/evaluation.ts";
import type { EirEvaluation } from "../../../data/eir/types";
import {
  APPLICANT,
  createClock,
  deltaImplementation,
  ON_BOOTSTRAP_1,
  VALUES,
} from "./eir-harness.ts";

/** An evaluator whose outcome is the next in `outcomes`, round and round. */
function scripted(outcomes: EirEvaluation["outcome"][]) {
  let calls = 0;
  return (input: Parameters<typeof evaluateEirDraft>[0]): EirEvaluation => {
    const outcome = outcomes[calls++ % outcomes.length]!;
    return { ...evaluateEirDraft(input), outcome, automaticValidityEligible: false };
  };
}

describe("EIR evaluation sequence (#204)", () => {
  it("the latest of several pre-checks in the same millisecond is the one recorded last", async () => {
    const impl = deltaImplementation(createClock(), {
      ...ON_BOOTSTRAP_1,
      evaluator: scripted(["pass", "manual-review", "warning", "manual-review"]),
    });
    const repository = impl.as(APPLICANT);
    await repository.saveDraft(APPLICANT.principalId, VALUES);
    for (let i = 0; i < 8; i++) {
      // The clock never moves: every row's occurred_at is the same.
      const evaluated = await repository.evaluateDraft(APPLICANT.principalId);
      expect(evaluated.sequence).toBe(i + 1);
      const reloaded = await impl.fresh(APPLICANT).get(APPLICANT.principalId);
      expect(reloaded.evaluation).toMatchObject({ outcome: evaluated.outcome, sequence: i + 1 });
    }
    expect(
      impl.warehouse.query(
        `SELECT evaluation_sequence AS n FROM eir__eir_evaluations ORDER BY evaluation_sequence`,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ n })));
  });

  it("two pre-checks of one draft at once get different sequence numbers", async () => {
    const impl = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    const release = impl.warehouse.hold();
    const racing = [impl.fresh(APPLICANT), impl.fresh(APPLICANT)].map((repository) =>
      repository.evaluateDraft(APPLICANT.principalId),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const sequences = (await Promise.all(racing)).map((evaluation) => evaluation.sequence).sort();
    expect(sequences).toEqual([1, 2]);
    expect(impl.warehouse.conflicts).toBeGreaterThanOrEqual(1);
  });

  it("on a store upgraded in place, a pre-check from before the column is older than any after it", async () => {
    // Several stores, because without the sequence a tie falls to random UUIDs.
    for (let attempt = 0; attempt < 8; attempt++) {
      const impl = deltaImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        evaluator: scripted(["manual-review", "pass"]),
      });
      const repository = impl.as(APPLICANT);
      await repository.saveDraft(APPLICANT.principalId, VALUES);
      await repository.evaluateDraft(APPLICANT.principalId);
      // As the upgrade leaves a row written before it: no sequence.
      impl.warehouse.query(`UPDATE eir__eir_evaluations SET evaluation_sequence = NULL`);
      // Recorded after the upgrade, in the same millisecond.
      const after = await repository.evaluateDraft(APPLICANT.principalId);
      expect(after).toMatchObject({ outcome: "pass", sequence: 1 });
      expect((await impl.fresh(APPLICANT).get(APPLICANT.principalId)).evaluation).toMatchObject({
        outcome: "pass",
        sequence: 1,
      });
    }
  });
});
