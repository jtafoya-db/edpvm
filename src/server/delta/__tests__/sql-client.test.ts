import { describe, expect, it, vi } from "vitest";

import { SqlError, StatementAbandonedError } from "../errors.ts";
import { canonicalJson, followOnId, sha256Hex, uuidV5 } from "../ids.ts";
import { AtomicBlock, createStoreNames, ident } from "../sql-builder.ts";
import {
  createServicePrincipalTokenSource,
  createStatementExecutionClient,
  tagComment,
  toApiParameter,
} from "../sql-client.ts";

const ACTION = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";
const READ = "8a37e1c9-f78d-4752-9f97-6d908d7c6e44";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Statement Execution SqlClient", () => {
  it("prefixes the action-ID comment, binds typed parameters, and returns typed rows", async () => {
    const request = vi.fn(async () =>
      reply({
        statement_id: "s1",
        status: { state: "SUCCEEDED" },
        manifest: {
          schema: {
            columns: [
              { name: "id", type_name: "STRING" },
              { name: "version", type_name: "LONG" },
              { name: "levers", type_name: "ARRAY" },
              { name: "open", type_name: "BOOLEAN" },
            ],
          },
        },
        result: { data_array: [["a", "3", '["x","y"]', "true"]] },
      }),
    );
    const client = createStatementExecutionClient({
      host: "https://ws.example/",
      warehouseId: "wh1",
      getToken: async () => "sp-token",
      fetch: request as typeof fetch,
    });
    const result = await client.execute(
      {
        statement: "SELECT * FROM t WHERE id = :id AND version = :v AND at < :at",
        parameters: { id: "a", v: 3, at: { type: "TIMESTAMP", value: "2026-10-05T00:00:00Z" } },
      },
      { actionId: ACTION },
    );
    expect(result).toEqual({
      rows: [{ id: "a", version: 3, levers: ["x", "y"], open: true }],
      numAffectedRows: null,
    });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ws.example/api/2.0/sql/statements");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sp-token");
    const body = JSON.parse(init.body as string);
    expect(body.warehouse_id).toBe("wh1");
    expect(body.statement).toBe(
      `/* edp_action_id=${ACTION} */\nSELECT * FROM t WHERE id = :id AND version = :v AND at < :at`,
    );
    expect(body.parameters).toEqual([
      { name: "id", value: "a", type: "STRING" },
      { name: "v", value: "3", type: "BIGINT" },
      { name: "at", value: "2026-10-05T00:00:00Z", type: "TIMESTAMP" },
    ]);
  });

  it("returns num_affected_rows for DML, including 0", async () => {
    const dml = (n: string) =>
      reply({
        status: { state: "SUCCEEDED" },
        manifest: { schema: { columns: [{ name: "num_affected_rows", type_name: "LONG" }] } },
        result: { data_array: [[n]] },
      });
    const request = vi.fn().mockResolvedValueOnce(dml("1")).mockResolvedValueOnce(dml("0"));
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as typeof fetch,
    });
    const update = {
      statement: "UPDATE t SET version = version + 1 WHERE id = :id AND version = :v",
      parameters: { id: "a", v: 1 },
    };
    expect((await client.execute(update, { actionId: ACTION })).numAffectedRows).toBe(1);
    expect((await client.execute(update, { actionId: ACTION })).numAffectedRows).toBe(0);
  });

  it("polls a running statement, then raises the warehouse's error with its SQLSTATE", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply({ statement_id: "s1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({
          statement_id: "s1",
          status: {
            state: "FAILED",
            sql_state: "ED001",
            error: {
              error_code: "BAD_REQUEST",
              message: "[USER_RAISED_EXCEPTION] edp:version-conflict SQLSTATE: ED001",
            },
          },
        }),
      );
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as typeof fetch,
      sleep: async () => undefined,
    });
    const error = await client
      .execute({ statement: "BEGIN ATOMIC SELECT 1; END;" }, { actionId: ACTION })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SqlError);
    expect(error).toMatchObject({ sqlState: "ED001", errorCode: "BAD_REQUEST", statementId: "s1" });
    expect(String(request.mock.calls[1]![0])).toBe("https://ws.example/api/2.0/sql/statements/s1");
  });

  it("refuses a tag that isn't a UUID, so nothing can be smuggled into the comment", () => {
    expect(() => tagComment({ actionId: "x */ DROP TABLE t; /*" })).toThrow(/Invalid action id/);
    expect(tagComment({ readId: ACTION })).toBe(`/* edp_read_id=${ACTION} */`);
  });

  it("types plain values for the API", () => {
    expect(toApiParameter("whole", 7)).toEqual({ name: "whole", value: "7", type: "BIGINT" });
    expect(toApiParameter("limit", { type: "INT", value: 7 })).toEqual({
      name: "limit",
      value: "7",
      type: "INT",
    });
    expect(toApiParameter("a", 1.5)).toEqual({ name: "a", value: "1.5", type: "DOUBLE" });
    expect(toApiParameter("b", false)).toEqual({ name: "b", value: "false", type: "BOOLEAN" });
    expect(toApiParameter("c", null)).toEqual({ name: "c", type: "STRING" });
  });
});

