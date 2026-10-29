import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROLE_DESCRIPTIONS,
  validateRoleDescriptions,
  type RoleDescriptions,
} from "../datasets/role-descriptions";
import { DATASET_ROLES } from "../datasets/types";

// #260 (decided on #141, 2026-10-18): the dataset role users see as
// "Maintainer" is stored as `manager`. The display name changes; the stored
// value, group names and grants don't.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("role descriptions: Maintainer", () => {
  const maintainer = DEFAULT_ROLE_DESCRIPTIONS.roles.manager;

  it("keeps the stored role value `manager`", () => {
    expect(DATASET_ROLES).toEqual(["tester", "developer", "manager"]);
  });

  it("labels the stored `manager` role Maintainer, singular and plural", () => {
    expect(maintainer.label).toBe("Maintainer");
    expect(maintainer.pluralLabel).toBe("Maintainers");
    expect(DEFAULT_ROLE_DESCRIPTIONS.roles.tester.pluralLabel).toBe("Testers");
    expect(DEFAULT_ROLE_DESCRIPTIONS.roles.developer.pluralLabel).toBe("Developers");
  });

  it("describes running the dataset's jobs and its published-prod permissions, not managing members", () => {
    expect(maintainer.summary).toMatch(/everything a developer has/i);
    expect(maintainer.summary).toMatch(/running the dataset's jobs/i);
    expect(maintainer.summary).toMatch(/permissions on what (the dataset|it) publishes in prod/i);
    expect(maintainer.summary).not.toMatch(/member/i);
  });

  it("leaves the grants copied onto change-list entries unchanged", () => {
    expect(maintainer.grants).toEqual([
      "Everything a developer has",
      "Manage permissions on what the dataset publishes in prod",
    ]);
  });

  it("refuses a configuration without a plural label", () => {
    const config = structuredClone(DEFAULT_ROLE_DESCRIPTIONS) as RoleDescriptions;
    (config.roles.manager as { pluralLabel?: string }).pluralLabel = " ";
    expect(() => validateRoleDescriptions(config)).toThrow(/manager role a label, a plural label/);
  });
});

