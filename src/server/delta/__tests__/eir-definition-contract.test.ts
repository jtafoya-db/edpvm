// @vitest-environment node
/**
 * The EIR definition publication contract (#201), run against both
 * repositories: the in-memory one and the Delta one (browser client → Delta
 * API → runner → `eir-definitions` area → SQLite fake warehouse built from
 * `resources/store-eir-definitions.sql`). Each rule is one test, run twice.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MAX_EIR_DEFINITION_BYTES } from "../../../data/eir/definition/check.ts";

import {
  BOOTSTRAP_YAML,
  definitionImplementation,
  EDP_STAFF,
  EMPLOYEE,
  memoryDefinitions,
  nextDefinitionYaml,
  sameQuestionsYaml,
  SAFEGUARDS,
  SAFEGUARDS_TWO,
  type DefinitionImplementation,
} from "./eir-definition-harness.ts";

/** The size limit, pinned here on its own: 256 KiB in UTF-8 bytes (#201 review). */
const LIMIT_BYTES = 262144;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Start `commands` from the same state: on Delta, the warehouse holds them until all arrive. */
async function race<T>(impl: DefinitionImplementation, commands: (() => Promise<T>)[]) {
  if (impl.name !== "delta") return Promise.allSettled(commands.map((run) => run()));
  const { warehouse } = impl as ReturnType<typeof definitionImplementation>;
  const blocks = () => warehouse.statements.filter((s) => s.startsWith("BEGIN ATOMIC")).length;
  const before = blocks();
  const release = warehouse.hold();
  const running = commands.map((run) => run());
  // Release only once every command's block is waiting at the gate.
  for (let waited = 0; blocks() < before + commands.length && waited < 5_000; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  release();
  return Promise.allSettled(running);
}

const codeOf = (outcome: PromiseSettledResult<unknown>) =>
  outcome.status === "fulfilled" ? "ok" : (outcome.reason as { code?: string }).code;

describe.each([
  ["memory", memoryDefinitions],
  ["delta", definitionImplementation],
] as const)("EIR definition publication contract: %s", (_name, make) => {
  it("publish stores source YAML, normalized definition, content hash, actor, actor app, time as a new immutable version", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    expect(await repo.history()).toEqual({
      version: 0,
      active: { source: "bootstrap", id: "bootstrap-2" },
      versions: [],
      activations: [],
    });

    const yaml = nextDefinitionYaml(2);
    // The reply names the content the server stored, so the screen can say so (#210 UAT).
    expect(await repo.publish({ sourceYaml: yaml, expectedVersion: 0 })).toEqual({
      versionNumber: 1,
      version: 1,
      contentSha256: sha256(yaml),
    });

    const history = await repo.history();
    expect(history).toEqual({
      version: 1,
      // Publishing never activates.
      active: { source: "bootstrap", id: "bootstrap-2" },
      versions: [
        {
          versionNumber: 1,
          contentSha256: sha256(yaml),
          publishedAt: "2026-10-01T12:00:00.000Z",
          publishedBy: { principalId: "4001", display: "Sara Safeguards", app: "staff" },
        },
      ],
      activations: [],
    });
    const published = await repo.get(1);
    expect(published.sourceYaml).toBe(yaml);
    // The definition is named by the number the server gave it (#224).
    expect(published.definition.form.version).toBe("1");
    expect(published.definition.form.sections[0]!.title).toBe("User details (v2)");
    expect(published.contentSha256).toBe(sha256(yaml));
    expect(BOOTSTRAP_YAML).not.toBe(yaml);
  });

  it("numbers each publish itself: the same questions under other rules are versions 1 and 2 (#224)", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    const first = sameQuestionsYaml("mbi-investigation-complete");
    const second = sameQuestionsYaml("mbi-investigation-complete", "irm-acknowledged");
    expect(await repo.publish({ sourceYaml: first, expectedVersion: 0 })).toEqual(
      expect.objectContaining({ versionNumber: 1, version: 1 }),
    );
    expect(await repo.publish({ sourceYaml: second, expectedVersion: 1 })).toEqual(
      expect.objectContaining({ versionNumber: 2, version: 2 }),
    );
    const [one, two] = [await repo.get(1), await repo.get(2)];
    expect([one.definition.form.version, two.definition.form.version]).toEqual(["1", "2"]);
    const questions = (d: typeof one) =>
      d.definition.form.sections.flatMap((section) =>
        section.fields.map(({ id, label, kind, required }) => [id, label, kind, required]),
      );
    expect(questions(two)).toEqual(questions(one));
    const irm = (d: typeof one) => d.definition.rules.find((r) => r.id === "irm-acknowledged");
    expect([irm(one)?.disposition, irm(two)?.disposition]).toEqual(["manual-review", "warning"]);
    // Publishing the bootstrap's own YAML is a new number too, never the bootstrap's identity.
    expect(await repo.publish({ sourceYaml: BOOTSTRAP_YAML, expectedVersion: 2 })).toEqual(
      expect.objectContaining({ versionNumber: 3 }),
    );
    expect((await repo.get(3)).definition.form.version).toBe("3");
    expect((await repo.history()).versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it("refuses a definition over the size limit in UTF-8 bytes, and takes one exactly at it", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    const yaml = nextDefinitionYaml(2);
    // A YAML comment of "é" (2 bytes each, 1 UTF-16 unit) fills it to the byte.
    const bytes = (text: string) => Buffer.byteLength(text, "utf8");
    expect(MAX_EIR_DEFINITION_BYTES).toBe(LIMIT_BYTES);
    const room = LIMIT_BYTES - bytes(yaml) - bytes("# \n");
    const atLimit = `${yaml}# ${"é".repeat(Math.floor(room / 2))}${room % 2 ? "a" : ""}\n`;
    expect(bytes(atLimit)).toBe(LIMIT_BYTES);
    // Under the limit counted in UTF-16 units: only bytes say it's over.
    const over = `${atLimit}a`;
    expect(over.length).toBeLessThan(LIMIT_BYTES);
    const tooLarge = { code: "definition-too-large", status: 400 };
    await expect(repo.check(over)).rejects.toMatchObject(tooLarge);
    await expect(repo.publish({ sourceYaml: over, expectedVersion: 0 })).rejects.toMatchObject(
      tooLarge,
    );
    expect((await repo.history()).versions).toEqual([]);
    expect(await repo.check(atLimit)).toMatchObject({ ok: true, publishable: true });
    expect(await repo.publish({ sourceYaml: atLimit, expectedVersion: 0 })).toEqual({
      versionNumber: 1,
      version: 1,
      contentSha256: sha256(atLimit),
    });
    expect((await repo.get(1)).sourceYaml).toBe(atLimit);
  });

  it("published versions cannot be edited or deleted", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    // The public surface has no edit or delete.
    expect(Object.keys(repo).sort()).toEqual(["activate", "check", "get", "history", "publish"]);
    const first = nextDefinitionYaml(2);
    await repo.publish({ sourceYaml: first, expectedVersion: 0 });
    const before = await repo.get(1);
    await repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    await repo.activate({ versionNumber: 2, expectedVersion: 2 });
    expect(await repo.get(1)).toEqual(before);

    if (impl.name === "delta") {
      const { deps, warehouse } = impl as ReturnType<typeof definitionImplementation>;
      const writes = deps.registry
        .list()
        .writes.filter((w) => w.area === "eir-definitions")
        .map((w) => w.name);
      expect(writes.sort()).toEqual(["activate", "publish"]);
      // The tables refuse it too (`delta.appendOnly`), whoever writes.
      expect(() =>
        warehouse.query(`UPDATE "eir__eir_definition_versions" SET source_yaml = 'x'`),
      ).toThrow(/append-only/);
      expect(() => warehouse.query(`DELETE FROM "eir__eir_definition_versions"`)).toThrow(
        /append-only/,
      );
      expect(() => warehouse.query(`DELETE FROM "eir__eir_definition_actions"`)).toThrow(
        /append-only/,
      );
      expect((await repo.get(1)).sourceYaml).toBe(first);
    }
  });

  it("invalid definition cannot be published", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    const empty = await repo.history();
    await expect(
      repo.publish({ sourceYaml: "form: [\n", expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "definition-invalid", status: 400 });
    await expect(
      repo.publish({
        sourceYaml: nextDefinitionYaml(2).replace("field: ndaSigned", "field: nothing"),
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "definition-invalid", status: 400 });
    // It loads, but a scenario doesn't produce what it declares.
    await expect(
      repo.publish({
        sourceYaml: nextDefinitionYaml(2).replace('ndaSigned: "no"', 'ndaSigned: "yes"'),
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "scenarios-failed", status: 400 });
    // A stale copy that still names its own version is refused, never published under it (#224).
    for (const stale of [
      `definitionVersion: safeguards-2\n${nextDefinitionYaml(2)}`,
      nextDefinitionYaml(2).replace("form:\n", 'form:\n  version: "1.4"\n'),
    ]) {
      await expect(repo.check(stale)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "server-assigned-version" })],
      });
      await expect(repo.publish({ sourceYaml: stale, expectedVersion: 0 })).rejects.toMatchObject({
        code: "definition-invalid",
        status: 400,
      });
    }
    expect(await repo.history()).toEqual(empty);
  });

  it("activate accepts only a published valid version and appends an action", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    await expect(repo.activate({ versionNumber: 1, expectedVersion: 0 })).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
    await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await expect(repo.activate({ versionNumber: 2, expectedVersion: 1 })).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
    impl.clock.advance(60_000);
    expect(await repo.activate({ versionNumber: 1, expectedVersion: 1 })).toEqual({
      versionNumber: 1,
      version: 2,
    });
    const history = await repo.history();
    expect(history.active).toEqual({ source: "published", versionNumber: 1 });
    expect(history.activations).toEqual([
      {
        versionNumber: 1,
        previousVersionNumber: null,
        rollback: false,
        activatedAt: "2026-10-01T12:01:00.000Z",
        activatedBy: { principalId: "4001", display: "Sara Safeguards", app: "staff" },
      },
    ]);
    await expect(repo.activate({ versionNumber: 1, expectedVersion: 2 })).rejects.toMatchObject({
      code: "already-active",
      status: 409,
    });
    expect((await repo.history()).version).toBe(2);

    if (impl.name === "delta") {
      const { warehouse } = impl as ReturnType<typeof definitionImplementation>;
      expect(
        warehouse.query(
          `SELECT action, from_active_version, to_active_version, definition_version_number, record_version, actor_principal_id, actor_app FROM "eir__eir_definition_actions" ORDER BY record_version`,
        ),
      ).toEqual([
        {
          action: "published",
          // The built-in in use while nothing published is active (#217, #224).
          from_active_version: "bootstrap-2",
          to_active_version: "bootstrap-2",
          definition_version_number: 1,
          record_version: 1,
          actor_principal_id: "4001",
          actor_app: "staff",
        },
        {
          action: "activated",
          from_active_version: "bootstrap-2",
          to_active_version: "1",
          definition_version_number: 1,
          record_version: 2,
          actor_principal_id: "4001",
          actor_app: "staff",
        },
      ]);
    }
  });

  it("activation re-runs every scenario: a stored version that no longer passes can't be activated", async () => {
    // Published by an earlier app; today's rules give its NDA scenario another outcome.
    const stale = nextDefinitionYaml(2).replace('ndaSigned: "no"', 'ndaSigned: "yes"');
    const impl = make(undefined, { storedVersions: [stale] });
    const repo = impl.as(SAFEGUARDS);
    const before = await repo.history();
    expect(before.versions.map((v) => v.versionNumber)).toEqual([1]);
    await expect(repo.activate({ versionNumber: 1, expectedVersion: 1 })).rejects.toMatchObject({
      code: "scenarios-failed",
      status: 409,
      message: expect.stringContaining("manual-review-nda"),
    });
    // No activation row, and the active definition is unchanged.
    expect(await repo.history()).toEqual(before);
  });

  it("reactivating a prior version rolls back without rewriting history", async () => {
    const impl = make();
    const repo = impl.as(SAFEGUARDS);
    await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    await repo.activate({ versionNumber: 1, expectedVersion: 2 });
    await repo.activate({ versionNumber: 2, expectedVersion: 3 });
    const before = await repo.history();

    impl.clock.advance(3_600_000);
    await repo.activate({ versionNumber: 1, expectedVersion: 4 });
    const after = await repo.history();
    expect(after.version).toBe(5);
    expect(after.active).toEqual({ source: "published", versionNumber: 1 });
    expect(after.versions).toEqual(before.versions);
    expect(after.activations[0]).toEqual({
      versionNumber: 1,
      previousVersionNumber: 2,
      rollback: true,
      activatedAt: "2026-10-01T13:00:00.000Z",
      activatedBy: { principalId: "4001", display: "Sara Safeguards", app: "staff" },
    });
    expect(after.activations.slice(1)).toEqual(before.activations);
    expect(after.activations.map((a) => [a.versionNumber, a.rollback])).toEqual([
      [1, true],
      [2, false],
      [1, false],
    ]);
  });

  it("stale or concurrent publish/activate is refused with no partial state; repeats are idempotent", async () => {
    const impl = make();
    const sara = impl.as(SAFEGUARDS);
    const sam = impl.as(SAFEGUARDS_TWO);

    // Two authors publish from the same state: one lands, the other is stale.
    const publishes = await race(impl, [
      () => sara.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 }),
      () => sam.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 0 }),
    ]);
    expect(publishes.map(codeOf).sort()).toEqual(["ok", "version-conflict"]);
    let history = await sara.history();
    expect(history.version).toBe(1);
    expect(history.versions.map((v) => v.versionNumber)).toEqual([1]);

    // A stale command is refused and changes nothing.
    await expect(
      sara.publish({ sourceYaml: nextDefinitionYaml(4), expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "version-conflict", status: 409 });
    await expect(sara.activate({ versionNumber: 1, expectedVersion: 0 })).rejects.toMatchObject({
      code: "version-conflict",
      status: 409,
    });
    expect(await sara.history()).toEqual(history);

    // A resend of the same intent with its key returns the first answer, once.
    const key = "6c1b4a52-8f0e-4c55-9a1e-0f5d6b7c8d01";
    const publish = { sourceYaml: nextDefinitionYaml(4), expectedVersion: 1, idempotencyKey: key };
    const first = await sara.publish(publish);
    expect(await sara.publish(publish)).toEqual(first);
    await expect(
      sara.publish({ ...publish, sourceYaml: nextDefinitionYaml(5) }),
    ).rejects.toMatchObject({ code: "idempotency-key-reused", status: 409 });
    const activateKey = "6c1b4a52-8f0e-4c55-9a1e-0f5d6b7c8d02";
    const activation = { versionNumber: 2, expectedVersion: 2, idempotencyKey: activateKey };
    expect(await sara.activate(activation)).toEqual({ versionNumber: 2, version: 3 });
    expect(await sara.activate(activation)).toEqual({ versionNumber: 2, version: 3 });
    history = await sara.history();
    expect(history.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(history.activations).toHaveLength(1);

    // Two activations from the same state: one lands.
    const activations = await race(impl, [
      () => sara.activate({ versionNumber: 1, expectedVersion: 3 }),
      () => sam.activate({ versionNumber: 1, expectedVersion: 3 }),
    ]);
    expect(activations.map(codeOf).sort()).toEqual(["ok", "version-conflict"]);
    history = await sara.history();
    expect(history.version).toBe(4);
    expect(history.activations).toHaveLength(2);

    if (impl.name === "delta") {
      const { warehouse } = impl as ReturnType<typeof definitionImplementation>;
      // Both races really met at commit: Delta failed one and the runner retried it.
      expect(warehouse.conflicts).toBeGreaterThanOrEqual(2);
      // Every version has its published action, and nothing else was left behind.
      expect(warehouse.query(`SELECT count(*) AS n FROM "eir__eir_definition_versions"`)).toEqual([
        { n: 2 },
      ]);
      expect(
        warehouse.query(
          `SELECT action, count(*) AS n FROM "eir__eir_definition_actions" GROUP BY action ORDER BY action`,
        ),
      ).toEqual([
        { action: "activated", n: 2 },
        { action: "published", n: 2 },
      ]);
    }
  });

  it("two publishes at once get distinct numbers or one refusal, never one number twice (#224)", async () => {
    const impl = make();
    const outcomes = await race(impl, [
      () => impl.as(SAFEGUARDS).publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 }),
      () =>
        impl.as(SAFEGUARDS_TWO).publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 0 }),
    ]);
    const numbers = outcomes.flatMap((o) =>
      o.status === "fulfilled" ? [o.value.versionNumber] : [],
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(outcomes.map(codeOf).filter((code) => code !== "ok")).toEqual(
      numbers.length === 2 ? [] : ["version-conflict"],
    );
    const { versions } = await impl.as(SAFEGUARDS).history();
    expect(versions.map((v) => v.versionNumber).sort()).toEqual([...numbers].sort());
    for (const n of numbers)
      expect((await impl.as(SAFEGUARDS).get(n)).definition.form.version).toBe(String(n));
  });

  it("non-Safeguards staff can read history but cannot validate, publish or activate", async () => {
    const impl = make();
    await impl.as(SAFEGUARDS).publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    const staff = impl.as(EDP_STAFF);
    expect((await staff.history()).versions).toHaveLength(1);
    expect((await staff.get(1)).definition.form.version).toBe("1");
    const forbidden = { code: "forbidden", status: 403 };
    await expect(staff.check(nextDefinitionYaml(3))).rejects.toMatchObject(forbidden);
    await expect(
      staff.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 }),
    ).rejects.toMatchObject(forbidden);
    await expect(staff.activate({ versionNumber: 1, expectedVersion: 1 })).rejects.toMatchObject(
      forbidden,
    );
    expect((await staff.history()).version).toBe(1);
  });

  it("anyone else can't read, validate, publish or activate", async () => {
    const impl = make();
    await impl.as(SAFEGUARDS).publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    const employee = impl.as(EMPLOYEE);
    const forbidden = { code: "forbidden", status: 403 };
    await expect(employee.history()).rejects.toMatchObject(forbidden);
    await expect(employee.get(1)).rejects.toMatchObject(forbidden);
    await expect(employee.check(BOOTSTRAP_YAML)).rejects.toMatchObject(forbidden);
    await expect(
      employee.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 }),
    ).rejects.toMatchObject(forbidden);
    await expect(employee.activate({ versionNumber: 1, expectedVersion: 1 })).rejects.toMatchObject(
      forbidden,
    );
  });
});