describe("service principal token source (OAuth M2M)", () => {
  it("uses client credentials, caches the token, and refreshes it before expiry", async () => {
    let clock = 0;
    const request = vi.fn(async () =>
      reply({ access_token: `tok-${request.mock.calls.length}`, expires_in: 3600 }),
    );
    const getToken = createServicePrincipalTokenSource({
      host: "https://ws.example",
      clientId: "sp-id",
      clientSecret: "sp-secret",
      fetch: request as typeof fetch,
      now: () => clock,
    });
    expect(await getToken()).toBe("tok-1");
    expect(await getToken()).toBe("tok-1");
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ws.example/oidc/v1/token");
    expect(init.body).toBe("grant_type=client_credentials&scope=all-apis");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${btoa("sp-id:sp-secret")}`,
    );
    clock = 3600_000 - 30_000;
    expect(await getToken()).toBe("tok-2");
  });
});

describe("IDs, hashes and SQL building", () => {
  it("derives RFC 4122 UUID v5s", async () => {
    // The RFC's DNS namespace example.
    expect(await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    expect(await followOnId(ACTION, 0)).toBe(await followOnId(ACTION, 0));
    expect(await followOnId(ACTION, 0)).not.toBe(await followOnId(ACTION, 1));
  });

  it("hashes canonical JSON, so key order doesn't change the hash", async () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(await sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(
      await sha256Hex(canonicalJson({ b: 2, a: 1 })),
    );
  });

  it("quotes only safe identifiers and prefixes preview schemas", () => {
    expect(() => ident("a`; DROP")).toThrow(/Unsafe/);
    expect(createStoreNames("cat", "edp_vm_pr9_").table("admin", "display_counters")).toBe(
      "`cat`.`edp_vm_pr9_admin`.`display_counters`",
    );
  });

  it("binds every value as a parameter in the atomic block", () => {
    const block = new AtomicBlock();
    block.add(`INSERT INTO t (a) VALUES (${block.bind("it's'); DROP TABLE t; --")})`);
    const statement = block.toStatement();
    expect(statement.statement).toBe("BEGIN ATOMIC\nINSERT INTO t (a) VALUES (:p0);\nEND;");
    expect(statement.parameters).toEqual({ p0: "it's'); DROP TABLE t; --" });
  });
});