describe("GLOSSARY: Maintainer", () => {
  const glossary = read("GLOSSARY.md");
  const entry = (term: string) =>
    new RegExp(`\\*\\*${term}\\*\\*:\\n([^\\n]+)\\n_Avoid_: ([^\\n]+)`).exec(glossary);

  it("defines Maintainer by what sets it apart, with the stored value and no say over members", () => {
    const maintainer = entry("Maintainer");
    expect(maintainer).not.toBeNull();
    const [, definition, avoid] = maintainer!;
    expect(definition).toMatch(/everything a developer has/i);
    expect(definition).toMatch(/runs? the dataset's jobs/i);
    expect(definition).toMatch(/permissions on what the dataset publishes in prod/i);
    expect(definition).toMatch(/`manager`/);
    expect(definition).toMatch(/can't add or remove/i);
    expect(avoid).toMatch(/\bManager\b/);
  });

  it("has no Manager entry, and says dataset owners hold Maintainer and decide the team", () => {
    expect(entry("Manager")).toBeNull();
    const [, owner] = entry("Dataset owner")!;
    expect(owner).toMatch(/holds the dataset's Maintainer role/);
    expect(owner).toMatch(/decides who/);
    const [, role] = entry("Dataset role")!;
    expect(role).toMatch(/tester, developer, or Maintainer/);
  });
});

describe("ADRs carry a Maintainer terminology amendment", () => {
  it.each([
    "docs/adr/0005-domain-access-model.md",
    "docs/adr/0006-email-matched-dataset-owners.md",
    "docs/adr/0007-mvp-delta-data-model.md",
    "docs/adr/0008-separate-tenant-and-staff-apps.md",
  ])("%s", (path) => {
    const amendment = /## Terminology amendment \(#260\)\n\n([\s\S]+?)(\n## |$)/.exec(read(path));
    expect(amendment, `${path} has no terminology amendment`).not.toBeNull();
    expect(amendment![1]).toMatch(/Maintainer/);
    expect(amendment![1]).toMatch(/`manager`/);
  });
});

// ---- the vocabulary guard ------------------------------------------------
//
// Every string, JSX text and comment in the app's code (tests and fixtures
// included), and every line of the docs, config and DDL, is checked for
// "manager" as a word. Identifiers aren't prose, so `let manager` or
// `roles.manager` never count; test titles and test comments aren't shown to
// anyone, so they're skipped too. What may still say manager is listed below,
// occurrence by occurrence, each with why.

/** Something a person can read: one string, JSX text, comment or doc line. */
interface Prose {
  path: string;
  line: number;
  text: string;
  /** The property, JSX attribute, JSON key or YAML key this is the value of. */
  field?: string | undefined;
  /** Exactly the stored value, in a position that stores or compares it. */
  stored?: boolean | undefined;
}

const EIR_PATHS = /(^|\/)eir[-./]|\/Eir\//i;

/** "manager" as a word, any case; `_`, `-` and `.` don't hide it, a letter does (`managerId`). */
const MANAGER = /(?<![A-Za-z])managers?(?![A-Za-z])/i;
const isTest = (path: string) => /\.test\.|__tests__\//.test(path);

/** Fields that hold a role id, never display text. */
const ROLE_FIELDS = new Set([
  "role",
  "newRole",
  "replacedRole",
  "held",
  "from",
  "to",
  "id",
  "inherits",
]);
/** Calls whose string argument is a role id or a stored value under test. */
const STORED_CALLEES = new Set([
  "includes",
  "startsWith",
  "count",
  "datasetGroupName",
  "roleLabel",
  "toBe",
]);

/** The node a literal really sits in, past `as`, `satisfies`, `!` and parentheses. */
function container(node: ts.Node): { node: ts.Node; parent: ts.Node } {
  let n = node;
  while (
    ts.isAsExpression(n.parent) ||
    ts.isSatisfiesExpression(n.parent) ||
    ts.isNonNullExpression(n.parent) ||
    ts.isParenthesizedExpression(n.parent)
  ) {
    n = n.parent;
  }
  return { node: n, parent: n.parent };
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
}

/**
 * Whether a literal that says exactly `manager` stores or compares the role id
 * rather than showing it: a comparison or `case`, a union type, an element
 * access, a role-id field, an array of identifier-like values, or a named call.
 * JSX text, JSX attributes, `${…}` and every other field are display positions.
 */
function storedPosition(literal: ts.Node, path: string): boolean {
  const { node, parent } = container(literal);
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // `x.inherits = "manager"`: assigned to a role-id field.
    return (
      parent.right === node &&
      ts.isPropertyAccessExpression(parent.left) &&
      ROLE_FIELDS.has(parent.left.name.text)
    );
  }
  if (ts.isBinaryExpression(parent)) {
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind);
  }
  if (ts.isCaseClause(parent)) return parent.expression === node;
  if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === node;
  if (ts.isPropertyAssignment(parent)) {
    return (
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      ROLE_FIELDS.has(parent.name.text)
    );
  }
  if (ts.isArrayLiteralExpression(parent)) {
    // An EIR form-field tuple starts with its section id.
    if (EIR_PATHS.test(path) && parent.elements[0] === node) return true;
    // A row of an `it.each` / `describe.each` table: a test parameter.
    if (isTest(path) && isEachRow(parent)) return true;
    // Otherwise only an array of ids: every string in it is lowercase and identifier-like.
    return parent.elements.every(
      (e) =>
        !(ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ||
        /^[a-z0-9_.:{}-]+$/.test(e.text),
    );
  }
  if (ts.isCallExpression(parent)) {
    return (
      parent.arguments.includes(node as ts.Expression) &&
      STORED_CALLEES.has(calleeName(parent) ?? "")
    );
  }
  return false;
}

/** Whether an array is one row of the table passed to `it.each` / `describe.each`. */
function isEachRow(row: ts.ArrayLiteralExpression): boolean {
  let table: ts.Node = row.parent;
  while (ts.isAsExpression(table) || ts.isSatisfiesExpression(table)) table = table.parent;
  if (!ts.isArrayLiteralExpression(table)) return false;
  let call: ts.Node = table.parent;
  while (ts.isAsExpression(call) || ts.isSatisfiesExpression(call)) call = call.parent;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "each"
  );
}

function fieldOf(literal: ts.Node): string | undefined {
  const { node, parent } = container(literal);
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)
      ? parent.name.text
      : undefined;
  }
  if (ts.isJsxAttribute(parent)) return parent.name.getText();
  return undefined;
}