describe("EIR definition version numbers in the store (Delta, #224)", () => {
  const VERSIONS = `"eir__eir_definition_versions"`;
  const insertVersion = (
    impl: ReturnType<typeof definitionImplementation>,
    versionNumber: number,
    sourceYaml: string,
  ) =>
    impl.warehouse.query(
      `INSERT INTO ${VERSIONS} (id, version_number, definition_version, form_version, source_yaml, normalized_definition, content_sha256, published_action_id, published_at, published_by_principal_id, published_by_display, published_by_app, created_at) VALUES (:id, :n, :n, :n, :yaml, '{}', :sha, 'another-writer', '2026-10-01T12:00:00Z', '4002', 'Sam Second', 'staff', '2026-10-01T12:00:00Z')`,
      {
        id: `0f0f0f0f-0000-4000-8000-${String(versionNumber).padStart(12, "0")}`,
        n: versionNumber,
        yaml: sourceYaml,
        sha: sha256(sourceYaml),
      },
    );

  it("refuses a publish whose number another writer already stored, inside the write", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(SAFEGUARDS);
    await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    // Version 2 lands without the register knowing: only the write's own check can see it.
    insertVersion(impl, 2, nextDefinitionYaml(9));
    await expect(
      repo.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "version-conflict", status: 409 });
    expect(
      impl.warehouse.query(
        `SELECT version_number, count(*) AS n FROM ${VERSIONS} GROUP BY version_number ORDER BY version_number`,
      ),
    ).toEqual([
      { version_number: 1, n: 1 },
      { version_number: 2, n: 1 },
    ]);
    expect((await repo.history()).version).toBe(1);
  });

  it.each(["bootstrap", "bootstrap-2"])(
    "reads an activation stored as replacing the built-in %s as replacing no published version",
    async (builtIn) => {
      const ACTIONS = `"eir__eir_definition_actions"`;
      // A real activation, written by this app on another store: its row's shape.
      const source = definitionImplementation();
      await source
        .as(SAFEGUARDS)
        .publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
      await source.as(SAFEGUARDS).activate({ versionNumber: 1, expectedVersion: 1 });
      const [row] = source.warehouse.query<Record<string, unknown>>(
        `SELECT * FROM ${ACTIONS} WHERE action = 'activated'`,
      );

      // The same activation as an earlier app stored it: replacing the built-in
      // under the name it had then (`bootstrap`, before #217) or has now.
      const impl = definitionImplementation();
      const repo = impl.as(SAFEGUARDS);
      await repo.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
      const older = {
        ...row!,
        action_id: "0b0b0b0b-0000-4000-8000-000000000001",
        idempotency_key: "0b0b0b0b-0000-4000-8000-000000000002",
        from_active_version: builtIn,
      };
      const columns = Object.keys(older);
      impl.warehouse.query(
        `INSERT INTO ${ACTIONS} (${columns.join(", ")}) VALUES (${columns.map((c) => `:${c}`).join(", ")})`,
        older as Record<string, string | number | null>,
      );

      // Through the client, as the workspace reads it.
      const { activations } = await repo.history();
      expect(activations).toEqual([
        expect.objectContaining({ versionNumber: 1, previousVersionNumber: null, rollback: false }),
      ]);
      // And the server's own answer before it's sent: JSON would show a NaN as null.
      const history = impl.deps.registry.findRead("eir-definitions", "history")!;
      const served = (await history.run({
        query: {},
        user: SAFEGUARDS,
        names: impl.deps.names,
        read: impl.deps.runner.reader({ readId: globalThis.crypto.randomUUID() }),
      })) as { activations: { previousVersionNumber: number | null }[] };
      expect(served.activations).toHaveLength(1);
      expect(served.activations[0]!.previousVersionNumber).toBeNull();
    },
  );

  it("the table refuses a version number below 1: 0 is the bootstrap's", () => {
    const impl = definitionImplementation();
    expect(() => insertVersion(impl, 0, nextDefinitionYaml(2))).toThrow(/CHECK/i);
    expect(() => insertVersion(impl, -1, nextDefinitionYaml(3))).toThrow(/CHECK/i);
  });
});

