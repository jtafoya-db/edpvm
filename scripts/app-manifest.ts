#!/usr/bin/env node
// Record the staged app source and verify a workspace copy against it, for
// scripts/deploy.sh (seam: src/deploy/appManifest.ts). Node strips the types.
//
//   node scripts/app-manifest.ts --write <staged dir> <manifest.json>
//   node scripts/app-manifest.ts --verify <manifest.json> <exported dir>   # exit 1 if missing/differs/extra
//   node scripts/app-manifest.ts --scope <app source path> <bundle files path>  # exit 1 unless deletable
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  buildManifest,
  compareManifest,
  formatManifestDiff,
  manifestDiffIsClean,
  notebookConvertiblePaths,
  ScopeError,
  scopedAppSourcePath,
  type ManifestEntry,
} from "../src/deploy/appManifest.ts";

const [mode, first, second] = process.argv.slice(2);

if (mode === "--write" && first && second) {
  const manifest = buildManifest(first);
  const notebooks = notebookConvertiblePaths(manifest);
  if (notebooks.length) {
    console.error(
      `[deploy] refusing to upload file(s) the workspace would convert to notebooks (.py .sql .scala .r .ipynb), which can't be verified byte-for-byte:\n${notebooks.map((path) => `  - ${first}/${path}`).join("\n")}`,
    );
    process.exit(1);
  }
  writeFileSync(second, JSON.stringify(manifest, null, 2) + "\n");
  const bytes = manifest.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`[deploy] manifest: ${manifest.length} files, ${bytes} bytes -> ${second}`);
  process.exit(0);
}

if (mode === "--verify" && first && second) {
  const expected = JSON.parse(readFileSync(first, "utf8")) as ManifestEntry[];
  const actual = existsSync(second) ? buildManifest(second) : [];
  const diff = compareManifest(expected, actual);
  if (!manifestDiffIsClean(diff)) {
    console.error(
      `[deploy] the workspace copy doesn't match the staged build (${diff.missing.length} missing, ${diff.changed.length} differ, ${diff.unexpected.length} extra):\n${formatManifestDiff(diff)}`,
    );
    process.exit(1);
  }
  console.log(
    `[deploy] workspace copy verified: all ${expected.length} staged files present and identical, no extra files.`,
  );
  process.exit(0);
}

if (mode === "--scope" && first !== undefined && second !== undefined) {
  try {
    scopedAppSourcePath(first, second);
  } catch (error) {
    console.error(`[deploy] ${error instanceof ScopeError ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

console.error(
  "usage: app-manifest.ts --scope <source> <files> | --write <dir> <manifest.json> | --verify <manifest.json> <dir>",
);
process.exit(2);
