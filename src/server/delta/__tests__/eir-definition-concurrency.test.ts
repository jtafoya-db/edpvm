// @vitest-environment node
/**
 * Overlapping EIR definition commands and reads (#210 review round 8). The
 * reads a command or the history read sends together are separate
 * statements, so on Delta each can see a different commit. These tests
 * force that: one of a request's reads runs at once, the rest wait until
 * another command has landed.
 */
import { describe, expect, it } from "vitest";

import type { EirDefinitionActivation } from "../../../data/eir/definition/repository.ts";
import {
  definitionImplementation,
  memoryDefinitions,
  nextDefinitionYaml,
  SAFEGUARDS,
  SAFEGUARDS_TWO,
  type DeltaDefinitionImplementation,
} from "./eir-definition-harness.ts";

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/**
 * The next request's reads, split in time: those `now` matches read the
 * store as it is when they arrive; the others (but its idempotency lookup
 * and its block) wait for `release`, and read it as it is then.
 */
function splitReads(impl: DeltaDefinitionImplementation, now: (statement: string) => boolean) {
  const client = impl.warehouse.client;
  const execute = client.execute.bind(client);
  const gate = held();
  const early = held();
  let request: string | undefined;
  client.execute = async <T extends object>(...[statement, tag]: Parameters<typeof execute>) => {
    const id = "actionId" in tag ? tag.actionId : tag.readId;
    request ??= id;
    const sql = statement.statement;
    if (id === request && !sql.includes("BEGIN ATOMIC")) {
      if (now(sql)) {
        const result = await execute<T>(statement, tag);
        early.release();
        return result;
      }
      if (!/WHERE idempotency_key = :key/.test(sql)) await gate.promise;
    }
    return execute<T>(statement, tag);
  };
  return { ranEarly: early.promise, release: gate.release };
}

/** Each activation's rollback flag is whether its version was activated before it. */
function expectRollbackFlagsMatchHistory(activations: EirDefinitionActivation[]) {
  const oldestFirst = [...activations].reverse();
  oldestFirst.forEach((activation, i) => {
    const before = oldestFirst
      .slice(0, i)
      .some((a) => a.versionNumber === activation.versionNumber);
    expect({ versionNumber: activation.versionNumber, rollback: activation.rollback }).toEqual({
      versionNumber: activation.versionNumber,
      rollback: before,
    });
  });
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string; status?: number }) => ({ ok: false as const, error }),
  );

describe("overlapping EIR definition activations", () => {
  it("Delta: an activation of the same version that lands between a command's reads never leaves a wrong rollback flag", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(SAFEGUARDS);
    const other = impl.as(SAFEGUARDS_TWO);
    for (const [n, expectedVersion] of [
      [2, 0],
      [3, 1],
      [4, 2],
    ] as const) {
      await repo.publish({ sourceYaml: nextDefinitionYaml(n), expectedVersion });
    }

    // Version 1's earlier activations are counted now (none yet); the register,
    // versions and target are read after two other activations have landed.
    const { ranEarly, release } = splitReads(impl, (sql) =>
      /count\(\*\) AS n FROM .* WHERE action = 'activated'/.test(sql),
    );
    const ours = settle(repo.activate({ versionNumber: 1, expectedVersion: 5 }));
    await ranEarly;
    await other.activate({ versionNumber: 1, expectedVersion: 3 });
    await other.activate({ versionNumber: 2, expectedVersion: 4 });
    release();
    const outcome = await ours;

    const { activations } = await repo.history();
    expectRollbackFlagsMatchHistory(activations);
    if (outcome.ok) {
      expect(activations[0]).toMatchObject({ versionNumber: 1, rollback: true });
    } else {
      // Refused as stale, with nothing written: the person reloads and sees why.
      expect(outcome.error).toMatchObject({ code: "version-conflict", status: 409 });
      expect(activations.map((a) => a.versionNumber)).toEqual([2, 1]);
    }
  });

  it.each([
    ["memory", memoryDefinitions],
    ["delta", definitionImplementation],
  ] as const)(
    "%s: two activations sent at once leave rollback flags that match the history",
    async (_name, make) => {
      const impl = make();
      const repo = impl.as(SAFEGUARDS);
      await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
      await repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
      await repo.activate({ versionNumber: 1, expectedVersion: 2 });
      await repo.activate({ versionNumber: 2, expectedVersion: 3 });

      // Both roll back to version 1 from the same state: one lands, one is stale.
      const outcomes = await Promise.all([
        settle(repo.activate({ versionNumber: 1, expectedVersion: 4 })),
        settle(impl.as(SAFEGUARDS_TWO).activate({ versionNumber: 1, expectedVersion: 4 })),
      ]);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      const { activations } = await repo.history();
      expect(activations).toHaveLength(3);
      expectRollbackFlagsMatchHistory(activations);
      expect(activations[0]).toMatchObject({ versionNumber: 1, rollback: true });
    },
  );
});

describe("the history read (Delta)", () => {
  it("never pairs the active version with an activation list from another commit", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(SAFEGUARDS);
    await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    await repo.activate({ versionNumber: 1, expectedVersion: 2 });

    // The activation list is read now (version 1 only); the register after version 2 is activated.
    const { ranEarly, release } = splitReads(impl, (sql) =>
      /WHERE action = 'activated' ORDER BY/.test(sql),
    );
    const read = repo.history();
    await ranEarly;
    await impl.as(SAFEGUARDS_TWO).activate({ versionNumber: 2, expectedVersion: 3 });
    release();
    const history = await read;

    expect(history.active).toMatchObject({ source: "published", versionNumber: 2 });
    expect(history.version).toBe(4);
    expect(history.activations.map((a) => a.versionNumber)).toEqual([2, 1]);
  });
});