/** The strings, JSX text and comments in one source file. */
function codeProse(path: string, source: string): Prose[] {
  const kind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : path.endsWith(".js")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const test = isTest(path);
  const out: Prose[] = [];
  const at = (pos: number) => file.getLineAndCharacterOfPosition(pos).line + 1;
  const seen = new Set<number>();

  /** `it("…")`, `describe.each(…)("…")`: a test title, not something users see. */
  const isTitle = (literal: ts.Node) => {
    const call = literal.parent;
    if (!test || !ts.isCallExpression(call) || call.arguments[0] !== literal) return false;
    let callee: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
      callee = callee.expression;
    }
    return ts.isIdentifier(callee) && /^(it|test|describe)$/.test(callee.text);
  };

  const visit = (node: ts.Node) => {
    if (!test) {
      for (const r of ts.getLeadingCommentRanges(source, node.pos) ?? []) {
        if (seen.has(r.pos)) continue;
        seen.add(r.pos);
        // A comment is read as one piece, so wrapped phrases stay whole.
        out.push({
          path,
          line: at(r.pos),
          text: source
            .slice(r.pos, r.end)
            .replace(/\n\s*\*(?!\/)/g, " ")
            .replace(/\s+/g, " "),
        });
      }
    }
    if (ts.isJsxText(node)) {
      out.push({ path, line: at(node.getStart()), text: node.text });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isTitle(node)) {
        out.push({
          path,
          line: at(node.getStart()),
          text: node.text,
          field: fieldOf(node),
          stored: node.text === "manager" && storedPosition(node, path),
        });
      }
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const template = ts.isTemplateHead(node) ? node.parent : node.parent.parent;
      if (!isTitle(template)) out.push({ path, line: at(node.getStart()), text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** JSON key paths where `manager` is the role id: a key under them, or their value. */
const JSON_ROLE_PATHS: Record<string, RegExp> = {
  "src/data/datasets/role-descriptions.json": /^roles$/,
  "src/data/datasets/access-matrix.json": /^roles$/,
};

/** Every key and string value in a JSON file, keyed by its path. */
function jsonProse(path: string, source: string): Prose[] {
  const lines = source.split("\n");
  const lineOf = (text: string) => Math.max(1, lines.findIndex((l) => l.includes(text)) + 1);
  const rolePath = JSON_ROLE_PATHS[path];
  const out: Prose[] = [];
  const walkJson = (value: unknown, at: string[]) => {
    if (typeof value === "string") {
      out.push({ path, line: lineOf(JSON.stringify(value)), text: value, field: at.at(-1) });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        out.push({
          path,
          line: lineOf(`"${key}"`),
          text: key,
          stored: key === "manager" && !!rolePath?.test(at.join(".")),
        });
        walkJson(child, [...at, key]);
      }
    }
  };
  walkJson(JSON.parse(source), []);
  return out;
}

/** Each line of a doc, YAML or DDL file; a YAML key is the value's field. */
function docProse(path: string, source: string): Prose[] {
  return source.split("\n").map((line, i) => {
    const yaml = /\.ya?ml$/.test(path) ? /^\s*-?\s*([\w-]+):\s*(.*)$/.exec(line) : null;
    const text = yaml ? yaml[2]!.replace(/^"(.*)"$/, "$1") : line;
    return {
      path,
      line: i + 1,
      text,
      field: yaml?.[1],
      // An EIR section id; ids aren't shown.
      stored: !!yaml && EIR_PATHS.test(path) && yaml[1] === "id" && text === "manager",
    };
  });
}

function prose(path: string, source: string): Prose[] {
  return /\.(tsx?|jsx?)$/.test(path)
    ? codeProse(path, source)
    : /\.json$/.test(path)
      ? jsonProse(path, source)
      : docProse(path, source);
}

/**
 * Ids built on the stored value, allowed anywhere. The bare value isn't here:
 * code gets it only in a stored position, prose only as `manager` on a line
 * that says it's stored.
 */
const STORED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bowner-holds-manager\b/g, why: "the refusal's error code" },
  {
    pattern: /\bedp-[\w{}]+-manager(?:-[\w{}]+)?(?![\w-])/g,
    why: "a dataset group name, `edp-<dataset tag>-manager[-<env>]`, from group-naming config",
  },
  {
    pattern: /(?<=\bstored\b.*)`manager`|`manager`(?=.*\bstored\b)/gi,
    why: "the stored value, quoted as code, on a line that says it's stored",
  },
];

