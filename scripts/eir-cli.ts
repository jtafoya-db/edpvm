/**
 * What the EIR scripts (`eir-live-check.ts`, `eir-volume-migration.ts`) share:
 * auth through a Databricks CLI profile, SQL clients on a warehouse, the
 * Files API on the EIR volume, and provisioning a store from the real DDL
 * files. Modelled on `delta-live-check.ts`, which stays as it is.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { newId } from "../src/server/delta/ids.ts";
import { createStatementExecutionClient, type SqlClient } from "../src/server/delta/sql-client.ts";
import { createDatabricksEirFileStorage } from "../src/server/eir-storage.ts";

export function connect(profile: string, warehouse: string) {
  const cli = (...command: string[]) =>
    execFileSync("databricks", [...command, "-p", profile], { encoding: "utf8" });
  const described = JSON.parse(cli("auth", "describe", "-o", "json")) as {
    host?: string;
    details?: { host?: string };
  };
  const host = (described.details?.host ?? described.host)!.replace(/\/+$/, "");
  let token: { value: string; at: number } | undefined;
  const getToken = async () => {
    if (!token || Date.now() - token.at > 10 * 60_000) {
      token = {
        value: (JSON.parse(cli("auth", "token")) as { access_token: string }).access_token,
        at: Date.now(),
      };
    }
    return token.value;
  };
  const me = JSON.parse(cli("current-user", "me", "-o", "json")) as {
    id: string;
    displayName?: string;
    userName: string;
  };
  // The app's client (45 s deadline) for the runner; a patient one for setup.
  const client: SqlClient = createStatementExecutionClient({
    host,
    warehouseId: warehouse,
    getToken,
  });
  const admin: SqlClient = createStatementExecutionClient({
    host,
    warehouseId: warehouse,
    getToken,
    deadlineMs: 600_000,
  });
  // Setup, checks and cleanup are idempotent, so a dropped connection is retried
  // (a blip must not leave throwaway schemas behind). Commands go through the
  // runner's own retries instead.
  const sql = async (statement: string, parameters?: Record<string, string | number | null>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await admin.execute(
          { statement, ...(parameters ? { parameters } : {}) },
          { actionId: newId() },
        );
      } catch (error) {
        const network = error instanceof TypeError && /fetch failed/.test(error.message);
        if (!network || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  };
  const storage = async () => createDatabricksEirFileStorage({ host, token: await getToken() });
  return { host, me, client, sql, storage };
}

/** Split a DDL file into statements: top-level `;`, with `BEGIN … END;` blocks kept whole. */
function statementsOf(text: string): string[] {
  const lines = text.split("\n").filter((line) => !line.trim().startsWith("--"));
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (!current.length && !line.trim()) continue;
    current.push(line);
    if (line.trimEnd().endsWith(";")) {
      statements.push(current.join("\n").trim().replace(/;$/, ""));
      current = [];
    }
  }
  return statements;
}

/** Run a DDL file the way the provision_store job does, one statement at a time. */
export async function runDdl(
  sql: ReturnType<typeof connect>["sql"],
  file: string,
  catalog: string,
  prefix: string,
) {
  const statements = statementsOf(readFileSync(file, "utf8"));
  // The job runs a file in one session; the Statement Execution API doesn't,
  // so a file with session variables runs as one compound block.
  if (statements.some((s) => s.startsWith("DECLARE OR REPLACE VARIABLE"))) {
    const rest = statements.filter((s) => !s.startsWith("USE CATALOG"));
    const declared = rest.filter((s) => s.startsWith("DECLARE OR REPLACE VARIABLE"));
    const body = [...declared, ...rest.filter((s) => !declared.includes(s))].map((s) =>
      s.replace(/^DECLARE OR REPLACE VARIABLE/, "DECLARE").replace(/^SET VAR /, "SET "),
    );
    await sql(`BEGIN\n${body.join(";\n")};\nEND`, { catalog_name: catalog, schema_prefix: prefix });
    return;
  }
  for (const statement of statements) {
    const parameters: Record<string, string> = {};
    if (statement.includes(":catalog_name")) parameters["catalog_name"] = catalog;
    if (statement.includes(":schema_prefix")) parameters["schema_prefix"] = prefix;
    await sql(statement, parameters).catch((error: unknown) => {
      throw new Error(`${file} failed at: ${statement.slice(0, 200)}\n${String(error)}`);
    });
  }
}
