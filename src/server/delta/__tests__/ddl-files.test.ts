/**
 * Static checks on the provisioning DDL (resources/store-*.sql), so an area
 * ticket's file can't skip them:
 *
 * - The first statements assert that `catalog_name` and `schema_prefix` are
 *   plain identifiers, before anything runs (the live check proves the
 *   warehouse refuses a hostile prefix there).
 * - Every place a parameter or catalog name is spliced into dynamic SQL
 *   doubles its back-quotes.
 * - Every table is catalog-managed, so `BEGIN ATOMIC` works on it. The one
 *   exception is `store-schema.sql`, #72's legacy tables (#96 drops them):
 *   nothing writes them in a transaction, which a test pins.
 * - A column a table didn't have when it was first provisioned has a
 *   migration in the same file: `CREATE TABLE IF NOT EXISTS` never changes an
 *   existing table, so a column added only there breaks every store
 *   provisioned before it. The first shapes are in `ddl-first-shapes.json`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createAppRegistry } from "../areas/index.ts";
import FIRST_SHAPES from "./ddl-first-shapes.json";

const DIR = join(process.cwd(), "resources");
const files = readdirSync(DIR).filter((name) => /^store-.*\.sql$/.test(name));
const resourceSqlFiles = readdirSync(DIR).filter((name) => name.endsWith(".sql"));
const dynamicSqlFiles = resourceSqlFiles.filter((file) =>
  readFileSync(join(DIR, file), "utf8").includes("EXECUTE IMMEDIATE"),
);
const staticSqlFiles = resourceSqlFiles.filter((file) => !dynamicSqlFiles.includes(file));

/** Statements without comments, split on top-level `;`. */
function statements(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Each `CREATE TABLE IF NOT EXISTS` in `text` and its column names, read
 * past parentheses (`DECIMAL(18,2)`) and quoted comments (`'a, b'`, `\'`).
 */
function tablesOf(text: string): { table: string; columns: string[]; at: number }[] {
  const tables: { table: string; columns: string[]; at: number }[] = [];
  const create = /CREATE TABLE IF NOT EXISTS IDENTIFIER\([^)]*'(\w+\.\w+)'\)\s*\(/g;
  for (let match = create.exec(text); match; match = create.exec(text)) {
    const parts: string[] = [];
    let current = "";
    let depth = 1;
    let quoted = false;
    for (let i = create.lastIndex; i < text.length; i++) {
      const c = text[i]!;
      if (quoted) {
        current += c;
        if (c === "\\") current += text[++i] ?? "";
        else if (c === "'") quoted = false;
        continue;
      }
      if (c === "'") quoted = true;
      if (c === "(") depth++;
      if (c === ")" && --depth === 0) break;
      if (c === "," && depth === 1) {
        parts.push(current);
        current = "";
        continue;
      }
      current += c;
    }
    parts.push(current);
    const columns = parts
      .map((part) => part.trim().split(/\s+/)[0]!)
      .filter((name) => name && name.toUpperCase() !== "CONSTRAINT");
    tables.push({ table: match[1]!, columns, at: match.index });
  }
  return tables;
}

const uncommented = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

/**
 * Columns a table didn't have in its first shape with no migration after its
 * CREATE: an information_schema-guarded `ADD COLUMN` built by a `SET VAR` and
 * run by `EXECUTE IMMEDIATE` of that variable.
 */
function unmigratedColumns(file: string): string[] {
  const text = uncommented(file);
  const known = FIRST_SHAPES as Record<string, string[]>;
  const migrations = statements(text).filter((s) => s.startsWith("SET VAR"));
  return tablesOf(text).flatMap(({ table, columns, at }) => {
    const [schema, name] = table.split(".");
    return columns
      .filter((column) => !known[table]?.includes(column))
      .filter((column) => {
        const migration = migrations.find(
          (s) =>
            s.includes(".information_schema.columns") &&
            s.includes("WHEN count(*) = 0") &&
            s.includes(`table_schema = :schema_prefix || '${schema}'`) &&
            s.includes(`table_name = '${name}'`) &&
            s.includes(`column_name = '${column}'`) &&
            s.includes(`\`${name}\` '`) &&
            s.includes(`'ADD COLUMN ${column} `),
        );
        const variable = migration && /^SET VAR (\w+) =/.exec(migration)?.[1];
        return !(
          migration &&
          variable &&
          text.indexOf(migration) > at &&
          text.includes(`EXECUTE IMMEDIATE ${variable};`)
        );
      })
      .map((column) => `${table}.${column}`);
  });
}

/** Split on a token outside quoted text and parentheses. */
function splitExpression(text: string, token: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === "'" && text[i + 1] === "'") i++;
      else if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && text.startsWith(token, i)) {
      parts.push(text.slice(start, i));
      start = i + token.length;
      i += token.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Databricks source literal → the text it contributes to generated SQL. */
function sourceLiteral(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return undefined;
  let value = "";
  for (let i = 1; i < trimmed.length - 1; i++) {
    const c = trimmed[i]!;
    if (c === "\\") value += trimmed[++i] ?? "";
    else if (c === "'" && trimmed[i + 1] === "'") {
      value += "'";
      i++;
    } else value += c;
  }
  return value;
}

/** Materialize a dynamic SQL expression, substituting safe text for runtime values. */
function materializeExpression(expression: string): string {
  return splitExpression(expression.trim(), "||")
    .map((raw) => {
      const part = raw.trim();
      const literal = sourceLiteral(part);
      if (literal !== undefined) return literal;
      if (/^coalesce\(/i.test(part) && part.endsWith(")")) {
        const args = splitExpression(part.slice(part.indexOf("(") + 1, -1), ",");
        return materializeExpression(args.at(-1) ?? "");
      }
      return "generated_value";
    })
    .join("");
}

/** Every expression whose text can reach EXECUTE IMMEDIATE in a resource. */
function generatedExecutableSql(text: string): string[] {
  const clean = uncommented(text);
  const direct = statements(clean)
    .filter((statement) => statement.startsWith("EXECUTE IMMEDIATE\n"))
    .map((statement) => materializeExpression(statement.replace(/^EXECUTE IMMEDIATE\s*/, "")));
  const guarded = [...clean.matchAll(/THEN\s+([\s\S]*?)\n\s*ELSE 'SELECT 1' END/g)].map(
    ([, expression]) => materializeExpression(expression!),
  );
  const collected = [...clean.matchAll(/collect_list\(\s*([\s\S]*?)\s*\)\s*\)/g)].map(
    ([, expression]) => materializeExpression(expression!),
  );
  return [...direct, ...guarded, ...collected];
}

/** SQL text must end outside a string; both \' and '' are safe embedded forms. */
function hasValidSqlQuotes(sql: string): boolean {
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "\\" && quoted) i++;
    else if (sql[i] === "'" && quoted && sql[i + 1] === "'") i++;
    else if (sql[i] === "'") {
      const neighbor = quoted ? sql[i + 1] : sql[i - 1];
      if (neighbor && /[A-Za-z0-9_]/.test(neighbor)) return false;
      quoted = !quoted;
    }
  }
  return !quoted;
}