describe("Statement Execution SqlClient: async polling and the client deadline", () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: vi.fn(async (ms: number) => void (t += ms)) };
  }

  it("submits with a short wait_timeout and polls until the statement finishes", async () => {
    const c = clock();
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply({ statement_id: "s1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(reply({ statement_id: "s1", status: { state: "RUNNING" } }))
      .mockResolvedValueOnce(
        reply({
          statement_id: "s1",
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [] } },
        }),
      );
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as typeof fetch,
      ...c,
    });
    await client.execute({ statement: "SELECT 1" }, { actionId: ACTION });
    const body = JSON.parse(
      (request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toMatchObject({ wait_timeout: "10s", on_wait_timeout: "CONTINUE" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("uses separate wait timeouts and poll intervals for commands and reads", async () => {
    const c = clock();
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply({ statement_id: "c1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({ statement_id: "c1", status: { state: "SUCCEEDED" }, manifest: { schema: {} } }),
      )
      .mockResolvedValueOnce(reply({ statement_id: "r1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({ statement_id: "r1", status: { state: "SUCCEEDED" }, manifest: { schema: {} } }),
      );
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as typeof fetch,
      commandWaitTimeoutSeconds: 30,
      readWaitTimeoutSeconds: 8,
      commandPollIntervalMs: 750,
      readPollIntervalMs: 125,
      ...c,
    });

    await client.execute({ statement: "BEGIN ATOMIC SELECT 1; END;" }, { actionId: ACTION });
    await client.execute({ statement: "SELECT 1" }, { readId: READ });

    const bodies = request.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies.map((body) => body.wait_timeout)).toEqual(["30s", "8s"]);
    expect(c.sleep.mock.calls.map(([ms]) => ms)).toEqual([750, 125]);
  });

  it("caps wait_timeout at the client deadline and bounds poll intervals", async () => {
    const c = clock();
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply({ statement_id: "c1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({ statement_id: "c1", status: { state: "SUCCEEDED" }, manifest: { schema: {} } }),
      )
      .mockResolvedValueOnce(reply({ statement_id: "r1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({ statement_id: "r1", status: { state: "SUCCEEDED" }, manifest: { schema: {} } }),
      );
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as typeof fetch,
      commandWaitTimeoutSeconds: 50,
      readWaitTimeoutSeconds: 90,
      commandPollIntervalMs: 50,
      readPollIntervalMs: 10_000,
      deadlineMs: 45_000,
      ...c,
    });

    await client.execute({ statement: "BEGIN ATOMIC SELECT 1; END;" }, { actionId: ACTION });
    await client.execute({ statement: "SELECT 1" }, { readId: READ });

    const bodies = request.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies.map((body) => body.wait_timeout)).toEqual(["45s", "45s"]);
    expect(c.sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 5_000]);
  });

  it("falls back with a warning instead of sending unsupported 1-4s wait_timeouts", async () => {
    const c = clock();
    const warn = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply({ statement_id: "c1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({ statement_id: "c1", status: { state: "SUCCEEDED" }, manifest: { schema: {} } }),
      )
      .mockResolvedValueOnce(reply({ statement_id: "r1", status: { state: "PENDING" } }))
      .mockResolvedValueOnce(
        reply({ statement_id: "r1", status: { state: "SUCCEEDED" }, manifest: { schema: {} } }),
      );
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as typeof fetch,
      commandWaitTimeoutSeconds: 1,
      readWaitTimeoutSeconds: 4,
      warn,
      ...c,
    });

    await client.execute({ statement: "BEGIN ATOMIC SELECT 1; END;" }, { actionId: ACTION });
    await client.execute({ statement: "SELECT 1" }, { readId: READ });

    const bodies = request.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies.map((body) => body.wait_timeout)).toEqual(["10s", "10s"]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Command wait_timeout 1s is outside the Statement Execution API's supported range; using the default 10s.",
      "Read wait_timeout 4s is outside the Statement Execution API's supported range; using the default 10s.",
    ]);
  });

  it("requires whole-number wait timeouts and poll intervals", () => {
    expect(() =>
      createStatementExecutionClient({
        host: "https://ws.example",
        warehouseId: "wh1",
        getToken: async () => "t",
        commandWaitTimeoutSeconds: 10.5,
      }),
    ).toThrow(/wait_timeout seconds must be a whole number/);
    expect(() =>
      createStatementExecutionClient({
        host: "https://ws.example",
        warehouseId: "wh1",
        getToken: async () => "t",
        commandPollIntervalMs: 250.5,
      }),
    ).toThrow(/poll interval milliseconds must be a whole number/);
  });

  it("cancels a statement still running at the deadline and reports its outcome as unknown", async () => {
    const c = clock();
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/cancel")) return reply({});
      return reply({
        statement_id: "s1",
        status: { state: init?.method === "POST" ? "PENDING" : "RUNNING" },
      });
    });
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as unknown as typeof fetch,
      deadlineMs: 5_000,
      ...c,
    });
    const error = await client
      .execute({ statement: "BEGIN ATOMIC SELECT 1; END;" }, { actionId: ACTION })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatementAbandonedError);
    expect(error).toMatchObject({
      errorCode: "DEADLINE_EXCEEDED",
      statementId: "s1",
      lastState: "RUNNING",
    });
    const urls = request.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("https://ws.example/api/2.0/sql/statements/s1/cancel");
    // It looked once more after cancelling.
    expect(urls.at(-1)).toBe("https://ws.example/api/2.0/sql/statements/s1");
  });

  it("returns the result when the statement finished just before the cancel landed", async () => {
    const c = clock();
    let cancelled = false;
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/cancel")) {
        cancelled = true;
        return reply({});
      }
      if (init?.method === "POST")
        return reply({ statement_id: "s1", status: { state: "PENDING" } });
      return cancelled
        ? reply({
            statement_id: "s1",
            status: { state: "SUCCEEDED" },
            manifest: { schema: { columns: [{ name: "n", type_name: "LONG" }] } },
            result: { data_array: [["1"]] },
          })
        : reply({ statement_id: "s1", status: { state: "RUNNING" } });
    });
    const client = createStatementExecutionClient({
      host: "https://ws.example",
      warehouseId: "wh1",
      getToken: async () => "t",
      fetch: request as unknown as typeof fetch,
      deadlineMs: 2_000,
      ...c,
    });
    expect(
      (await client.execute({ statement: "SELECT 1 AS n" }, { actionId: ACTION })).rows,
    ).toEqual([{ n: 1 }]);
  });
});
