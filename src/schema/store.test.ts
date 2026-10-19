import { describe, expect, it } from "vitest";
import {
  CONFIG_PATH,
  cloneSchema,
  diffOnlySaveHandler,
  diffSchema,
  serializeConfig,
  unifiedDiff,
} from "./store";
import { loadSchema, type IntakeSchema } from "./index";

const base = loadSchema();

describe("serializeConfig / cloneSchema", () => {
  it("round-trips the loaded schema through serialize -> parse unchanged", () => {
    // The emitted config must parse back to exactly the loaded schema, so a
    // downloaded intake.config.json is a valid, faithful replacement.
    const parsed = JSON.parse(serializeConfig(base)) as IntakeSchema;
    expect(parsed).toEqual(base);
  });

  it("serializes with 2-space indent and a trailing newline (PR-clean form)", () => {
    const text = serializeConfig(base);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": 1');
  });

  it("cloneSchema produces an independent deep copy", () => {
    const clone = cloneSchema(base);
    expect(clone).toEqual(base);
    expect(clone).not.toBe(base);
    clone.optionLists.ingestPatterns[0]!.name = "changed";
    expect(base.optionLists.ingestPatterns[0]!.name).not.toBe("changed");
  });
});

describe("unifiedDiff", () => {
  it("returns an empty string for identical inputs", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nb\nc\n")).toBe("");
  });

  it("emits a valid hunk with +/- lines and file headers", () => {
    const before = "one\ntwo\nthree\nfour\n";
    const after = "one\ntwo!\nthree\nfour\n";
    const diff = unifiedDiff(before, after, "f.txt");
    expect(diff).toContain("--- a/f.txt");
    expect(diff).toContain("+++ b/f.txt");
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain("-two");
    expect(diff).toContain("+two!");
    // unchanged context lines are carried with a leading space
    expect(diff).toContain(" one");
  });

  it("represents a pure insertion as +lines only", () => {
    const diff = unifiedDiff("a\nb\n", "a\nNEW\nb\n", "f.txt");
    expect(diff).toContain("+NEW");
    expect(diff).not.toContain("-a");
    expect(diff).not.toContain("-b");
  });
});

describe("diffSchema", () => {
  it("is empty when nothing changed", () => {
    expect(diffSchema(base, cloneSchema(base))).toBe("");
  });

  it("reflects an edited field label", () => {
    const edited = cloneSchema(base);
    edited.fields[0]!.label = "Totally new label";
    const diff = diffSchema(base, edited);
    expect(diff).toContain('+      "label": "Totally new label"');
    expect(diff).toContain(`--- a/${CONFIG_PATH}`);
  });
});

// An INDEPENDENT unified-diff applier used to prove the emitted diff actually
// reconstructs the edited text when applied to the original (i.e. it's a real,
// appliable patch, not just a plausible-looking one).
function applyUnifiedDiff(original: string, diff: string): string {
  const strip = (t: string): string[] => {
    const lines = t.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const src = strip(original);
  const out: string[] = [];
  const dl = diff.split("\n");
  let srcPtr = 0;
  let i = 0;
  while (i < dl.length) {
    const line = dl[i];
    if (line === undefined) break;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      i++;
      continue;
    }
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number(m[1]);
    const oldCount = Number(m[2]);
    // 0-based index of the first old line the hunk touches (or the insertion
    // point when the old side is empty).
    const firstOld0 = (oldCount > 0 ? oldStart : oldStart + 1) - 1;
    while (srcPtr < firstOld0) {
      out.push(src[srcPtr] ?? "");
      srcPtr++;
    }
    i++;
    for (; i < dl.length; i++) {
      const b = dl[i];
      if (b === undefined || b.startsWith("@@")) break;
      const tag = b[0];
      if (tag === " ") {
        out.push(src[srcPtr] ?? b.slice(1));
        srcPtr++;
      } else if (tag === "-") {
        srcPtr++;
      } else if (tag === "+") {
        out.push(b.slice(1));
      } else {
        break;
      }
    }
  }
  while (srcPtr < src.length) {
    out.push(src[srcPtr] ?? "");
    srcPtr++;
  }
  return out.join("\n") + "\n";
}

