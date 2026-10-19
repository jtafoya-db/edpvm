// Additive schema-store glue for the EDP admin editor (docs/build-plan-p1.md
// §2, OQ-7). This is the WRITE side of the loadSchema() seam: loadSchema() reads
// the schema, and a SchemaSaveHandler persists an edit. In P1 the schema is
// repo-backed, so the default handler performs NO runtime/prod write — it emits
// a PR-ready config diff (and the full new intake.config.json) the admin copies
// into a pull request ("here's your change — submit it for deploy"). A later
// phase (P2+) swaps in a handler that writes a Delta/UC store, and because the
// editor only ever calls the handler, that swap is a one-function change.

import type { IntakeSchema } from "./types";

/** Repo path the emitted diff/config targets (used for the unified-diff headers). */
export const CONFIG_PATH = "src/schema/intake.config.json";

/** Deep clone a schema so edits never mutate the loaded (original) instance. */
export function cloneSchema(schema: IntakeSchema): IntakeSchema {
  return JSON.parse(JSON.stringify(schema)) as IntakeSchema;
}

/** Serialize a schema to the on-disk intake.config.json form (2-space indent +
 * trailing newline) so an emitted diff applies cleanly against the repo file. */
export function serializeConfig(schema: IntakeSchema): string {
  return JSON.stringify(schema, null, 2) + "\n";
}

// ---- unified diff (dependency-free, LCS based) ----------------------------

type DiffType = "eq" | "del" | "add";
interface DiffOp {
  type: DiffType;
  line: string;
}

/** Longest-common-subsequence walk producing an ordered eq/del/add op list. */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lcs[i*width+j] = LCS length of a[i:] and b[j:]; filled bottom-up.
  const lcs = new Array<number>((n + 1) * width).fill(0);
  const get = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? get(i + 1, j + 1) + 1 : Math.max(get(i + 1, j), get(i, j + 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i] ?? "" });
      i++;
      j++;
    } else if (get(i + 1, j) >= get(i, j + 1)) {
      ops.push({ type: "del", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i] ?? "" });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j] ?? "" });
    j++;
  }
  return ops;
}

interface Anno extends DiffOp {
  oldNo: number;
  newNo: number;
}

/**
 * Produce a standard unified diff between two texts. Returns "" when they are
 * identical. Changes within `context` lines of each other are merged into one
 * hunk, each headed by `@@ -oldStart,oldCount +newStart,newCount @@`.
 */
export function unifiedDiff(
  before: string,
  after: string,
  path = CONFIG_PATH,
  context = 3,
): string {
  // Split into lines, dropping the single trailing newline both texts carry so
  // the terminating newline isn't diffed as a spurious trailing empty line.
  const splitLines = (t: string): string[] => {
    const lines = t.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffOps(a, b);

  let oldNo = 1;
  let newNo = 1;
  const annotated: Anno[] = ops.map((op) => {
    const entry: Anno = { ...op, oldNo, newNo };
    if (op.type === "eq") {
      oldNo++;
      newNo++;
    } else if (op.type === "del") {
      oldNo++;
    } else {
      newNo++;
    }
    return entry;
  });

  const changedIdx = annotated
    .map((op, idx) => (op.type === "eq" ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (changedIdx.length === 0) return "";

  // Group changed lines into hunk ranges, expanding by `context` and merging
  // ranges that touch or overlap.
  const ranges: Array<[number, number]> = [];
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(annotated.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of ranges) {
    const seg = annotated.slice(start, end + 1);
    const first = seg[0];
    if (!first) continue;
    let oldCount = 0;
    let newCount = 0;
    for (const op of seg) {
      if (op.type !== "add") oldCount++;
      if (op.type !== "del") newCount++;
    }
    // Unified-diff convention: a side with zero lines in the hunk (a pure
    // insertion's old side, or a pure deletion's new side) reports the line
    // number of the line PRECEDING the hunk — 0 at the top of the file — not
    // the first in-hunk line number. This keeps headers valid for `git apply`
    // at first-line, last-line and empty-file boundaries.
    const oldStart = oldCount === 0 ? first.oldNo - 1 : first.oldNo;
    const newStart = newCount === 0 ? first.newNo - 1 : first.newNo;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of seg) {
      const prefix = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
      out.push(prefix + op.line);
    }
  }
  return out.join("\n") + "\n";
}

/** Unified diff of two schemas' serialized configs. "" when identical. */
export function diffSchema(
  original: IntakeSchema,
  edited: IntakeSchema,
  path = CONFIG_PATH,
): string {
  return unifiedDiff(serializeConfig(original), serializeConfig(edited), path);
}

// ---- save handler seam ----------------------------------------------------

export interface SchemaSaveResult {
  /** the edited schema the app adopts as its live in-app state */
  schema: IntakeSchema;
  /** the full new intake.config.json (copy/download to submit as a PR) */
  config: string;
  /** unified diff of original -> edited ("" when nothing changed) */
  diff: string;
  /** whether the edit changed anything */
  changed: boolean;
  /** repo path the diff/config targets */
  path: string;
}

/**
 * The write side of the loadSchema() seam. P1 emits a diff (see
 * diffOnlySaveHandler); a later phase can swap in a handler that persists to a
 * Delta/UC store. The admin editor only ever calls a handler of this type, so
 * it never hardcodes the config file path or knows where the schema lives.
 */
export type SchemaSaveHandler = (original: IntakeSchema, edited: IntakeSchema) => SchemaSaveResult;

/**
 * P1 default handler: NO runtime/prod write. Computes the PR-ready unified diff
 * and the full new intake.config.json from original vs edited, and hands them
 * back for the admin to submit as a pull request.
 */
export const diffOnlySaveHandler: SchemaSaveHandler = (original, edited) => {
  const diff = diffSchema(original, edited);
  return {
    schema: edited,
    config: serializeConfig(edited),
    diff,
    changed: diff.length > 0,
    path: CONFIG_PATH,
  };
};
