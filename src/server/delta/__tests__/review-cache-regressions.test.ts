import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import { eirIdFor } from "../areas/eir-records.ts";
import { createRegistry, type SessionUser } from "../registry.ts";
import {
  SNAPSHOT_TABLES,
  WATERMARK_ALLOWED_CLOCK_SKEW_MS,
  actionWatermark,
  createDeltaSnapshotCache,
  snapshotMarkerStatement,
} from "../snapshot-cache.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { expectRow, insertRow } from "../write-helpers.ts";
import { committed, fakeSqlClient, type Responder } from "./fake-sql-client.ts";
import { createSqliteWarehouse } from "./eir-sqlite-warehouse.ts";

const names = createStoreNames("edp_vending");
const TENANT: SessionUser = {
  principalId: "7001",
  displayName: "T",
  email: "t@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: [],
};
const STAFF: SessionUser = {
  principalId: "4055694201057157",
  displayName: "Sam Staff",
  email: "sam.staff@example.gov",
  isAdmin: true,
  onboardingReviewerRoles: [],
};
const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";

const snap = (tables: Record<string, Record<string, unknown>[]>) => ({
  table: (schema: string, table: string) => tables[`${schema}.${table}`] ?? [],
  stats: () => ({}) as never,
});

const isMarkerCheck = (statement: string) =>
  statement.includes(" AS area, concat_ws('|',") && statement.includes(" AS version");

const get = (path: string, headers?: HeadersInit) =>
  new Request(`https://app.example${path}`, headers ? { headers } : undefined);
const post = (path: string, body: unknown) =>
  new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function deps(
  responder: Responder,
  extra: Partial<DeltaApiDeps> = {},
): { deps: DeltaApiDeps; fake: ReturnType<typeof fakeSqlClient> } {
  const fake = fakeSqlClient(responder);
  return {
    fake,
    deps: {
      registry: createAppRegistry(),
      runner: createTransactionRunner({
        client: fake.client,
        names,
        sleep: async () => undefined,
        random: () => 0,
      }),
      names,
      serves: ["tenant", "staff"],
      resolveUser: async () => STAFF,
      ...extra,
      requirePrivacyAcknowledgment: extra.requirePrivacyAcknowledgment ?? (async () => undefined),
    },
  };
}

