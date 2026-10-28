// @vitest-environment node
/**
 * The EIR tables' first shipped shape (#126).
 *
 * The `eir` tables are new in #126 and never shipped before it, so the shape
 * `resources/store-eir.sql` creates here is their first: it's recorded in
 * `ddl-first-shapes.json`, and from then on #128's guard
 * (`ddl-files.test.ts`) refuses a column added without an
 * information_schema-guarded migration. Shapes that only ever existed on
 * PR #134's own previews were dropped, not upgraded.
 *
 * This pins that recorded first shape to what the file creates, apart from
 * the columns added since with a guarded migration ({@link ADDED_SINCE}), so
 * a later change to an EIR table has to go through that path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import FIRST_SHAPES from "./ddl-first-shapes.json";

/** Each `CREATE TABLE IF NOT EXISTS` in the file and its column names, in order. */
function createdColumns(text: string): Record<string, string[]> {
  const tables: Record<string, string[]> = {};
  const create =
    /CREATE TABLE IF NOT EXISTS IDENTIFIER\([^)]*'(\w+\.\w+)'\)\s*\(([\s\S]*?)\n\)\nCOMMENT/g;
  for (const match of text.matchAll(create)) {
    tables[match[1]!] = match[2]!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("CONSTRAINT") && !line.startsWith("--"))
      .map((line) => line.split(/\s+/)[0]!);
  }
  return tables;
}

/** Columns added after the first shape, each with its migration in store-eir.sql. */
const ADDED_SINCE: Record<string, string[]> = {
  // #177: the Record ID became a display code (ADR-0007 decision 2, amended 2026-10-10).
  "eir.eirs": ["display_code"],
  // #204: a durable order for a draft's evaluations.
  "eir.eir_evaluations": ["evaluation_sequence"],
};

describe("EIR tables' first shipped shape", () => {
  const ddl = readFileSync(join(process.cwd(), "resources/store-eir.sql"), "utf8");
  const created = createdColumns(ddl);

  it("is recorded for every EIR table, as store-eir.sql creates it less the columns added since", () => {
    expect(Object.keys(created).sort()).toEqual([
      "eir.eir_actions",
      "eir.eir_draft_saves",
      "eir.eir_drafts",
      "eir.eir_evaluations",
      "eir.eir_submissions",
      "eir.eirs",
    ]);
    const known = FIRST_SHAPES as Record<string, string[]>;
    for (const [table, columns] of Object.entries(created)) {
      expect(known[table], table).toEqual(
        columns.filter((column) => !ADDED_SINCE[table]?.includes(column)),
      );
    }
  });

  it("includes the Record ID and form-version columns from the start", () => {
    expect(created["eir.eirs"]).toEqual(expect.arrayContaining(["display_number", "display_code"]));
    expect(created["eir.eir_submissions"]).toEqual(
      expect.arrayContaining(["form_version", "form_started_at"]),
    );
    expect(created["eir.eir_drafts"]).toEqual(
      expect.arrayContaining(["form_version", "form_started_at"]),
    );
  });

  it("constrains system-attributed EIR evaluation actions and outcomes", () => {
    expect(ddl).toContain("eir_evaluations_action CHECK (action IN ('evaluated'))");
    expect(ddl).toContain(
      "eir_evaluations_outcome CHECK (outcome IN ('pass', 'blocking', 'warning', 'manual-review'))",
    );
    expect(ddl).toContain(
      "eir_evaluations_actor_app CHECK (actor_app IN ('tenant', 'staff', 'job', 'system'))",
    );
    expect(ddl).toContain("eir_evaluations_evaluator_app CHECK (evaluator_app IN ('system'))");
  });
});
