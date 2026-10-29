#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { AccessMatrixError, digestAccessMatrixOverride } from "../src/server/access-matrix.ts";

async function input(): Promise<string> {
  const path = process.argv[2];
  return path ? await readFile(path, "utf8") : await new Response(process.stdin).text();
}

try {
  process.stdout.write(`${digestAccessMatrixOverride(await input())}\n`);
} catch (error) {
  if (error instanceof AccessMatrixError) {
    process.stderr.write(`${error.code}: ${error.issues.join("; ")}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