/** Occurrences that may still say manager, each tied to the files it's in. */
const ALLOWED: { path: RegExp; field?: string; pattern: RegExp; why: string }[] = [
  {
    path: EIR_PATHS,
    pattern:
      /\b(?:your|their|listed|current|alternative) manager\b|\bmanager's\b|\bmanager ID\b|\bmanager(?:-[\w]+)+|\btest\.manager[\w.@]*|\bsample\.manager@example\.gov\b|\blast name Manager\b/gi,
    why: "EIR: the person's line manager",
  },
  {
    path: EIR_PATHS,
    field: "managerLastName",
    pattern: /^Manager$/g,
    why: "EIR samples and fixtures: the sample line manager's surname (managerLastName)",
  },
  {
    path: /^scripts\/eir-live-check\.ts$/,
    pattern: /\bname, email, ID or manager\b/g,
    why: "EIR live check: the sample person's line manager",
  },
  {
    path: /^src\/features\/registry\.ts$/,
    pattern: /\bThe person types their manager\b/g,
    why: "the EIR form's note: the person's line manager",
  },
  {
    path: /^(src\/server\/delta\/__tests__\/teams-area\.test|scripts\/delta-teams-live-check)\.ts$/,
    pattern: /\brole = 'manager'/g,
    why: "a SQL predicate on the stored value",
  },
  {
    path: /^resources\/store-teams\.sql$/,
    pattern: /\brole IN \('tester', 'developer', 'manager'\)/g,
    why: "the CHECK constraints on the stored role value",
  },
  {
    path: /^docs\/data-model\.md$/,
    pattern: /`tester`, `developer`,? (?:or )?`manager`/g,
    why: "the data model's tables of stored role values",
  },
  {
    path: /^src\/server\/access-matrix\.ts$/,
    pattern: /\broles\.manager\.inherits\b/g,
    why: "the access-matrix validator names the config path it checks",
  },
  {
    path: /^docs\/data-model\.md$/,
    pattern: /\bManager ID format\b/g,
    why: "the EIR rule set: the line manager's ID",
  },
  {
    path: /^src\/legacy\/appData\.js$/,
    pattern: /^Tenant manager\b.*$|^Manager(?: → .*)?$/g,
    why:
      "the prototype's approvers and approval chains: a tenant's manager, not the dataset role. " +
      "Only the coming-soon access-bundles and request-status-tracking screens use them, and " +
      "FeatureGate never renders those",
  },
  {
    path: /^src\/data\/__tests__\/fixture\.ts$/,
    pattern: /^Manager -> .*$|^Tenant manager$/g,
    why: "reference-data fixture for the same approval chains, never rendered",
  },
  {
    path: /^GLOSSARY\.md$/,
    pattern: /^_Avoid_: .*$/g,
    why: "placeholder; replaced below by the exact avoided terms",
  },
  {
    path: /^docs\/adr\/0008-separate-tenant-and-staff-apps\.md$/,
    pattern: /\bgroup manager\b/g,
    why: "Databricks' own group manager role on a group",
  },
  {
    path: /^resources\/store-teams\.sql$/,
    pattern: /Every owner also holds the manager role\.|'tester, developer or manager'/g,
    why:
      "Delta table and column COMMENTs naming the stored values; changing the DDL is out of " +
      "scope (#260 keeps the schema)",
  },
  {
    path: /^docs\/governance-research\.md$/,
    pattern: /tester, developer, and manager groups/g,
    why: "dated research (2026-10-01), cited as it was written",
  },
];
// On GLOSSARY _Avoid_ lines only the avoided terms themselves are allowed.
ALLOWED.splice(
  ALLOWED.findIndex((a) => a.path.source.includes("GLOSSARY")),
  1,
  {
    path: /^GLOSSARY\.md$/,
    pattern: /(?<=^_Avoid_: .*)\b(?:Manager|tenant manager|data manager)\b/g,
    why: "GLOSSARY: Manager and its variants, listed as words to avoid",
  },
);