describe("snapshot cache review regressions", () => {
  it("serves an EIR draft saved before its EIR row from the snapshot path", async () => {
    const read = createAppRegistry().findRead("eir", "mine")!;
    const eirId = await eirIdFor(TENANT.principalId);
    const draft = {
      id: "d1",
      eir_id: eirId,
      form_values: JSON.stringify({ a: 1 }),
      form_version: "v1",
      form_started_at: "2026-10-01T00:00:00.000Z",
      version: 1,
    };

    const viaSnapshot = await read.snapshot!({
      query: {},
      user: TENANT,
      names,
      snapshot: snap({ "eir.eir_drafts": [draft] }) as never,
    });
    const viaSql = await read.run({
      query: {},
      user: TENANT,
      names,
      read: (async (statement: { statement: string }) =>
        statement.statement.includes("'draft' AS part")
          ? [{ part: "draft", part_json: JSON.stringify(draft) }]
          : []) as never,
    });

    expect((viaSnapshot as { draftValues?: unknown }).draftValues).toEqual(
      (viaSql as { draftValues?: unknown }).draftValues,
    );
  });

  it("serves the latest EIR evaluation from a warmed snapshot after draft-save projection is narrowed", async () => {
    const definition = createAppRegistry().findRead("eir", "mine")!;
    const eirId = await eirIdFor(TENANT.principalId);
    const draft = {
      id: "draft-1",
      eir_id: eirId,
      form_values: JSON.stringify({ team: "A" }),
      form_version: "bootstrap-2",
      form_started_at: "2026-10-01T00:00:00.000Z",
      version: 2,
    };
    const evaluation = (actionId: string, recordVersion: number, occurredAt: string) => ({
      action_id: actionId,
      eir_draft_id: draft.id,
      record_version: recordVersion,
      occurred_at: occurredAt,
      definition_version: "bootstrap-2",
      form_version: draft.form_version,
      outcome: recordVersion === 2 ? "warning" : "pass",
      rule_outcomes: "[]",
      automatic_validity_eligible: false,
    });

    const evaluations = [
      evaluation("matching", 2, "2026-10-01T00:01:00.000Z"),
      evaluation("newer-stale", 1, "2026-10-02T00:01:00.000Z"),
    ];
    const cache = createDeltaSnapshotCache({
      tables: SNAPSHOT_TABLES.filter(
        (table) =>
          table.schema === "eir" && ["eir_drafts", "eir_evaluations"].includes(table.table),
      ),
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) return [{ area: "eir", version: "1" }];
      if (statement.statement.includes("eir_drafts")) return [draft];
      if (statement.statement.includes("eir_evaluations")) {
        expect(statement.statement).toContain(
          `SELECT * FROM ${names.table("eir", "eir_evaluations")}`,
        );
        return evaluations;
      }
      return [];
    }) as never;
    await cache.start(read, names);
    const warmed = await cache.snapshotForRead(definition, read, names);

    const result = (await definition.snapshot!({
      query: {},
      user: TENANT,
      names,
      snapshot: warmed!,
    })) as { evaluation?: { evaluatedDraftVersion: number; outcome: string } };

    expect(result.evaluation).toMatchObject({ evaluatedDraftVersion: 2, outcome: "warning" });
  });

  it("validator snapshot reads never expose another person's draft", async () => {
    const registry = createAppRegistry();
    const eirId = await eirIdFor(TENANT.principalId);
    const snapshot = snap({
      "eir.eirs": [
        {
          id: eirId,
          person_principal_id: TENANT.principalId,
          person_display: TENANT.displayName,
          stage: "submitted",
          stage_entered_at: "2026-10-01T00:00:00.000Z",
          open_submission_id: "submission-1",
          current_submission_id: "submission-1",
          version: 2,
          created_at: "2026-10-01T00:00:00.000Z",
        },
      ],
      "eir.eir_submissions": [
        {
          id: "submission-1",
          eir_id: eirId,
          kind: "first",
          stage: "submitted",
          volume_path: "/Volumes/test/eir.pdf",
          form_values: JSON.stringify({ signed: "visible" }),
          form_version: "bootstrap-2",
          form_started_at: "2026-10-01T00:00:00.000Z",
          submitted_at: "2026-10-01T00:00:00.000Z",
        },
      ],
      "eir.eir_drafts": [
        {
          id: "draft-1",
          eir_id: eirId,
          form_values: JSON.stringify({ secret: "owner-only" }),
          form_version: "bootstrap-2",
          form_started_at: "2026-10-01T00:00:00.000Z",
          version: 3,
        },
      ],
    }) as never;
    const record = (await registry.findRead("eir", "record")!.snapshot!({
      query: { principalId: TENANT.principalId },
      user: STAFF,
      names,
      snapshot,
    })) as Record<string, unknown>;
    const inbox = (await registry.findRead("eir", "inbox")!.snapshot!({
      query: {},
      user: STAFF,
      names,
      snapshot,
    })) as Record<string, unknown>[];

    for (const seen of [record, ...inbox]) {
      expect(seen).not.toHaveProperty("draftValues");
      expect(seen).not.toHaveProperty("draftFormVersion");
      expect(seen).not.toHaveProperty("draftStartedAt");
      expect(seen).not.toHaveProperty("draftVersion");
    }
    expect(JSON.stringify([record, inbox])).not.toContain("owner-only");
  });

  it("matches the SQL shape for access-requests?id on the snapshot path", async () => {
    const read = createAppRegistry().findRead("requests", "access-requests")!;
    const row = {
      id: "r1",
      title: "x",
      submitted_at: "2026-10-01 00:00:00",
      status: "pending",
      overall: "x",
      purpose: "p",
      stage_index: 0,
      requester_principal_id: TENANT.principalId,
      requester_username: TENANT.email,
    };

    const viaSnapshot = await read.snapshot!({
      query: { id: "r1" },
      user: TENANT,
      names,
      snapshot: snap({ "requests.access_requests": [row] }) as never,
    });
    const viaSql = await read.run({
      query: { id: "r1" },
      user: TENANT,
      names,
      read: (async (statement: { statement: string }) =>
        statement.statement.includes("access_requests") ? [row] : []) as never,
    });

    expect(Array.isArray(viaSnapshot)).toBe(Array.isArray(viaSql));
    expect(viaSnapshot).toEqual(viaSql);
  });

  it("reads startup markers before loading tables so a concurrent commit is seen later", async () => {
    let committed = false;
    let marker = "v1";
    const tables = [{ area: "teams", schema: "teams", table: "dataset_owners" }];
    const cache = createDeltaSnapshotCache({
      tables,
      pollIntervalMs: 0,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) return [{ area: "teams", version: marker }];
      const rows = committed ? [{ id: "new" }] : [];
      committed = true;
      marker = "v2";
      return rows;
    }) as never;

    await cache.start(read, names);
    for (let i = 0; i < 3; i++) {
      await cache.snapshotForRead({ area: "teams", snapshot: () => 1 } as never, read, names);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
    );

    expect(snapshot?.table("teams", "dataset_owners")).toEqual([{ id: "new" }]);
  });

  it("retries a marker-changed area reload after a transient load failure", async () => {
    let marker = "v1";
    let fail = false;
    let rows = [{ id: "old" }];
    const tables = [{ area: "teams", schema: "teams", table: "dataset_owners" }];
    const cache = createDeltaSnapshotCache({
      tables,
      pollIntervalMs: 0,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) return [{ area: "teams", version: marker }];
      if (fail) {
        fail = false;
        throw new Error("transient");
      }
      return rows;
    }) as never;
    await cache.start(read, names);
    marker = "v2";
    rows = [{ id: "new" }];
    fail = true;

    for (let i = 0; i < 4; i++) {
      await cache.snapshotForRead({ area: "teams", snapshot: () => 1 } as never, read, names);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
    );

    expect(snapshot?.table("teams", "dataset_owners")).toEqual([{ id: "new" }]);
  });

  it("does not let a slower overlapping area reload revert a newer area reload", async () => {
    const tables = [
      { area: "teams", schema: "teams", table: "dataset_owners" },
      { area: "catalog", schema: "catalog", table: "datasets" },
    ];
    let owners = [{ id: "old" }];
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let slowCatalog = false;
    const cache = createDeltaSnapshotCache({
      tables,
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement))
        return [
          { area: "teams", version: "1" },
          { area: "catalog", version: "1" },
        ];
      if (statement.statement.includes("dataset_owners")) return owners;
      if (slowCatalog) await catalogGate;
      return [];
    }) as never;
    await cache.start(read, names);
    slowCatalog = true;
    const catalogReload = cache.reload(read, names, ["catalog"]);
    owners = [{ id: "new" }];

    await cache.reload(read, names, ["teams"]);
    releaseCatalog();
    await catalogReload;
    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
    );

    expect(snapshot?.table("teams", "dataset_owners")).toEqual([{ id: "new" }]);
  });

  it("does not let a pre-commit reload hide an invalidated own write", async () => {
    let clock = 1_000_000;
    let marker = "1";
    let rows: Record<string, unknown>[] = [{ id: "old", action_id: "a0" }];
    let releaseReload: ((value: unknown) => void) | undefined;
    let deferNextReload = false;
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_check_actions" }],
      pollIntervalMs: 5_000,
      maxStaleMs: 60_000,
      now: () => clock,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) return [{ area: "admin", version: marker }];
      if (statement.statement.startsWith("SELECT * FROM")) {
        const snapshotOfRows = rows.map((row) => ({ ...row }));
        if (deferNextReload) {
          deferNextReload = false;
          await new Promise((resolve) => {
            releaseReload = resolve;
          });
        }
        return statement.statement.includes("write_check_actions") ? snapshotOfRows : [];
      }
      return [];
    }) as never;
    const definition = { area: "admin", snapshot: () => 1 } as never;
    await cache.start(read, names);

    marker = "2";
    rows = [...rows, { id: "other", action_id: "a1" }];
    clock += 6_000;
    deferNextReload = true;
    await cache.snapshotForRead(definition, read, names);
    await new Promise((resolve) => setTimeout(resolve, 0));
    marker = "3";
    rows = [...rows, { id: "mine", action_id: "a2" }];
    cache.invalidateAreas(["admin"]);
    releaseReload?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock += 100;

    const snapshot = await cache.snapshotForRead(definition, read, names);
    const ids = snapshot?.table("admin", "write_check_actions").map((row) => row["id"]);

    expect(snapshot === undefined || ids?.includes("mine")).toBe(true);
  });

  it("marks only affected areas dirty after a command and does not start an immediate reload", async () => {
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "admin", schema: "admin", table: "write_checks" },
        { area: "audit", schema: "audit", table: "actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      ownWriteReloadDelayMs: 0,
    });
    let commandCommitted = false;
    const { deps: d } = deps(
      (call) => {
        if (call.statement.startsWith("BEGIN ATOMIC")) {
          commandCommitted = true;
          return committed(call, {
            id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
            display_number: 1001,
            label: "smoke",
            stage: "recorded",
            version: 1,
            created_at: "2026-10-05T12:00:00.000Z",
            created_by_principal_id: STAFF.principalId,
            updated_at: "2026-10-05T12:00:00.000Z",
            last_action_id: "a",
          });
        }
        if (isMarkerCheck(call.statement))
          return {
            rows: [
              { area: "admin", version: "1" },
              { area: "audit", version: "1" },
            ],
          };
        if (commandCommitted && call.statement.startsWith("SELECT * FROM"))
          throw new Error("unexpected reload");
        if (call.statement.includes("write_checks"))
          return {
            rows: [
              {
                id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
                display_number: 1001,
                label: "warm",
                stage: "recorded",
                version: 1,
                created_at: "2026-10-05T12:00:00.000Z",
                created_by_principal_id: STAFF.principalId,
                updated_at: "2026-10-05T12:00:00.000Z",
                last_action_id: "a",
              },
            ],
          };
        if (call.statement.includes("audit")) return { rows: [{ action_id: "audit-1" }] };
        return { rows: [] };
      },
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000201" }), names);

    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "smoke" },
      }),
      d,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("affectedAreas");
    expect(body).not.toHaveProperty("actionWatermarks");
    await expect(
      cache.snapshotForRead(
        { area: "admin", snapshot: () => 1 } as never,
        d.runner.reader({ readId: KEY }),
        names,
      ),
    ).resolves.toBeUndefined();
    await expect(
      cache.snapshotForRead(
        { area: "audit", snapshot: () => 1 } as never,
        d.runner.reader({ readId: KEY }),
        names,
      ),
    ).resolves.toBeDefined();
  });

  it("invalidates every area touched by a multi-area command", async () => {
    const registry = createRegistry();
    registry.command({
      area: "admin",
      name: "touch-two-areas",
      app: "tenant",
      payload: z.object({}).strict(),
      leadActionTable: {
        schema: "admin",
        table: "write_check_actions",
        recordIdColumn: "write_check_id",
      },
      plan(ctx) {
        insertRow(
          ctx,
          { schema: "change_list", table: "change_list_entries" },
          { id: "cl1", last_action_id: ctx.actionId },
        );
        expectRow(ctx, { schema: "change_list", table: "change_list_entries" }, "id", "cl1");
        return {
          recordId: "wc1",
          recordVersion: 1,
          leadAction: { action: "recorded", change: { stage: [null, "recorded"] } },
        };
      },
      resultRow: ({ block }) => `SELECT ${block.bind("ok")} AS status`,
      result: (row) => row,
    });
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "admin", schema: "admin", table: "write_checks" },
        { area: "change-list", schema: "change_list", table: "change_list_entries" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    const { deps: d } = deps(
      (call) => {
        if (isMarkerCheck(call.statement))
          return {
            rows: [
              { area: "admin", version: "1" },
              { area: "change-list", version: "1" },
            ],
          };
        if (call.statement.startsWith("BEGIN ATOMIC")) return committed(call, { status: "ok" });
        if (call.statement.includes("write_checks")) return { rows: [{ id: "wc1" }] };
        if (call.statement.includes("change_list_entries")) return { rows: [{ id: "cl1" }] };
        return { rows: [] };
      },
      { registry, snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000301" }), names);

    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/touch-two-areas", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {},
      }),
      d,
    );

    expect(response.status).toBe(200);
    await expect(
      cache.snapshotForRead(
        { area: "admin", snapshot: () => 1 } as never,
        d.runner.reader({ readId: "00000000-0000-4000-8000-000000000302" }),
        names,
      ),
    ).resolves.toBeUndefined();
    await expect(
      cache.snapshotForRead(
        { area: "change-list", snapshot: () => 1 } as never,
        d.runner.reader({ readId: "00000000-0000-4000-8000-000000000303" }),
        names,
      ),
    ).resolves.toBeUndefined();
  });

  it("uses Delta fallback for an own-written dirty area until its reload succeeds", async () => {
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    let failReload = false;
    let label = "stale snapshot";
    const { deps: d, fake } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) return { rows: [{ area: "admin", version: "1" }] };
        if (call.statement.includes("write_checks")) {
          if (failReload && call.statement.startsWith("SELECT * FROM")) throw new Error("reload");
          return {
            rows: [
              {
                id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
                display_number: 1001,
                label,
                stage: "recorded",
                version: 1,
                created_at: "2026-10-05T12:00:00.000Z",
                created_by_principal_id: STAFF.principalId,
                updated_at: "2026-10-05T12:00:00.000Z",
                last_action_id: "a",
              },
            ],
          };
        }
        return { rows: [] };
      },
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000001" }), names);
    failReload = true;
    label = "delta";
    cache.invalidateAreas(["admin"]);

    const response = await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ name: "delta" }]);
    expect(fake.calls.some((call) => !call.statement.startsWith("SELECT * FROM"))).toBe(true);
  });

  it("honors client write watermarks across two stale server instances", async () => {
    let committedWrite = false;
    let markerChecks = 0;
    const cacheA = createDeltaSnapshotCache({
      tables: [
        { area: "admin", schema: "admin", table: "write_checks" },
        { area: "admin", schema: "admin", table: "write_check_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const cacheB = createDeltaSnapshotCache({
      tables: [
        { area: "admin", schema: "admin", table: "write_checks" },
        { area: "admin", schema: "admin", table: "write_check_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const responder: Responder = (call) => {
      if (isMarkerCheck(call.statement)) {
        markerChecks += 1;
        return { rows: [{ area: "admin", version: committedWrite ? "admin:v2" : "admin:v1" }] };
      }
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        committedWrite = true;
        return committed(call, {
          id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
          display_number: 1001,
          label: "fanout",
          stage: "recorded",
          version: 1,
          created_at: "2026-10-05T12:00:00.000Z",
          created_by_principal_id: STAFF.principalId,
          updated_at: "2026-10-05T12:00:00.000Z",
          last_action_id: "a",
        });
      }
      if (call.statement.includes("write_checks")) {
        return {
          rows: committedWrite
            ? [
                {
                  id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
                  display_number: 1001,
                  label: "fanout",
                  stage: "recorded",
                  version: 1,
                  created_at: "2026-10-05T12:00:00.000Z",
                  created_by_principal_id: STAFF.principalId,
                  updated_at: "2026-10-05T12:00:00.000Z",
                  last_action_id: "a",
                },
              ]
            : [],
        };
      }
      if (call.statement.includes("write_check_actions")) {
        return {
          rows: committedWrite
            ? [
                {
                  action_id:
                    call.tag && "actionId" in call.tag ? call.tag.actionId : "committed-action",
                  write_check_id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
                  action: "recorded",
                  record_version: 1,
                  occurred_at: "2026-10-05T12:00:00.000Z",
                },
              ]
            : [],
        };
      }
      return { rows: [] };
    };
    const { deps: depsA } = deps(responder, { snapshotCache: cacheA });
    const { deps: depsB } = deps(responder, { snapshotCache: cacheB });
    await cacheB.start(
      depsB.runner.reader({ readId: "00000000-0000-4000-8000-000000000001" }),
      names,
    );

    const write = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "fanout" },
      }),
      depsA,
    );
    const body = (await write.json()) as { watermarks?: Record<string, string> };
    expect(body.watermarks?.["admin"]).toMatch(/^wm1\.[0-9a-z]+\.[0-9a-z]+\.[0-9a-f]{64}$/);
    expect(markerChecks).toBe(1);
    expect(
      await (await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), depsB)).json(),
    ).toEqual([]);

    const seen = `admin=${encodeURIComponent(body.watermarks!["admin"]!)}`;
    const caughtUp = await handleDeltaApiRequest(
      get("/api/reads/admin/write-checks", { "x-edp-seen": seen }),
      depsB,
    );

    expect(await caughtUp.json()).toMatchObject([{ name: "fanout" }]);
  });

  it("does not run the all-area marker query on the command response path", async () => {
    let markerChecks = 0;
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "admin", schema: "admin", table: "write_checks" },
        { area: "admin", schema: "admin", table: "write_check_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const { deps: d } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) {
          markerChecks += 1;
          return { rows: [{ area: "admin", version: "v1" }] };
        }
        if (call.statement.startsWith("BEGIN ATOMIC"))
          return committed(call, {
            id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
            display_number: 1001,
            label: "no marker",
            stage: "recorded",
            version: 1,
            created_at: "2026-10-05T12:00:00.000Z",
            created_by_principal_id: STAFF.principalId,
            updated_at: "2026-10-05T12:00:00.000Z",
            last_action_id: "a",
          });
        return { rows: [] };
      },
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000101" }), names);
    markerChecks = 0;

    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "no marker" },
      }),
      d,
    );

    expect(response.status).toBe(200);
    expect(markerChecks).toBe(0);
  });

  it("checks seen watermarks for dependent areas before serving a snapshot read", async () => {
    let committedWrite = false;
    const registry = createRegistry();
    registry.command({
      area: "teams",
      name: "touch-member",
      app: "tenant",
      payload: z.object({}).strict(),
      leadActionTable: {
        schema: "teams",
        table: "dataset_member_actions",
        recordIdColumn: "dataset_member_id",
      },
      plan: () => ({
        recordId: "member1",
        recordVersion: 1,
        leadAction: { action: "added", payload: { datasetId: "ds1" } },
      }),
      resultRow: ({ block }) => `SELECT ${block.bind("ok")} AS status`,
      result: (row) => row,
    });
    registry.read({
      area: "initiatives",
      name: "dataset-member-summaries",
      app: "tenant",
      dependsOn: ["teams"],
      query: z.object({}).strict(),
      snapshot: ({ snapshot }) => [
        { source: "snapshot", totalMembers: snapshot.table("teams", "dataset_members").length },
      ],
      run: async ({ read }) => {
        await read({ statement: "SELECT total_members FROM delta_members" });
        return [{ source: "delta", totalMembers: committedWrite ? 1 : 0 }];
      },
    });
    const tables = [
      { area: "initiatives", schema: "initiatives", table: "datasets" },
      { area: "teams", schema: "teams", table: "dataset_members" },
      { area: "teams", schema: "teams", table: "dataset_member_actions" },
    ];
    const cacheA = createDeltaSnapshotCache({
      tables,
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const cacheB = createDeltaSnapshotCache({
      tables,
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const responder: Responder = (call) => {
      if (isMarkerCheck(call.statement))
        return {
          rows: [
            { area: "initiatives", version: "i1" },
            { area: "teams", version: committedWrite ? "t2" : "t1" },
          ],
        };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        committedWrite = true;
        return committed(call, { status: "ok" });
      }
      if (call.statement.includes("dataset_members"))
        return { rows: committedWrite ? [{ id: "member1" }] : [] };
      if (call.statement.includes("dataset_member_actions"))
        return {
          rows: committedWrite
            ? [
                {
                  action_id:
                    call.tag && "actionId" in call.tag ? call.tag.actionId : "member-action",
                  dataset_member_id: "member1",
                },
              ]
            : [],
        };
      return { rows: [] };
    };
    const { deps: depsA } = deps(responder, { registry, snapshotCache: cacheA });
    const { deps: depsB } = deps(responder, { registry, snapshotCache: cacheB });
    await cacheB.start(
      depsB.runner.reader({ readId: "00000000-0000-4000-8000-000000000102" }),
      names,
    );

    const write = await handleDeltaApiRequest(
      post("/api/commands/teams/touch-member", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {},
      }),
      depsA,
    );
    const body = (await write.json()) as { watermarks?: Record<string, string> };

    expect(
      await (
        await handleDeltaApiRequest(get("/api/reads/initiatives/dataset-member-summaries"), depsB)
      ).json(),
    ).toEqual([{ source: "snapshot", totalMembers: 0 }]);
    const seen = `teams=${encodeURIComponent(body.watermarks!["teams"]!)}`;
    expect(
      await (
        await handleDeltaApiRequest(
          get("/api/reads/initiatives/dataset-member-summaries", { "x-edp-seen": seen }),
          depsB,
        )
      ).json(),
    ).toEqual([{ source: "delta", totalMembers: 1 }]);
  });

  it("treats expired seen watermarks as satisfied so old sessions do not force Delta forever", async () => {
    let now = 10_000;
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "teams", schema: "teams", table: "dataset_members" },
        { area: "teams", schema: "teams", table: "dataset_member_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 120_000,
      now: () => now,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) return [{ area: "teams", version: "v1" }];
      return [];
    }) as never;
    await cache.start(read, names);
    now = 75_001;

    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
      { teams: actionWatermark("teams", "unseen-action", 10_000) },
    );

    expect(snapshot).toBeDefined();
  });

  it("ignores a watermark issued beyond the allowed server clock skew", async () => {
    const now = 1_000_000;
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "teams", schema: "teams", table: "dataset_owners" },
        { area: "teams", schema: "teams", table: "dataset_member_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      now: () => now,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) =>
      isMarkerCheck(statement.statement) ? [{ area: "teams", version: "1" }] : []) as never;
    await cache.start(read, names);

    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
      { teams: actionWatermark("teams", "unseen-action", now + 5_001) },
    );

    expect(snapshot).toBeDefined();
  });

  it("accepts a watermark issued at the clock-skew boundary across instances", async () => {
    const now = 1_000_000;
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "teams", schema: "teams", table: "dataset_owners" },
        { area: "teams", schema: "teams", table: "dataset_member_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      now: () => now,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) =>
      isMarkerCheck(statement.statement) ? [{ area: "teams", version: "1" }] : []) as never;
    await cache.start(read, names);

    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
      {
        teams: actionWatermark("teams", "unseen-action", now + WATERMARK_ALLOWED_CLOCK_SKEW_MS),
      },
    );

    expect(snapshot).toBeUndefined();
  });

  it("loads only action_id for EIR draft-save watermark checks", async () => {
    const warehouse = createSqliteWarehouse();
    warehouse.query(`INSERT INTO eir__eir_draft_saves (
      action_id, eir_draft_id, action, record_version, actor_principal_id,
      actor_display, actor_app, occurred_at, idempotency_key
    ) VALUES (
      'save-1', 'draft-1', 'saved', 1, '7001',
      'T', 'tenant', '2026-10-18T00:00:00.000Z', '${KEY}'
    )`);
    const cache = createDeltaSnapshotCache({
      tables: [SNAPSHOT_TABLES.find((table) => table.table === "eir_draft_saves")!],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) return [{ area: "eir", version: "1" }];
      return (await warehouse.client.execute(statement, { readId: KEY })).rows;
    }) as never;
    await cache.start(read, names);

    const snapshot = await cache.snapshotForRead(
      { area: "eir", snapshot: () => 1 } as never,
      read,
      names,
    );

    expect(snapshot?.table("eir", "eir_draft_saves")).toEqual([{ action_id: "save-1" }]);
  });

  it("satisfies save-draft watermarks from the loaded eir_draft_saves action table", async () => {
    let now = 1_000_000;
    const cache = createDeltaSnapshotCache({
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
      now: () => now,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) => {
      if (isMarkerCheck(statement.statement)) {
        return [
          "access",
          "admin",
          "audit",
          "catalog",
          "change-list",
          "eir",
          "initiatives",
          "onboarding",
          "requests",
          "teams",
        ].map((area) => ({ area, version: "1" }));
      }
      if (statement.statement.includes("eir_draft_saves")) return [{ action_id: "save-1" }];
      return [];
    }) as never;
    await cache.start(read, names);
    const watermark = actionWatermark("eir", "save-1", now);
    const hits: boolean[] = [];
    for (const delta of [0, 5_000, 20_000, 29_000]) {
      now = 1_000_000 + delta;
      hits.push(
        !!(await cache.snapshotForRead({ area: "eir", snapshot: () => 1 } as never, read, names, {
          eir: watermark,
        })),
      );
    }

    expect(hits.some(Boolean)).toBe(true);
  });

  it("bounds forged far-future watermark expiry by the server issue-time TTL", async () => {
    let now = 1_000_000;
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "teams", schema: "teams", table: "dataset_owners" },
        { area: "teams", schema: "teams", table: "dataset_member_actions" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 2 * 3_600_000,
      now: () => now,
      setTimer: () => undefined,
    });
    const read = (async (statement: { statement: string }) =>
      isMarkerCheck(statement.statement) ? [{ area: "teams", version: "1" }] : []) as never;
    await cache.start(read, names);
    const forged = `wm1.${(now + 10 * 365 * 86_400_000).toString(36)}.${now.toString(36)}.${"0".repeat(64)}`;
    now += 3_600_000;

    const snapshot = await cache.snapshotForRead(
      { area: "teams", snapshot: () => 1 } as never,
      read,
      names,
      { teams: forged },
    );

    expect(snapshot).toBeDefined();
  });

  it("loads every registered command lead action table into the snapshot", () => {
    const loaded = new Set(SNAPSHOT_TABLES.map((table) => `${table.schema}.${table.table}`));
    const missing = createAppRegistry()
      .list()
      .writes.filter((write) => write.kind === "command")
      .map((write) => `${write.leadActionTable.schema}.${write.leadActionTable.table}`)
      .filter((table) => !loaded.has(table));

    expect(missing).toEqual([]);
  });

  it("keeps every action table used by the marker query loaded in the snapshot", () => {
    const loaded = new Set(SNAPSHOT_TABLES.map((table) => `${table.schema}.${table.table}`));
    const markerSql = snapshotMarkerStatement(names);
    const markerActionTables = [
      ...markerSql.matchAll(
        /`edp_vending`\.`([^`]+)`\.`([^`]*(?:_actions|eir_draft_saves|eir_evaluations))`/g,
      ),
    ].map((match) => `${match[1] === "change_list" ? "change_list" : match[1]}.${match[2]}`);

    expect(markerSql).toContain("dataset_owner_actions");
    expect(markerActionTables.filter((table) => !loaded.has(table))).toEqual([]);
  });

  it("declares dependencies for reads whose snapshots compose other areas", () => {
    const registry = createAppRegistry();

    expect(registry.findRead("initiatives", "dataset-member-summaries")?.dependsOn).toContain(
      "teams",
    );
    expect(registry.findRead("initiatives", "datasets")?.dependsOn).toContain("teams");
    expect(registry.findRead("change-list", "entries")?.dependsOn).toContain("teams");
    expect(registry.findRead("change-list", "entries")?.dependsOn).toContain("initiatives");
    expect(registry.findRead("teams", "ownership")?.dependsOn).toContain("initiatives");
    expect(registry.findRead("teams", "events")?.dependsOn).toContain("change-list");
  });

  it("jitters snapshot poll timers inside the configured spread", async () => {
    const delays: number[] = [];
    createDeltaSnapshotCache({
      tables: [{ area: "teams", schema: "teams", table: "dataset_members" }],
      pollIntervalMs: 1_000,
      pollJitterRatio: 0.2,
      random: () => 0,
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return {};
      },
    }).reloadSoon((async () => []) as never, names, ["teams"]);
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "teams", schema: "teams", table: "dataset_members" }],
      pollIntervalMs: 1_000,
      pollJitterRatio: 0.2,
      random: () => 1,
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return {};
      },
    });
    const read = (async (statement: { statement: string }) =>
      isMarkerCheck(statement.statement) ? [{ area: "teams", version: "v1" }] : []) as never;

    await cache.start(read, names);

    expect(delays).toContain(1_100);
  });
});
