// @vitest-environment node
/**
 * The deploy contract: the app is built on the deployer's machine and shipped
 * prebuilt, so the Databricks App compute never runs `npm install` and never
 * fetches from the FedRAMP npm proxy.
 *
 * Databricks Apps install and build a Node app when its source root has a
 * `package.json`. The app source is `databricks-app/`, which has none; its
 * command only starts the prebuilt server. `scripts/deploy.sh` is the
 * build-and-ship step of `scripts/deploy-turnkey.sh` (src/deploy/__tests__):
 * it builds with the bundle's resolved `data_backend`, stages the build into
 * `databricks-app/`, then runs `bundle deploy` and `bundle run`.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const APP_DIR = "databricks-app";

interface AppConfig {
  command: string[];
  env: { name: string; value?: string }[];
}
interface Bundle {
  variables: Record<string, { default?: string; description?: string }>;
  sync?: { include?: string[] };
  resources: { apps: { edp_vending_machine: { source_code_path: string; config: AppConfig } } };
}
const bundle = () => load(readFileSync(join(ROOT, "databricks.yml"), "utf8")) as Bundle;
/** Every app env name the bundle can render: app-wide, plus each target's additions. */
const renderedEnvNames = () => {
  const raw = load(readFileSync(join(ROOT, "databricks.yml"), "utf8")) as Bundle & {
    targets: Record<string, { resources?: { apps?: Record<string, { config?: AppConfig }> } }>;
  };
  const perTarget = Object.values(raw.targets).flatMap(
    (target) => target.resources?.apps?.["edp_vending_machine"]?.config?.env ?? [],
  );
  return [...raw.resources.apps.edp_vending_machine.config.env, ...perTarget].map((e) => e.name);
};
const app = () => bundle().resources.apps.edp_vending_machine;
const appYaml = () => load(readFileSync(join(ROOT, APP_DIR, "app.yaml"), "utf8")) as AppConfig;

describe("the deployed unit (databricks-app/)", () => {
  it("is the app's source, and has nothing that makes the platform install or build", () => {
    expect(app().source_code_path).toBe(`./${APP_DIR}`);
    // package.json triggers `npm install` + `npm run build`; requirements.txt
    // triggers `pip install`.
    expect(existsSync(join(ROOT, APP_DIR, "package.json"))).toBe(false);
    expect(existsSync(join(ROOT, APP_DIR, "requirements.txt"))).toBe(false);
  });

  it("starts the prebuilt server without npm, in the bundle and in app.yaml alike", () => {
    expect(app().config.command).toEqual(["node", "serve.mjs"]);
    expect(appYaml().command).toEqual(app().config.command);
    expect(app().config.command.join(" ")).not.toMatch(/npm|build/);
  });

  it("keeps app.yaml's SLA defaults in parity with the bundle variable defaults", () => {
    const env = new Map(appYaml().env.map((entry) => [entry.name, entry.value]));
    const variables = bundle().variables;
    expect(env.get("EDP_SLA_EDP_ROI_REVIEW_BUSINESS_DAYS")).toBe(
      variables["sla_edp_roi_review_business_days"]?.default,
    );
    expect(env.get("EDP_SLA_CCB_BUSINESS_DAYS")).toBe(variables["sla_ccb_business_days"]?.default);
    expect(env.get("EDP_SLA_EIR_VALIDATION_BUSINESS_DAYS")).toBe(
      variables["sla_eir_validation_business_days"]?.default,
    );
    expect(env.get("EDP_SLA_ACCESS_REQUEST_DECISION_BUSINESS_DAYS")).toBe(
      variables["sla_access_request_decision_business_days"]?.default,
    );
    expect(env.get("EDP_SLA_DUE_SOON_BUSINESS_DAYS")).toBe(
      variables["sla_due_soon_business_days"]?.default,
    );
    expect(env.get("EDP_SLA_HOLIDAYS")).toBe(variables["sla_holidays"]?.default);
    expect(env.get("EDP_EIR_VALIDITY_DAYS")).toBe(variables["eir_validity_days"]?.default);
    expect(env.get("EDP_ACCESS_REQUEST_SLA_PROVISIONAL")).toBe(
      variables["access_request_sla_provisional"]?.default,
    );
  });

  it("syncs the gitignored build output", () => {
    expect(bundle().sync?.include).toEqual(
      expect.arrayContaining([
        `${APP_DIR}/server/**`,
        `${APP_DIR}/public/**`,
        `${APP_DIR}/build-info.json`,
      ]),
    );
  });

  // #226: one group, the EDP admin group, holds every staff role in the MVP.
  it("renders EDP_ADMIN_GROUP_ID as the only staff group env, and keeps the per-role vars reserved", () => {
    const names = renderedEnvNames();
    expect(names).toContain("EDP_ADMIN_GROUP_ID");
    for (const env of [
      "EDP_SAFEGUARDS_VALIDATOR_GROUP_ID",
      "EDP_BUSINESS_OFFICE_GROUP_ID",
      "EDP_CCB_GROUP_ID",
    ]) {
      expect(names, env).not.toContain(env);
      expect(
        appYaml().env.map((e) => e.name),
        env,
      ).not.toContain(env);
    }
    for (const name of [
      "safeguards_validator_group_id",
      "business_office_group_id",
      "ccb_group_id",
    ]) {
      expect(bundle().variables[name]?.description, name).toMatch(/reserved for a later/i);
    }
  });

  it("passes the target's data_backend at runtime, so the launcher can check the build", () => {
    expect(app().config.env).toContainEqual({
      name: "VITE_DATA_BACKEND",
      value: "${var.data_backend}",
    });
  });
});