describe("EIR definition endpoints over HTTP (Delta)", () => {
  const post = (path: string, body: unknown) =>
    new Request(`https://app${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const command = (name: string, payload: unknown, expectedVersion = 0) =>
    post(`/api/commands/eir-definitions/${name}`, {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion,
      payload,
    });

  it("tenant-app calls are refused server-side, even from Safeguards", async () => {
    const impl = definitionImplementation();
    await impl.as(SAFEGUARDS).publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    const tenantApp = ["tenant"] as const;
    const requests = [
      () => new Request("https://app/api/reads/eir-definitions/history"),
      () => new Request("https://app/api/reads/eir-definitions/version?versionNumber=1"),
      () => post("/api/eir-definitions/check", { sourceYaml: BOOTSTRAP_YAML }),
      () => command("publish", { sourceYaml: nextDefinitionYaml(3) }, 1),
      () => command("activate", { versionNumber: 1 }, 1),
    ];
    for (const request of requests) {
      const response = await impl.request(SAFEGUARDS, request(), [...tenantApp]);
      expect(response.status).toBe(404);
    }
    const history = await impl.as(SAFEGUARDS).history();
    expect(history).toMatchObject({ version: 1, activations: [] });
  });

  it("takes the actor from the session, never from the body", async () => {
    const impl = definitionImplementation();
    const forged = await impl.request(
      SAFEGUARDS,
      command("publish", {
        sourceYaml: nextDefinitionYaml(2),
        publishedBy: { principalId: "9999", display: "Someone Else", app: "staff" },
      }),
    );
    expect(forged.status).toBe(400);
    const actorInEnvelope = await impl.request(
      SAFEGUARDS,
      post("/api/commands/eir-definitions/publish", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 0,
        actor: "9999",
        payload: { sourceYaml: nextDefinitionYaml(2) },
      }),
    );
    expect(actorInEnvelope.status).toBe(400);
    expect((await impl.as(SAFEGUARDS).history()).versions).toEqual([]);
  });
});
