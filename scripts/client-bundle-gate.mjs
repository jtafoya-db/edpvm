import { readFileSync, readdirSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

// CSIRC did not disclose a line-length rule. This local ceiling is deliberately
// well below the 10,012- and 13,598-character YAML literals that triggered #299.
export const MAX_CLIENT_LINE_LENGTH = 2_000;
export const CLIENT_BUNDLE_ALLOWLIST = Object.freeze([
  {
    file: /^assets\/index-[\w-]+\.js$/,
    reason: "React's generated class-component update expression is one 2,042-character line.",
    line: /^\s*contextType !== getDerivedStateFromProps .*workInProgress\.flags \|= 1024\), nextProps = !1\);$/,
  },
  {
    file: /^assets\/[\w-]+\.js$/,
    reason: "Rolldown emits the live binding export list on one generated line.",
    line: /^export \{(?: [\w$]+(?: as [\w$]+)?,)* [\w$]+(?: as [\w$]+)? \};$/,
  },
]);

const BANNED_PATTERNS = [
  { label: "eval(", pattern: /\beval\s*\(/ },
  { label: "new Function(", pattern: /\bnew\s+Function\s*\(/ },
  { label: "Function(", pattern: /^(?!.*\bnew\s+Function\s*\().*\bFunction\s*\(/ },
  { label: "= Function", pattern: /=\s*Function\b/ },
  { label: "(0, eval)", pattern: /\(\s*0\s*,\s*eval\s*\)/ },
  { label: '["eval"]', pattern: /\[\s*["'`]eval["'`]\s*\]/ },
  { label: "string setTimeout", pattern: /\bsetTimeout\s*\(\s*["'`]/ },
  { label: "string setInterval", pattern: /\bsetInterval\s*\(\s*["'`]/ },
];

export function scanClientBundle(clientRoot, { enforceLineLength = true, path = nodePath } = {}) {
  const violations = [];
  const files = javascriptFiles(clientRoot);
  let longestLine = { file: "", line: 0, length: 0 };
  const allowlistUses = [];

  for (const file of files) {
    const relativeFile = path.relative(clientRoot, file).split(path.sep).join("/");
    for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      const allowed = CLIENT_BUNDLE_ALLOWLIST.find(
        (entry) => entry.file.test(relativeFile) && (!entry.line || entry.line.test(line)),
      );
      if (line.length > longestLine.length) {
        longestLine = { file: relativeFile, line: index + 1, length: line.length };
      }
      if (enforceLineLength && !allowed && line.length > MAX_CLIENT_LINE_LENGTH) {
        violations.push(
          `${relativeFile}:${index + 1}: line length ${line.length} exceeds ${MAX_CLIENT_LINE_LENGTH}`,
        );
      }
      if (enforceLineLength && allowed && line.length > MAX_CLIENT_LINE_LENGTH) {
        allowlistUses.push({
          file: relativeFile,
          line: index + 1,
          length: line.length,
          reason: allowed.reason,
        });
      }
      for (const banned of BANNED_PATTERNS) {
        if (banned.pattern.test(line)) {
          violations.push(`${relativeFile}:${index + 1}: contains banned ${banned.label}`);
        }
      }
    }
  }

  return { files, longestLine, violations, allowlistUses };
}

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = nodePath.resolve(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(path) : /\.m?js$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = nodePath.resolve(process.argv[2] ?? ".output/public");
  const unminified = /^(1|true|yes|on)$/i.test(process.env.EDP_UNMINIFIED_BUILD ?? "");
  const result = scanClientBundle(root, { enforceLineLength: unminified });
  if (result.violations.length) {
    console.error(`Client bundle gate failed:\n${result.violations.join("\n")}`);
    process.exitCode = 1;
  } else {
    const allowed = result.allowlistUses.length
      ? ` Allowlist used: ${result.allowlistUses.map((use) => `${use.file}:${use.line} (${use.length} characters): ${use.reason}`).join("; ")}`
      : " Allowlist used: none.";
    console.log(
      `Client bundle gate passed: ${result.files.length} JS files; longest line ${result.longestLine.file}:${result.longestLine.line} (${result.longestLine.length} characters); line-length policy ${unminified ? "enforced" : "not applicable to this local minified build"}.${allowed}`,
    );
  }
}
