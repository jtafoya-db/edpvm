// @vitest-environment node
/**
 * #204 at the deploy-configuration seam: the approval mode and the results
 * that qualify for automatic validity are read on the server, from env, and
 * nothing but the allowed values starts the app (#148, 2026-10-24). One
 * table of cases (`eir-approval-config-cases.ts`) runs through both parsers:
 * the server's, and `databricks-app/serve.mjs`'s startup check, so they
 * can't drift apart.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEirApprovalConfig } from "../eir-approval-mode.ts";
import {
  ACCEPTED_MODES,
  ACCEPTED_OUTCOMES,
  MODE_ENV,
  MODE_REFUSAL,
  OUTCOMES_ENV,
  REFUSED_MODES,
  REFUSED_OUTCOMES,
} from "./eir-approval-config-cases.ts";

/** Start the real launcher, next to a fake prebuilt server, with `env`. */
function startServe(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "edp-serve-approval-"));
  cpSync(join(process.cwd(), "databricks-app/serve.mjs"), join(dir, "serve.mjs"));
  mkdirSync(join(dir, "server"));
  writeFileSync(
    join(dir, "server/index.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "started"))}, "yes");\n`,
  );
  writeFileSync(
    join(dir, "build-info.json"),
    JSON.stringify({
      dataBackend: "memory",
      minified: true,
      commit: "abc1234",
      builtAt: "2026-10-28T00:00:00.000Z",
    }),
  );
  const { [MODE_ENV]: _mode, [OUTCOMES_ENV]: _outcomes, ...inherited } = process.env;
  const run = spawnSync(process.execPath, [join(dir, "serve.mjs")], {
    env: {
      ...inherited,
      VITE_DATA_BACKEND: "memory",
      EDP_CLIENT_MINIFIED: "true",
      DATABRICKS_APP_PORT: "8123",
      ...env,
    },
    encoding: "utf8",
  });
  return { run, started: existsSync(join(dir, "started")) };
}

describe("readEirApprovalConfig (#204)", () => {
  it("defaults to manual-validator, with only pass qualifying", () => {
    expect(readEirApprovalConfig({})).toEqual({
      mode: "manual-validator",
      automaticValidityOutcomes: ["pass"],
    });
  });

  it.each(ACCEPTED_MODES)("accepts %s", (mode) => {
    expect(readEirApprovalConfig({ [MODE_ENV]: mode }).mode).toBe(mode);
  });

  it.each(REFUSED_MODES)("refuses the mode %j", (raw) => {
    expect(() => readEirApprovalConfig({ [MODE_ENV]: raw })).toThrow(MODE_REFUSAL);
  });

  it.each(ACCEPTED_OUTCOMES)("accepts the qualifying results %j", (raw, outcomes) => {
    expect(readEirApprovalConfig({ [OUTCOMES_ENV]: raw }).automaticValidityOutcomes).toEqual(
      outcomes,
    );
  });

  it.each(REFUSED_OUTCOMES)("refuses the qualifying results %j", (raw, message) => {
    expect(() => readEirApprovalConfig({ [OUTCOMES_ENV]: raw })).toThrow(
      `${OUTCOMES_ENV} ${message}`,
    );
  });
});

describe("databricks-app/serve.mjs refuses to start on the same settings (#204)", () => {
  it("starts with the settings unset, and with each accepted value", () => {
    expect(startServe({}).started).toBe(true);
    for (const mode of ACCEPTED_MODES) {
      const { run, started } = startServe({ [MODE_ENV]: mode });
      expect(started, run.stderr).toBe(true);
    }
    for (const [raw] of ACCEPTED_OUTCOMES) {
      const { run, started } = startServe({ [OUTCOMES_ENV]: raw });
      expect(started, `${raw}: ${run.stderr}`).toBe(true);
    }
  });

  it.each(REFUSED_MODES)("refuses the mode %j", (raw) => {
    const { run, started } = startServe({ [MODE_ENV]: raw });
    expect(run.status).not.toBe(0);
    expect(started).toBe(false);
    expect(run.stderr).toContain(MODE_REFUSAL);
  });

  it.each(REFUSED_OUTCOMES)("refuses the qualifying results %j", (raw, message) => {
    const { run, started } = startServe({ [OUTCOMES_ENV]: raw });
    expect(run.status).not.toBe(0);
    expect(started).toBe(false);
    expect(run.stderr).toContain(`${OUTCOMES_ENV} ${message}`);
  });
});
