// @vitest-environment node
/**
 * How many warehouse round trips in a row Publish, Activate and the history
 * read wait on (#210 UAT: Publish was slow). On example-workspace each
 * statement costs about 0.3-0.8 s, so reads that don't depend on each other
 * run together. Every write is still one `BEGIN ATOMIC` block, after the
 * runner's idempotency lookup.
 *
 * A round is a statement the warehouse starts while nothing else of the
 * request is in flight; statements sent together share one.
 */
import { describe, expect, it } from "vitest";

import {
  definitionImplementation,
  nextDefinitionYaml,
  SAFEGUARDS,
  type DeltaDefinitionImplementation,
} from "./eir-definition-harness.ts";

/** Give every statement a little latency, and count rounds and statements. */
function traced(impl: DeltaDefinitionImplementation) {
  const client = impl.warehouse.client;
  const execute = client.execute.bind(client);
  let inFlight = 0;
  let trace = { rounds: 0, statements: 0, writes: 0 };
  client.execute = async (statement, tag) => {
    if (inFlight === 0) trace.rounds += 1;
    trace.statements += 1;
    if (statement.statement.includes("BEGIN ATOMIC")) trace.writes += 1;
    inFlight += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await execute(statement, tag);
    } finally {
      inFlight -= 1;
    }
  };
  return {
    measure: async <T>(run: () => Promise<T>) => {
      trace = { rounds: 0, statements: 0, writes: 0 };
      await run();
      return trace;
    },
  };
}

describe("EIR definition round trips (Delta)", () => {
  it("the history read sends its three reads together: one round", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(SAFEGUARDS);
    await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    const { measure } = traced(impl);

    expect(await measure(() => repo.history())).toEqual({ rounds: 1, statements: 3, writes: 0 });
  });

  it("publish: the idempotency lookup, then the register and versions together, then one block", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(SAFEGUARDS);
    const { measure } = traced(impl);

    // The first publish creates the register; a later one updates it.
    expect(
      await measure(() => repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 })),
    ).toEqual({ rounds: 3, statements: 4, writes: 1 });
    expect(
      await measure(() => repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 })),
    ).toEqual({ rounds: 3, statements: 4, writes: 1 });
    expect((await repo.history()).versions.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it("activate and roll back: the idempotency lookup, then every read together, then one block", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(SAFEGUARDS);
    await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    const { measure } = traced(impl);

    for (const [versionNumber, expectedVersion] of [
      [1, 2],
      [2, 3],
      [1, 4], // the rollback
    ] as const) {
      expect(await measure(() => repo.activate({ versionNumber, expectedVersion }))).toEqual({
        rounds: 3,
        statements: 6,
        writes: 1,
      });
    }
    const history = await repo.history();
    expect(history.activations.map((a) => [a.versionNumber, a.rollback])).toEqual([
      [1, true],
      [2, false],
      [1, false],
    ]);
  });
});