const PREVIEW_ARGS = ["-p", "ws", "-t", "preview", "--var", "app_name=edp-vm-x"];

interface DeployOptions {
  backend?: string;
  args?: string[];
  env?: Record<string, string>;
  npmExit?: number;
  bigFile?: boolean;
  unsafeRootFiles?: string[];
  /** What `node --version` reports; other node calls run the real node. */
  nodeVersion?: string;
  /** Make the checkout a git repo, committed, and optionally with an untracked file. */
  git?: "clean" | "dirty";
  /** What `bundle plan -o json` returns; no changes by default. */
  plan?: unknown;
  /** Run it as an operator would, without the marker scripts/deploy-turnkey.sh sets. */
  direct?: boolean;
}

/**
 * A copy of the deploy entry point with fake `databricks`, `npm` and `node` on
 * PATH. The fake `bundle validate` resolves the app name the way the bundle
 * does: the `app_name` var if passed, else the production default.
 */
function deployFixture(opts: DeployOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "edp-deploy-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(join(ROOT, "scripts/deploy.sh"), join(dir, "scripts/deploy.sh"));
  // The plan gate.
  cpSync(join(ROOT, "scripts/bundle-config.ts"), join(dir, "scripts/bundle-config.ts"));
  cpSync(join(ROOT, "src/deploy"), join(dir, "src/deploy"), { recursive: true });
  cpSync(join(ROOT, APP_DIR), join(dir, APP_DIR), { recursive: true });
  writeFileSync(
    join(dir, ".gitignore"),
    `.output\n${APP_DIR}/server\n${APP_DIR}/public\n${APP_DIR}/build-info.json\n`,
  );
  let sha = "";
  if (opts.git) {
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: dir,
        encoding: "utf8",
      }).stdout.trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    sha = git("rev-parse", "--short", "HEAD");
    if (opts.git === "dirty") writeFileSync(join(dir, "uncommitted.txt"), "");
  }
  // A stale artifact from an earlier deploy.
  mkdirSync(join(dir, APP_DIR, "server"), { recursive: true });
  writeFileSync(join(dir, APP_DIR, "server/stale.mjs"), "");
  for (const file of opts.unsafeRootFiles ?? []) {
    writeFileSync(join(dir, APP_DIR, file), "stale\n");
  }
  // Fakes and their call log live outside the checkout, so they can't dirty it.
  const tools = mkdtempSync(join(tmpdir(), "edp-deploy-tools-"));
  const bin = join(tools, "bin");
  mkdirSync(bin);
  const log = join(tools, "calls.log");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -e\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "databricks",
    `echo "databricks $*" >> "${log}"
if [ "$1 $2" = "bundle validate" ]; then
  # Resolve like the CLI: the last target flag wins (-e/--environment are
  # aliases), else DATABRICKS_BUNDLE_TARGET / DATABRICKS_BUNDLE_ENV, else dev.
  name=edp-vending-machine
  target="\${DATABRICKS_BUNDLE_TARGET:-\${DATABRICKS_BUNDLE_ENV:-dev}}"
  prev=""
  for arg in "$@"; do
    case "$prev" in -t|--target|-e|--environment) target=$arg ;; esac
    case "$arg" in
      app_name=*|--var=app_name=*) name="\${arg#*app_name=}" ;;
      -t=*|-e=*|--target=*|--environment=*) target="\${arg#*=}" ;;
      -t?*|-e?*) target="\${arg#-?}" ;;
    esac
    prev=$arg
  done
  name="\${FAKE_RESOLVED_APP_NAME:-$name}"
  target="\${FAKE_RESOLVED_TARGET:-$target}"
  mode=development
  [ "$target" != prod ] || mode=production
  mode="\${FAKE_RESOLVED_MODE:-$mode}"
  printf '{"bundle":{"target":"%s","mode":"%s"},"variables":{"data_backend":{"value":"%s"}},"resources":{"apps":{"edp_vending_machine":{"name":"%s"}}}}\\n' "$target" "$mode" "${opts.backend ?? "memory"}" "$name"
fi
if [ "$1 $2" = "bundle plan" ]; then
  echo '${JSON.stringify(opts.plan ?? { plan: {} })}'
fi`,
  );
  fake(
    "npm",
    `echo "npm $* VITE_DATA_BACKEND=$VITE_DATA_BACKEND" >> "${log}"
exit_code=${opts.npmExit ?? 0}
[ "$exit_code" = 0 ] || exit "$exit_code"
mkdir -p .output/server .output/public
echo 'export {}' > .output/server/index.mjs
echo ok > .output/public/robots.txt
${opts.bigFile ? "head -c 11000000 /dev/zero > .output/public/huge.bin" : ""}`,
  );
  fake(
    "node",
    `if [ "$1" = "--version" ]; then echo "${opts.nodeVersion ?? "v24.14.0"}"; exit 0; fi
exec "${process.execPath}" "$@"`,
  );
  const args = opts.args ?? PREVIEW_ARGS;
  const env: Record<string, string | undefined> = { ...process.env };
  // Only a test's own env may select a target or bundle.
  for (const name of Object.keys(env)) {
    if (/^(DATABRICKS_BUNDLE_|BUNDLE_VAR_|EDP_DEPLOY_)/.test(name)) delete env[name];
  }
  const run = spawnSync("bash", [join(dir, "scripts/deploy.sh"), ...args], {
    cwd: dir,
    // scripts/deploy-turnkey.sh exports this before it calls deploy.sh.
    env: {
      ...env,
      ...(opts.direct ? {} : { EDP_DEPLOY_VIA_TURNKEY: "1" }),
      ...opts.env,
      PATH: `${bin}:${process.env["PATH"]}`,
    },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { dir, run, calls, sha, args: args.join(" ") };
}

// Each deploy test runs bash, git and node processes; under a full parallel
// suite they can exceed vitest's default 5 s.
const SPAWNS = { timeout: 30_000 };

const deployed = (calls: string[]) => calls.filter((c) => c.startsWith("databricks bundle deploy"));

describe("scripts/deploy.sh — the deploy entry point", SPAWNS, () => {
  it("builds with the data_backend the bundle resolves for the target", () => {
    const { run, calls } = deployFixture({ backend: "delta" });
    expect(run.status, run.stderr).toBe(0);
    expect(calls).toContain("npm run build:databricks VITE_DATA_BACKEND=delta");
  });

  it("validates, builds, then deploys and runs with the same bundle arguments", () => {
    const { run, calls, args } = deployFixture();
    expect(run.status, run.stderr).toBe(0);
    expect(calls).toEqual([
      `databricks bundle validate ${args} -o json`,
      `databricks bundle plan ${args} -o json`,
      "npm run build:databricks VITE_DATA_BACKEND=memory",
      `databricks bundle deploy ${args} --auto-approve`,
      `databricks bundle run edp_vending_machine ${args}`,
    ]);
  });

  it("stages the build into the deployed unit and records how it was built", () => {
    const { dir, run } = deployFixture({ backend: "delta" });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, APP_DIR, "server/index.mjs"))).toBe(true);
    expect(existsSync(join(dir, APP_DIR, "public/robots.txt"))).toBe(true);
    expect(existsSync(join(dir, APP_DIR, "server/stale.mjs"))).toBe(false);
    const info = JSON.parse(readFileSync(join(dir, APP_DIR, "build-info.json"), "utf8"));
    expect(info.dataBackend).toBe("delta");
    expect(existsSync(join(dir, APP_DIR, "package.json"))).toBe(false);
  });

  it("deploys nothing when the build fails, and leaves no stale artifact", () => {
    const { dir, run, calls } = deployFixture({ backend: "memory", npmExit: 1 });
    expect(run.status).not.toBe(0);
    expect(calls.some((call) => call.startsWith("databricks bundle deploy"))).toBe(false);
    expect(existsSync(join(dir, APP_DIR, "server"))).toBe(false);
  });

  it("builds and deploys nothing when the plan would drop a schema or volume", () => {
    for (const action of ["delete", "recreate"]) {
      const { run, calls } = deployFixture({
        plan: { plan: { "resources.volumes.eir_volume": { action } } },
      });
      expect(run.status, action).not.toBe(0);
      expect(run.stderr).toMatch(/plan gate failed/);
      expect(calls.some((call) => call.startsWith("npm"))).toBe(false);
      expect(deployed(calls)).toEqual([]);
    }
  });

  it("refuses a file over the Databricks Apps 10 MB per-file limit", () => {
    const { run, calls } = deployFixture({ backend: "memory", bigFile: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/10 MB/);
    expect(calls.some((call) => call.startsWith("databricks bundle deploy"))).toBe(false);
  });

  it("refuses unexpected app source root files before bundle deploy", () => {
    const unsafeRootFiles = ["package.json", "requirements.txt", "notes.txt"];
    const { run, calls } = deployFixture({ unsafeRootFiles });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unexpected file\(s\) in databricks-app/);
    for (const file of unsafeRootFiles) {
      expect(run.stderr).toContain(`${APP_DIR}/${file}`);
    }
    expect(run.stderr).toMatch(/does not delete user files/);
    expect(deployed(calls)).toEqual([]);
  });

  it("labels server import failures separately from startup config validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "edp-serve-"));
    mkdirSync(join(dir, "server"));
    cpSync(join(ROOT, APP_DIR, "serve.mjs"), join(dir, "serve.mjs"));
    writeFileSync(
      join(dir, "build-info.json"),
      JSON.stringify({ dataBackend: "memory", commit: "abc123", builtAt: "2026-10-08T00:00:00Z" }),
    );
    writeFileSync(
      join(dir, "server/index.mjs"),
      'throw new Error("EDP_SLA_CCB_BUSINESS_DAYS must be between 1 and 60.");\n',
    );

    const run = spawnSync(process.execPath, [join(dir, "serve.mjs")], {
      cwd: dir,
      env: {
        ...process.env,
        VITE_DATA_BACKEND: "memory",
        EDP_SLA_CCB_BUSINESS_DAYS: "5",
      },
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/server import failed/i);
    expect(run.stderr).toContain("EDP_SLA_CCB_BUSINESS_DAYS must be between 1 and 60.");
  });

  it("exits clearly before import when runtime SLA env is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "edp-serve-"));
    mkdirSync(join(dir, "server"));
    cpSync(join(ROOT, APP_DIR, "serve.mjs"), join(dir, "serve.mjs"));
    writeFileSync(
      join(dir, "build-info.json"),
      JSON.stringify({ dataBackend: "memory", commit: "abc123", builtAt: "2026-10-08T00:00:00Z" }),
    );
    writeFileSync(join(dir, "server/index.mjs"), "console.log('server imported');\n");

    const run = spawnSync(process.execPath, [join(dir, "serve.mjs")], {
      cwd: dir,
      env: { ...process.env, VITE_DATA_BACKEND: "memory", EDP_SLA_CCB_BUSINESS_DAYS: "abc" },
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/startup validation failed/i);
    expect(run.stderr).toContain("EDP_SLA_CCB_BUSINESS_DAYS must be an integer between 1 and 60.");
    expect(run.stdout).not.toContain("server imported");
  });

  it("refuses to build on a Node older than package.json's engines (>=24)", () => {
    const { run, calls } = deployFixture({ nodeVersion: "v22.16.0" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/Node >=24.*v22\.16\.0/);
    expect(calls).toEqual([]);
  });

  it("records the commit it built, marked -dirty when the checkout has changes", () => {
    const info = (git: "clean" | "dirty") => {
      const { dir, run, sha } = deployFixture({ git });
      expect(run.status, run.stderr).toBe(0);
      const built = JSON.parse(readFileSync(join(dir, APP_DIR, "build-info.json"), "utf8"));
      return { commit: built.commit, sha };
    };
    const clean = info("clean");
    expect(clean.commit).toBe(clean.sha);
    const dirty = info("dirty");
    expect(dirty.commit).toBe(`${dirty.sha}-dirty`);
  });
});