const IDENTIFIER_RULE = "^[A-Za-z_][A-Za-z0-9_]*$";
const PREFIX_RULE = "^([A-Za-z_][A-Za-z0-9_]*)?$";

describe("provisioning DDL files", () => {
  it("covers every store DDL file the job runs", () => {
    const job = readFileSync(join(process.cwd(), "databricks.yml"), "utf8");
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) expect(job).toContain(`resources/${file}`);
  });

  it.each(files)("%s refuses unsafe catalog and prefix names before anything else", (file) => {
    const [first, second] = statements(readFileSync(join(DIR, file), "utf8"));
    expect(first).toBe(
      `SELECT assert_true(:catalog_name RLIKE '${IDENTIFIER_RULE}', 'catalog_name must be a plain identifier')`,
    );
    expect(second).toBe(
      `SELECT assert_true(:schema_prefix RLIKE '${PREFIX_RULE}', 'schema_prefix must be empty or a plain identifier')`,
    );
  });

  it.each(files)("%s escapes every name it splices into dynamic SQL", (file) => {
    const NAMES = /(:catalog_name|:schema_prefix|table_catalog|table_schema|table_name)/;
    const spliced = statements(readFileSync(join(DIR, file), "utf8")).flatMap((statement) => [
      // Text that becomes SQL: EXECUTE IMMEDIATE strings, the SQL a SET VAR
      // builds for one (up to its FROM), and the branch list built for one.
      ...(statement.includes("EXECUTE IMMEDIATE") ? [statement] : []),
      ...(statement.startsWith("SET VAR") ? [statement.split(/\n\s*FROM /)[0]!] : []),
      ...(statement.match(/collect_list\(([\s\S]*?)\)\)/)?.slice(1) ?? []),
    ]);
    for (const text of spliced) {
      // Remove the escaped form; nothing should be left concatenated raw.
      const rest = text.replace(
        /replace\((:catalog_name|:schema_prefix|table_catalog|table_schema|table_name), '`', '``'\)/g,
        "",
      );
      const raw = new RegExp(`\\|\\|\\s*${NAMES.source}|${NAMES.source}\\s*\\|\\|`).exec(rest);
      expect(
        raw?.[0],
        `${file}: a name is spliced without replace(…, '\`', '\`\`')`,
      ).toBeUndefined();
    }
  });

  it.each(files)("%s names every schema and table fully qualified", (file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    expect(text).not.toMatch(/IDENTIFIER\(:schema_prefix/);
  });

  it.each(files)("%s makes every table catalog-managed", (file) => {
    for (const statement of statements(readFileSync(join(DIR, file), "utf8"))) {
      if (/^CREATE TABLE/i.test(statement) && file !== "store-schema.sql") {
        expect(statement).toContain("'delta.feature.catalogManaged' = 'supported'");
      }
    }
  });

  it.each(files)("%s gives every audit branch arm the fixed last column", (file) => {
    // audit.actions UNIONs every branch, so one arm without
    // self_decision_test_mode fails the whole view with NUM_COLUMNS_MISMATCH.
    const branches = statements(readFileSync(join(DIR, file), "utf8")).filter((s) =>
      /audit`\.`\w+_branch` AS/.test(s),
    );
    for (const branch of branches) {
      const arms = branch.split("UNION ALL");
      for (const arm of arms) {
        expect(arm, `${file}: a branch arm`).toMatch(/ AS self_decision_test_mode '\s*\n/);
      }
    }
  });

  it("writes store-schema.sql's legacy tables only outside transactions", () => {
    // BEGIN ATOMIC on these tables fails live with
    // TRANSACTION_NOT_SUPPORTED.WRITE_NON_CATALOG_MANAGED_TABLE, so no command
    // (the only kind of write that runs a block) may lead with or touch them.
    const legacy = statements(readFileSync(join(DIR, "store-schema.sql"), "utf8"))
      .map((s) => /'(\w+\.\w+)'\)/.exec(s)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(legacy).toContain("requests.access_requests");
    const { writes } = createAppRegistry().list();
    for (const write of writes) {
      if (write.kind === "command") {
        const lead = `${write.leadActionTable.schema}.${write.leadActionTable.table}`;
        expect(legacy, `${write.area}/${write.name}`).not.toContain(lead);
      } else {
        expect(write.area, `${write.area}/${write.name}`).toBe("requests");
      }
    }
  });

  it("knows every table's first shape, so a later column can't slip in unmigrated", () => {
    const tables = files.flatMap((file) =>
      tablesOf(uncommented(readFileSync(join(DIR, file), "utf8"))),
    );
    expect(tables.length).toBeGreaterThan(20);
    const known = FIRST_SHAPES as Record<string, string[]>;
    for (const { table } of tables) {
      // A new table: add its columns to ddl-first-shapes.json when it ships.
      expect(known[table], `${table} isn't in ddl-first-shapes.json`).toBeDefined();
    }
  });

  it.each(files)("%s migrates every column a table didn't first have", (file) => {
    expect(unmigratedColumns(readFileSync(join(DIR, file), "utf8"))).toEqual([]);
  });

  it("generates each onboarding ALTER only while its column is missing", () => {
    const text = readFileSync(join(DIR, "store-onboarding.sql"), "utf8");
    const owners = /ADD COLUMN (initiative_owner_|person_match)/;
    const generated = generatedExecutableSql(text).filter((sql) => owners.test(sql));
    const columns = new Set([
      ...FIRST_SHAPES["onboarding.onboarding_requests"],
      ...FIRST_SHAPES["onboarding.onboarding_intake_owners"],
    ]);

    const run = () => {
      const executed: string[] = [];
      for (const sql of generated) {
        const column = /ADD COLUMN (\w+)/.exec(sql)?.[1];
        if (column && !columns.has(column)) {
          columns.add(column);
          executed.push(sql);
        } else executed.push("SELECT 1");
      }
      return executed;
    };

    // The initiative owner (103-A) and how each owner was matched (103-B).
    expect(generated).toHaveLength(12);
    expect(run()).toEqual(generated);
    expect([...columns].filter((column) => owners.test(`ADD COLUMN ${column}`))).toEqual([
      "initiative_owner_kind",
      "initiative_owner_display",
      "initiative_owner_email",
      "initiative_owner_principal_id",
      "initiative_owner_match_source",
      "initiative_owner_matched_by_principal_id",
      "initiative_owner_matched_by_display",
      "initiative_owner_matched_at",
      "person_match_source",
      "person_matched_by_principal_id",
      "person_matched_by_display",
      "person_matched_at",
    ]);
    expect(run()).toEqual(Array(12).fill("SELECT 1"));
  });

  it.each(dynamicSqlFiles)("%s generates valid SQL for every EXECUTE IMMEDIATE source", (file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    const generated = generatedExecutableSql(text);
    expect(generated.length, `${file}: no executable SQL extracted`).toBeGreaterThan(0);
    for (const sql of generated) {
      expect(hasValidSqlQuotes(sql), `${file}: ${sql}`).toBe(true);
    }
  });

  it.each(staticSqlFiles)("%s explicitly contains no dynamic SQL", (file) => {
    expect(generatedExecutableSql(readFileSync(join(DIR, file), "utf8"))).toEqual([]);
  });

  it.each([
    ["store-audit.sql", "Every action", "Every owner's action"],
    ["store-eir.sql", "Self-decision under", "Self-decision's under"],
    [
      "store-admin.sql",
      "ADD COLUMN result STRING COMMENT \\'Lead actions: the response",
      "ADD COLUMN result STRING COMMENT \\'Owner\\'s response",
    ],
  ] as const)("rejects a malformed apostrophe generated by %s", (file, before, after) => {
    const mutated = readFileSync(join(DIR, file), "utf8").replace(before, after);
    expect(generatedExecutableSql(mutated).some((sql) => !hasValidSqlQuotes(sql))).toBe(true);
  });

  it("rejects a malformed apostrophe in top-level SQL", () => {
    const text = readFileSync(join(DIR, "store-admin.sql"), "utf8");
    const mutated = text.replace("COMMENT 'One row per write check", "COMMENT 'check's");
    expect(hasValidSqlQuotes(uncommented(mutated))).toBe(false);
  });

  it("lets an existing store's display_number go null wherever new rows leave it unset", () => {
    // #177: records made since display codes have no display_number, but
    // CREATE TABLE IF NOT EXISTS never changes a store provisioned when the
    // column was NOT NULL, so the file must drop the constraint itself.
    const tables = [
      ["store-admin.sql", "admin.write_checks"],
      ["store-eir.sql", "eir.eirs"],
      ["store-onboarding.sql", "onboarding.onboarding_requests"],
    ] as const;
    for (const [file, table] of tables) {
      const text = uncommented(readFileSync(join(DIR, file), "utf8"));
      const created = tablesOf(text).find((t) => t.table === table)!;
      expect(created.columns, table).toContain("display_number");
      expect(text, table).not.toMatch(/\n\s*display_number BIGINT NOT NULL/);
      const drop = `ALTER TABLE IDENTIFIER(:catalog_name || '.' || :schema_prefix || '${table}') ALTER COLUMN display_number DROP NOT NULL;`;
      expect(text.indexOf(drop), `${file}: ${drop}`).toBeGreaterThan(created.at);
    }
  });

  it("would catch a column added only inside CREATE TABLE IF NOT EXISTS", () => {
    // The real file with its migration taken out: the rule must flag the column.
    const text = readFileSync(join(DIR, "store-admin.sql"), "utf8");
    const without = statements(text)
      .filter((s) => !s.includes("edp_migrate_write_check_actions_result"))
      .join(";\n");
    expect(unmigratedColumns(without)).toEqual(["admin.write_check_actions.result"]);
  });
});
