#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const repo = resolve(process.argv[3] ?? ".");
const apply = process.argv[2] === "--apply";
if (!apply && process.argv[2] !== "--check") {
  console.error("usage: node scripts/public-sanitize.mjs --apply|--check [repo]");
  process.exit(2);
}

// Publication policy: these private documents and agent-control files do not
// ship. Keep this exact list in step with PUBLICATION-MANIFEST.md.
export const EXCLUDED_PATHS = [
  ".agents",
  ".claude",
  ".github/pull_request_template.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/agentic-workflow.md",
  "docs/agents/domain.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
  "docs/compute-policy-defaults.md",
  "docs/eir-volume.md",
  "docs/evidence/113-shared-accessibility.md",
  "docs/governance-research.md",
  "docs/implementation-plan.md",
  "docs/onepager-copy.md",
  "docs/production-checklist.md",
  "docs/research/govcloud-identity-proof-2026-10-08.md",
  "docs/research/snappy-on-slow-backend.md",
  "docs/slide-distilled.md",
  "docs/superpowers/specs/2026-10-21-release-readiness-fix-design.md",
];

const excludedFiles = new Set(EXCLUDED_PATHS.filter((path) => !path.startsWith(".")));
const substitutions = [
  [/npm-proxy\.cloud\.databricks\.com/g, "registry.npmjs.org"],
  [/fevm-services-bureau\.cloud\.databricks\.com/g, "example-workspace.cloud.databricks.com"],
  [/services_bureau_catalog/g, "example_catalog"],
  [/services-bureau/g, "example-workspace"],
  [/852e667acfb9b179/g, "1111111111111111"],
  [/80729668828425/g, "11111111111111"],
  [/2f225c0740dcd22b/g, "2222222222222222"],
  [/@irs\.gov/gi, "@example.gov"],
  [/\birs-gov\b/g, "example-gov-workspace"],
  [/\birs-demo\b/g, "example-gov-demo"],
  [/github\.com\/jtafoya-db\/edp-vending-machine/g, "github.com/jtafoya-db/edpvm"],
  [/Rob King/g, "executive sponsor"],
  [/Private — internal/g, "Public snapshot"],
];

const tracked = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

if (apply) {
  for (const path of EXCLUDED_PATHS) rmSync(join(repo, path), { recursive: true, force: true });

  for (const path of tracked) {
    const absolute = join(repo, path);
    if (
      !existsSync(absolute) ||
      !statSync(absolute).isFile() ||
      path === "README.original.md" ||
      path === "scripts/public-sanitize.mjs" ||
      path === "scripts/public-audit.sh" ||
      path === "PUBLICATION-MANIFEST.md"
    )
      continue;
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) continue;
    let text = buffer.toString("utf8");
    for (const [pattern, replacement] of substitutions) text = text.replace(pattern, replacement);
    if (path.endsWith(".md")) {
      text = text.replace(/\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, label, target) => {
        if (/^(?:https?:|mailto:|#|data:)/.test(target)) return whole;
        const clean = decodeURIComponent(target.replace(/^<|>$/g, "").split("#")[0]);
        const resolved = normalize(join(dirname(path), clean));
        return excludedFiles.has(resolved) ? `${label} (private source document; not published)` : whole;
      });
    }
    writeFileSync(absolute, text);
  }
}

const problems = [];
for (const path of EXCLUDED_PATHS) {
  if (existsSync(join(repo, path))) problems.push(`excluded path is present: ${path}`);
}

const markdown = execFileSync("git", ["-C", repo, "ls-files", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((path) => path && path !== "README.original.md");
for (const path of markdown) {
  const absolute = join(repo, path);
  if (!existsSync(absolute)) continue;
  const text = readFileSync(absolute, "utf8");
  const links = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(links)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#|data:)/.test(target)) continue;
    const clean = decodeURIComponent(target.split("#")[0]);
    if (!clean) continue;
    const resolved = resolve(dirname(absolute), clean);
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${path}:${line}: missing relative link target ${target}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`PASS: public exclusions and ${markdown.length} Markdown files`);