describe("scripts/deploy.sh — internal to scripts/deploy-turnkey.sh", SPAWNS, () => {
  it("refuses to run when invoked directly, naming the wrapper, before calling anything", () => {
    for (const args of [PREVIEW_ARGS, ["-p", "ws", "-t", "prod", "--production"]]) {
      const { run, calls } = deployFixture({ args, direct: true });
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(run.stderr).toMatch(/scripts\/deploy-turnkey\.sh/);
      expect(calls).toEqual([]);
    }
  });

  it("doesn't accept a marker value other than 1", () => {
    const { run, calls } = deployFixture({
      direct: true,
      env: { EDP_DEPLOY_VIA_TURNKEY: "yes" },
    });
    expect(run.status).not.toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("scripts/deploy.sh — production safety", SPAWNS, () => {
  it("refuses to run without an explicit target, and prints usage", () => {
    const { run, calls } = deployFixture({ args: ["-p", "ws", "--var", "app_name=edp-vm-x"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/Usage: scripts\/deploy\.sh/);
    expect(run.stderr).toMatch(/target/);
    expect(calls).toEqual([]);
  });

  it("refuses a non-production target without an explicit app_name", () => {
    const { run, calls } = deployFixture({ args: ["-p", "ws", "-t", "preview"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/--var app_name=/);
    expect(calls).toEqual([]);
  });

  it("refuses the production app name on a non-production target, in either --var form", () => {
    for (const args of [
      ["-t", "preview", "--var", "app_name=edp-vending-machine"],
      ["--target=dev", "--var=app_name=edp-vending-machine"],
    ]) {
      const { run, calls } = deployFixture({ args });
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(run.stderr).toMatch(/edp-vending-machine/);
      expect(calls).toEqual([]);
    }
  });

  it("refuses a non-production target whose resolved app name is the production one", () => {
    // An app name the argument check can't see, e.g. BUNDLE_VAR_app_name or a
    // target default: bundle validate resolves it, and the script checks that.
    const { run, calls } = deployFixture({
      env: { FAKE_RESOLVED_APP_NAME: "edp-vending-machine" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/resolves app_name to edp-vending-machine/);
    expect(calls).toEqual([`databricks bundle validate ${PREVIEW_ARGS.join(" ")} -o json`]);
  });

  it("refuses the prod target without a deliberate acknowledgement", () => {
    const { run, calls } = deployFixture({ args: ["-p", "ws", "-t", "prod"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/--production/);
    expect(run.stderr).toMatch(/EDP_DEPLOY_PRODUCTION=yes/);
    expect(calls).toEqual([]);
  });

  it("does not treat a non-yes EDP_DEPLOY_PRODUCTION as an acknowledgement", () => {
    const { run, calls } = deployFixture({
      args: ["-t", "prod"],
      env: { EDP_DEPLOY_PRODUCTION: "true" },
    });
    expect(run.status).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it("deploys prod with --production, which it doesn't pass on to the CLI", () => {
    const { run, calls } = deployFixture({ args: ["-p", "ws", "-t", "prod", "--production"] });
    expect(run.status, run.stderr).toBe(0);
    expect(calls).toEqual([
      "databricks bundle validate -p ws -t prod -o json",
      "databricks bundle plan -p ws -t prod -o json",
      "npm run build:databricks VITE_DATA_BACKEND=memory",
      "databricks bundle deploy -p ws -t prod --auto-approve",
      "databricks bundle run edp_vending_machine -p ws -t prod",
    ]);
  });

  it("deploys prod with EDP_DEPLOY_PRODUCTION=yes", () => {
    const { run, calls } = deployFixture({
      args: ["--target=prod"],
      env: { EDP_DEPLOY_PRODUCTION: "yes" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(deployed(calls)).toEqual(["databricks bundle deploy --target=prod --auto-approve"]);
  });

  it("accepts --target=<t> and --var=app_name=<name> for a preview", () => {
    const { run, calls } = deployFixture({ args: ["--target=preview", "--var=app_name=edp-vm-x"] });
    expect(run.status, run.stderr).toBe(0);
    expect(deployed(calls)).toEqual([
      "databricks bundle deploy --target=preview --var=app_name=edp-vm-x --auto-approve",
    ]);
  });

  // Round 2 of the Codex review: the CLI accepts more target forms than the
  // guard parsed. `-t preview … -tprod` deployed prod with no acknowledgement.
  it("refuses -tprod after -t preview: the CLI would deploy prod", () => {
    const { run, calls } = deployFixture({
      args: ["-t", "preview", "--var", "app_name=edp-vm-x", "-tprod"],
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/one target/);
    expect(calls).toEqual([]);
  });

  it("refuses more than one target, in any form, even when they agree", () => {
    for (const args of [
      ["-t", "preview", "--target=preview", "--var", "app_name=edp-vm-x"],
      ["--target", "preview", "-t=preview", "--var", "app_name=edp-vm-x"],
      ["-tpreview", "-t", "preview", "--var", "app_name=edp-vm-x"],
    ]) {
      const { run, calls } = deployFixture({ args });
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(run.stderr).toMatch(/one target/);
      expect(calls).toEqual([]);
    }
  });

  it("treats -tprod and -t=prod as the prod target, needing the acknowledgement", () => {
    for (const target of ["-tprod", "-t=prod"]) {
      const refused = deployFixture({ args: ["-p", "ws", target] });
      expect(refused.run.status, target).not.toBe(0);
      expect(refused.run.stderr).toMatch(/--production/);
      expect(refused.calls).toEqual([]);
      const allowed = deployFixture({ args: ["-p", "ws", target, "--production"] });
      expect(allowed.run.status, allowed.run.stderr).toBe(0);
      expect(deployed(allowed.calls)).toEqual([
        `databricks bundle deploy -p ws ${target} --auto-approve`,
      ]);
    }
  });

  it("refuses the CLI's hidden target aliases -e and --environment", () => {
    for (const alias of [
      ["-e", "prod"],
      ["-eprod"],
      ["--environment", "prod"],
      ["--environment=prod"],
    ]) {
      const args = ["-t", "preview", "--var", "app_name=edp-vm-x", ...alias];
      const { run, calls } = deployFixture({ args });
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(calls).toEqual([]);
    }
  });

  it("refuses a caller-supplied --auto-approve", () => {
    for (const flag of ["--auto-approve", "--auto-approve=true"]) {
      const { run, calls } = deployFixture({ args: [...PREVIEW_ARGS, flag] });
      expect(run.status, flag).not.toBe(0);
      expect(run.stderr).toMatch(/--auto-approve/);
      expect(calls).toEqual([]);
    }
  });

  it("refuses any argument it doesn't explicitly support", () => {
    for (const extra of [
      ["--"],
      ["--", "-t", "prod"],
      ["-qtprod"],
      ["--force"],
      ["extra-positional"],
      ["--var", "-tprod"],
      ["-p", "-tprod"],
    ]) {
      const args = [...PREVIEW_ARGS, ...extra];
      const { run, calls } = deployFixture({ args });
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(calls, args.join(" ")).toEqual([]);
    }
  });

  it("refuses the env vars that select a target or another bundle", () => {
    for (const name of [
      "DATABRICKS_BUNDLE_TARGET",
      "DATABRICKS_BUNDLE_ENV",
      "DATABRICKS_BUNDLE_ROOT",
    ]) {
      const { run, calls } = deployFixture({ env: { [name]: "prod" } });
      expect(run.status, name).not.toBe(0);
      expect(run.stderr).toMatch(new RegExp(name));
      expect(calls).toEqual([]);
    }
  });

  it("doesn't count BUNDLE_VAR_app_name as an explicit app name", () => {
    const { run, calls } = deployFixture({
      args: ["-p", "ws", "-t", "preview"],
      env: { BUNDLE_VAR_app_name: "edp-vm-x" },
    });
    expect(run.status).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it("decides on the target bundle validate resolves, not on the arguments", () => {
    // The arguments say preview; the CLI resolves prod. Refuse before building.
    const { run, calls } = deployFixture({ env: { FAKE_RESOLVED_TARGET: "prod" } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/resolved target prod/);
    expect(calls).toEqual([`databricks bundle validate ${PREVIEW_ARGS.join(" ")} -o json`]);
  });

  it("treats a target in production mode as production, whatever its name", () => {
    const { run, calls } = deployFixture({ env: { FAKE_RESOLVED_MODE: "production" } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/production mode/);
    expect(calls).toEqual([`databricks bundle validate ${PREVIEW_ARGS.join(" ")} -o json`]);
  });

  it("passes validate, deploy and run the same arguments", () => {
    const args = [
      "--profile=ws",
      "-tpreview",
      "--var=app_name=edp-vm-x",
      "--var",
      "data_backend=delta",
      "--debug",
    ];
    const { run, calls } = deployFixture({ args });
    expect(run.status, run.stderr).toBe(0);
    const given = args.join(" ");
    expect(calls).toEqual([
      `databricks bundle validate ${given} -o json`,
      `databricks bundle plan ${given} -o json`,
      "npm run build:databricks VITE_DATA_BACKEND=memory",
      `databricks bundle deploy ${given} --auto-approve`,
      `databricks bundle run edp_vending_machine ${given}`,
    ]);
  });
});

/** A copy of the launcher next to a fake server that records its port. */
function serveFixture(opts: {
  built: string | null;
  runtime: string;
  info?: Record<string, unknown>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "edp-serve-"));
  cpSync(join(ROOT, APP_DIR, "serve.mjs"), join(dir, "serve.mjs"));
  if (opts.built !== null) {
    mkdirSync(join(dir, "server"));
    writeFileSync(
      join(dir, "server/index.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "port"))}, process.env.PORT);\n`,
    );
    const info = opts.info ?? {
      dataBackend: opts.built,
      commit: "abc1234",
      builtAt: "2026-10-08T00:00:00.000Z",
    };
    writeFileSync(join(dir, "build-info.json"), JSON.stringify(info));
  }
  const env = { ...process.env, DATABRICKS_APP_PORT: "8123", VITE_DATA_BACKEND: opts.runtime };
  const run = spawnSync(process.execPath, [join(dir, "serve.mjs")], { env, encoding: "utf8" });
  const port = existsSync(join(dir, "port")) ? readFileSync(join(dir, "port"), "utf8") : null;
  return { run, port };
}

describe("databricks-app/serve.mjs — the runtime command", () => {
  it("serves the prebuilt server on the platform port", () => {
    const { run, port } = serveFixture({ built: "delta", runtime: "delta" });
    expect(run.status, run.stderr).toBe(0);
    expect(port).toBe("8123");
  });

  it("logs the Node version it runs on, since the container's differs from engines", () => {
    // The app container runs Node v22.16.0; package.json engines asks for >=24.
    const { run } = serveFixture({ built: "memory", runtime: "memory" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`node ${process.version}`);
  });

  it("treats an unset backend as memory, as the data seam does", () => {
    const { run, port } = serveFixture({ built: "memory", runtime: "" });
    expect(run.status, run.stderr).toBe(0);
    expect(port).toBe("8123");
  });

  it("refuses a build baked for a different data backend than the target's", () => {
    const { run, port } = serveFixture({ built: "memory", runtime: "delta" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/built with VITE_DATA_BACKEND=memory.*target sets delta/);
    expect(port).toBeNull();
  });

  it("refuses a build-info.json that doesn't say how the server was built", () => {
    const complete = {
      dataBackend: "memory",
      commit: "abc1234",
      builtAt: "2026-10-08T00:00:00.000Z",
    };
    for (const info of [
      { commit: complete.commit, builtAt: complete.builtAt },
      { ...complete, dataBackend: "" },
      { ...complete, dataBackend: "lakebase" },
      { dataBackend: complete.dataBackend, builtAt: complete.builtAt },
      { dataBackend: complete.dataBackend, commit: complete.commit },
    ]) {
      const { run, port } = serveFixture({ built: "memory", runtime: "memory", info });
      expect(run.status, JSON.stringify(info)).not.toBe(0);
      expect(run.stderr).toMatch(/build-info\.json/);
      expect(port).toBeNull();
    }
  });

  it("explains how to deploy when the artifact has no prebuilt server", () => {
    const { run } = serveFixture({ built: null, runtime: "memory" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/scripts\/deploy-turnkey\.sh/);
  });
});