describe("unifiedDiff — boundary hunk coordinates", () => {
  it("uses a zero old-line count at the top of the file (insertion into empty)", () => {
    expect(unifiedDiff("", "x\ny\n", "f.txt")).toContain("@@ -0,0 +1,2 @@");
  });

  it("uses a zero new-line count when everything is deleted", () => {
    expect(unifiedDiff("x\ny\nz\n", "", "f.txt")).toContain("@@ -1,3 +0,0 @@");
  });
});

describe("unifiedDiff — patch-application round-trips", () => {
  // For each edit shape: applying the emitted diff to the original text must
  // reproduce the edited text exactly.
  const cases: Array<[string, string, string]> = [
    ["rename (mid-file change)", "a\nb\nc\nd\ne\n", "a\nb\nCEE\nd\ne\n"],
    ["first-line change", "a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n"],
    ["last-line change", "a\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n"],
    ["insertion (mid-file)", "a\nb\nc\n", "a\nX\nb\nc\n"],
    ["insertion (at end)", "a\nb\nc\n", "a\nb\nc\nZ\n"],
    ["deletion (mid-file)", "a\nb\nc\nd\n", "a\nc\nd\n"],
    [
      "multiple separated hunks",
      "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n",
      "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nL11\nl12\n",
    ],
  ];
  for (const [name, before, after] of cases) {
    it(`reconstructs the edited text — ${name}`, () => {
      const diff = unifiedDiff(before, after, "f.txt");
      expect(applyUnifiedDiff(before, diff)).toBe(after);
    });
  }

  it("produces two separate hunks for two far-apart changes", () => {
    const before = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n";
    const after = "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nL11\nl12\n";
    const diff = unifiedDiff(before, after, "f.txt");
    expect(diff.match(/@@ /g)?.length).toBe(2);
  });
});

describe("diffSchema — patch applies back to the edited config", () => {
  const scenarios: Array<[string, (s: IntakeSchema) => void]> = [
    ["rename an option", (s) => (s.optionLists.ingestPatterns[0]!.name = "Renamed")],
    [
      "insert an option",
      (s) =>
        s.optionLists.source.push({
          id: "extra",
          name: "Extra source",
          desc: "",
          approved: true,
          box: "X",
        }),
    ],
    ["delete an option", (s) => s.optionLists.accessPatterns.pop()],
    ["change a sizing coefficient", (s) => (s.sizing.cplxFactor["Heavy"] = 9)],
    [
      "two far-apart changes (multi-hunk)",
      (s) => {
        s.version = 2;
        s.fields[0]!.label = "Way down the file";
      },
    ],
  ];
  for (const [name, mutate] of scenarios) {
    it(`round-trips via git-style patch — ${name}`, () => {
      const edited = cloneSchema(base);
      mutate(edited);
      const diff = diffSchema(base, edited);
      expect(diff).not.toBe("");
      expect(applyUnifiedDiff(serializeConfig(base), diff)).toBe(serializeConfig(edited));
    });
  }
});

describe("diffOnlySaveHandler (P1: no runtime write)", () => {
  it("reports no change and empty diff when the edit is a no-op", () => {
    const res = diffOnlySaveHandler(base, cloneSchema(base));
    expect(res.changed).toBe(false);
    expect(res.diff).toBe("");
    expect(res.path).toBe(CONFIG_PATH);
  });

  it("emits a diff + full config that round-trips to a valid schema", () => {
    const edited = cloneSchema(base);
    edited.sizing.freqFactor["Daily"] = 2;
    const res = diffOnlySaveHandler(base, edited);

    expect(res.changed).toBe(true);
    expect(res.diff).toContain('+      "Daily": 2');
    // the emitted full config parses back to exactly the edited schema
    const parsed = JSON.parse(res.config) as IntakeSchema;
    expect(parsed).toEqual(edited);
    expect(parsed.sizing.freqFactor["Daily"]).toBe(2);
    // the handler adopts the edited schema as the in-app state to use
    expect(res.schema).toBe(edited);
  });
});