/** Where a prose item still says manager outside what's allowed. */
function managerHits(items: Prose[]): string[] {
  return items
    .filter(({ path, text, field, stored }) => {
      if (stored) return false;
      let rest = STORED.reduce((t, s) => t.replace(s.pattern, ""), text);
      for (const a of ALLOWED) {
        if (a.path.test(path) && (a.field === undefined || a.field === field)) {
          rest = rest.replace(a.pattern, "");
        }
      }
      return MANAGER.test(rest);
    })
    .map(({ path, line, text }) => `${path}:${line}: ${text.trim().slice(0, 120)}`);
}

/** Apply the same cheap pre-filter used by the repository scan. */
function scanSource(path: string, source: string): string[] {
  const decoded = source.replace(
    /\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\(?:\r\n?|\n)|\\(.)/gis,
    (
      escape,
      braced: string | undefined,
      fixed: string | undefined,
      hex: string | undefined,
      char,
    ) => {
      const code = braced ?? fixed ?? hex;
      if (code) {
        const point = Number.parseInt(code, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : escape;
      }
      return char ?? "";
    },
  );
  return /manager/i.test(decoded) ? managerHits(prose(path, source)) : [];
}

/** Not scanned: the guard's own patterns and examples have to spell the word. */
const GUARD = "src/data/__tests__/maintainer-vocabulary.test.ts";

function walk(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isDirectory()) {
    return readdirSync(full).flatMap((name) => walk(relative(ROOT, join(full, name))));
  }
  return path !== GUARD && /\.(tsx?|jsx?|json|md|ya?ml|sql)$/.test(path) ? [path] : [];
}

describe("the vocabulary guard catches Manager in each place it could come back", () => {
  const hits = (path: string, source: string) => scanSource(path, source);

  it.each([
    ["JSX text", "src/components/X.tsx", "const a = <span>Owner: holds manager</span>;"],
    ["a string", "src/components/X.tsx", 'const label = "Managers";'],
    [
      "a template literal",
      "src/server/x.ts",
      "const m = `every owner holds the ${x} manager role`;",
    ],
    ["a comment", "src/data/x.ts", "// Owners hold the manager role.\nexport const a = 1;"],
    [
      "a test fixture's display string",
      "src/data/__tests__/x.test.ts",
      'const r = { label: "Manager" };',
    ],
    ["a rendered legacy string", "src/legacy/x.jsx", "const a = <p>The Manager role</p>;"],
    [
      "dataset-role prose in an EIR file",
      "src/data/eir/config.ts",
      'const a = "Holds the Manager role";',
    ],
    ["a JSON value", "src/data/datasets/role-descriptions.json", '{ "label": "Manager" }'],
    ["a YAML value outside EIR", "src/x.yaml", "  label: Manager"],
    ["a doc", "docs/x.md", "Owners hold the manager role."],
    ["glossary prose", "GLOSSARY.md", "A dataset owner holds the manager role."],
    ["role prose on an _Avoid_ line", "GLOSSARY.md", "_Avoid_: Manager, the manager role"],
    [
      "DDL beyond the one table COMMENT",
      "resources/store-teams.sql",
      "COMMENT 'In the manager group.'",
    ],
    // Role prose dressed up as code or as an identifier still counts (#292 review).
    ["a hyphenated role name in a doc", "docs/x.md", "Ask the Dataset-manager role."],
    ["role prose inside backticks", "docs/x.md", "The display name is `manager role`."],
    ["plain role prose ending a sentence", "docs/x.md", "Ask them for the manager role."],
    [
      "a backticked display label in an ADR",
      "docs/adr/0005-domain-access-model.md",
      "Shown as `Manager`.",
    ],
    [
      "a dotted role name in an ADR",
      "docs/adr/0007-mvp-delta-data-model.md",
      "Owners hold dataset.manager rights.",
    ],
    ["a glossary heading", "GLOSSARY.md", "**Manager**:"],
    [
      "an underscored role in glossary prose",
      "GLOSSARY.md",
      "Owners hold the dataset_manager role.",
    ],
    [
      "a hyphenated role in a JSON value",
      "src/data/datasets/role-descriptions.json",
      '{ "summary": "Runs the dataset-manager jobs" }',
    ],
    [
      "a backticked phrase in a JSON value",
      "src/x.json",
      '{ "note": "Ask a `manager role` holder" }',
    ],
    [
      "a hyphenated role in a string",
      "src/components/X.tsx",
      'const t = "The Dataset-manager role";',
    ],
    [
      "a backticked phrase in a comment",
      "src/data/x.ts",
      "// Owners get the `manager role` too.\nexport const a = 1;",
    ],
    // The bare stored value, shown to users (#292 round 3).
    ["the stored value as JSX text", "src/components/X.tsx", "const a = <span>manager</span>;"],
    [
      "the stored value as JSX expression text",
      "src/components/X.tsx",
      'const a = <span>{"manager"}</span>;',
    ],
    ["the stored value as a label", "src/components/X.tsx", 'const label = "manager";'],
    [
      "the stored value as an aria-label",
      "src/components/X.tsx",
      'const a = <button aria-label="manager" />;',
    ],
    [
      "the stored value as a title prop",
      "src/components/X.tsx",
      'const a = <abbr title="manager">M</abbr>;',
    ],
    [
      "the stored value as a display field",
      "src/data/x.ts",
      'const card = { description: "manager" };',
    ],
    ["the stored value as a template literal", "src/components/X.tsx", "const t = `manager`;"],
    [
      "the stored value rendered by a template",
      "src/components/X.tsx",
      'const t = `${n} ${"manager"}`;',
    ],
    ["the stored value, quoted in a doc", "docs/x.md", "The display name is 'manager'."],
    ["the stored value, backticked in a doc", "docs/x.md", "Shown as `manager`."],
    ["uppercase in a doc", "docs/x.md", "Ask the MANAGER."],
    ["uppercase in a string", "src/components/X.tsx", 'const t = "MANAGER";'],
    [
      "a JSON value outside a role-id field",
      "src/data/datasets/role-descriptions.json",
      '{ "roles": { "manager": { "label": "manager" } } }',
    ],
    ["the role-id key outside its named config", "src/x.json", '{ "manager": { "a": 1 } }'],
    [
      "a display-string array",
      "src/components/X.tsx",
      'const cards = ["Tester", "Developer", "manager"];',
    ],
    [
      "a YAML value outside a role-id field",
      "src/data/eir/definition/bootstrap-2.eir.yaml",
      "    title: manager",
    ],
    ["a four-digit Unicode escape", "src/components/X.tsx", 'const t = "\\u004danager role";'],
    ["a braced Unicode escape", "src/components/X.tsx", 'const t = "\\u{4d}anager role";'],
    ["a hexadecimal escape", "src/components/X.tsx", 'const t = "Man\\x61ger role";'],
    [
      "a string line continuation",
      "src/components/X.tsx",
      'const t = "Mana' + "\\" + '\nger role";',
    ],
    [
      "a template line continuation",
      "src/components/X.tsx",
      "const t = `Mana" + "\\" + "\nger role`;",
    ],
    ["an escaped JSON key", "src/x.json", '{ "\\u004danager": "ok" }'],
    ["an escaped JSON value", "src/x.json", '{ "label": "\\u004danager" }'],
    ["an identity escape", "src/components/X.tsx", 'const t = "Man\\ager role";'],
  ])("%s", (_, path, source) => {
    expect(hits(path, source)).toHaveLength(1);
  });

  it.each([
    [
      "identifiers",
      "src/x.ts",
      'let manager = roles.roles.manager; if (role === "manager") f(manager);',
    ],
    [
      "group names and error codes",
      "src/x.ts",
      'const g = ["edp-{datasetTag}-manager-{env}", "owner-holds-manager"];',
    ],
    [
      "a test title",
      "src/x.test.ts",
      "it(\"an owner's manager role can't be removed\", () => {});",
    ],
    [
      "the role-id key in role config",
      "src/data/datasets/role-descriptions.json",
      '{ "roles": { "manager": { "label": "Maintainer" } } }',
    ],
    ["the stored value, backticked, said to be stored", "docs/x.md", "Stored as `manager`."],
    [
      "stored positions in code",
      "src/data/x.ts",
      [
        'type R = "tester" | "manager";',
        'if (role === "manager") f({ role: "manager" });',
        'switch (r) { case "manager": break; }',
        'roles["manager"]; xs.includes("manager"); m.inherits = "manager";',
        'const ROLES = ["tester", "developer", "manager"] as const;',
      ].join("\n"),
    ],
    [
      "the EIR line manager",
      "src/data/eir/config.ts",
      'const t = ["Listed manager", "Manager\'s ID"];',
    ],
    ["the avoided terms", "GLOSSARY.md", "_Avoid_: Manager, admin, data manager, prod maintainer"],
  ])("lets %s through", (_, path, source) => {
    expect(hits(path, source)).toEqual([]);
  });
});

describe("nothing users or readers see calls the dataset role Manager", { timeout: 30_000 }, () => {
  const files = [
    ...walk("src"),
    ...walk("scripts"),
    ...walk("docs"),
    ...walk("resources"),
    "GLOSSARY.md",
    "README.md",
    "AGENTS.md",
  ].filter((path) => existsSync(join(ROOT, path)));

  it("scans the app, its tests and fixtures, legacy and EIR code, scripts, docs, DDL and glossary", () => {
    for (const path of [
      "src/data/datasets/role-descriptions.json",
      "src/components/DatasetAccess/TeamOverview.tsx",
      "src/components/DatasetAccess/TeamOverview.test.tsx",
      "src/data/__tests__/dataset-fixture.ts",
      "src/legacy/appData.js",
      "src/data/eir/config.ts",
      "resources/store-teams.sql",
      "docs/adr/0005-domain-access-model.md",
    ]) {
      expect(files).toContain(path);
    }
  });

  it("finds no Manager outside the stored identifiers and the listed occurrences", () => {
    expect(
      files.flatMap((path) => {
        const source = read(path);
        return scanSource(path, source);
      }),
    ).toEqual([]);
  });
});
