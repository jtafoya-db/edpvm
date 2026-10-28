// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = process.env["DESTROY_PREVIEW_SCRIPT"] ?? join(ROOT, "scripts/destroy-preview.sh");
const DROP_ADMIN = "DROP SCHEMA `example_catalog`.`edp_vm_pr29_admin` CASCADE";
interface LocalOptions {
  prBranch: string;
  currentBranch?: string;
  defaultBranch?: string;
  worktree?: string;
  currentWorktree?: string;
  dirty?: boolean;
  merged?: boolean;
}
interface RunOptions {
  args?: string[];
  schemas?: string[];
  volumes?: string[];
  app?: "present" | "absent" | "error";
  bundleExists?: boolean;
  failDrop?: string;
  stickyDrop?: string;
  volumeSchemaMissing?: boolean;
  bundleDestroyNoop?: boolean;
  local?: LocalOptions;
}

function fake(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env python3\n${body}\n`);
  chmodSync(path, 0o755);
}

function runDestroy(options: RunOptions = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "edp-destroy-preview-"));
  const bin = join(fixture, "bin");
  mkdirSync(bin);
  const calls = join(fixture, "calls.jsonl");
  const state = join(fixture, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      schemas: options.schemas ?? ["edp_vm_pr29_admin", "edp_vm_pr29_eir"],
      volumes: options.volumes ?? ["eir_pr29"],
      app: options.app ?? "present",
      jobs: options.bundleExists === false ? [] : ["edp-vm-pr29-provision-store"],
      folder: options.bundleExists ?? true,
    }),
  );
  fake(
    join(bin, "databricks"),
    `import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as log: log.write(json.dumps(["databricks", *args]) + "\\n")
with open(os.environ["FAKE_STATE"]) as source: state = json.load(source)
def save():
    with open(os.environ["FAKE_STATE"], "w") as target: json.dump(state, target)
def ok(rows=[], columns=["databaseName"]):
    print(json.dumps({"statement_id":"s1","status":{"state":"SUCCEEDED"},"manifest":{"schema":{"columns":[{"name":n} for n in columns]}},"result":{"data_array":rows}}))
if args[:2] == ["bundle", "validate"]:
    print(json.dumps({"workspace":{"root_path":"/Workspace/Users/me/.bundle/edp-vending-machine/edp-vm-pr29"},"resources":{"jobs":{"provision_store":{"name":"edp-vm-pr29-provision-store"}}}})); sys.exit(0)
if args[:2] == ["apps", "get"]:
    if state["app"] == "present": print('{"name":"edp-vm-pr29"}'); sys.exit(0)
    if state["app"] == "absent": print("Error: App with name edp-vm-pr29 does not exist or is deleted.", file=sys.stderr); sys.exit(1)
    print("Error: authentication expired", file=sys.stderr); sys.exit(1)
if args[:2] == ["apps", "stop"]: sys.exit(0)
if args[:2] == ["bundle", "destroy"]:
    if os.environ.get("FAKE_BUNDLE_DESTROY_NOOP") != "1": state.update(app="absent", jobs=[], folder=False); save()
    sys.exit(0)
if args[:2] == ["jobs", "list"]:
    print(json.dumps([{"settings":{"name":n}} for n in state["jobs"]])); sys.exit(0)
if args[:2] == ["workspace", "get-status"]:
    if state["folder"]: print('{"object_type":"DIRECTORY"}'); sys.exit(0)
    print("Error: Path doesn't exist", file=sys.stderr); sys.exit(1)
if args[:2] == ["api", "post"]:
    payload=json.loads(args[args.index("--json")+1]); sql=payload["statement"]
    if os.environ.get("FAKE_FAIL_DROP") == sql:
        print(json.dumps({"statement_id":"s1","status":{"state":"FAILED","error":{"message":"forced partial failure"}}})); sys.exit(0)
    if sql.startswith("SHOW SCHEMAS"): ok([[n] for n in state["schemas"]]); sys.exit(0)
    if sql.startswith("SHOW VOLUMES"):
        if os.environ.get("FAKE_VOLUME_SCHEMA_MISSING") == "1":
            print(json.dumps({"statement_id":"s1","status":{"state":"FAILED","error":{"message":"[SCHEMA_NOT_FOUND] edp_vm_preview does not exist"}}})); sys.exit(0)
        ok([["edp_vm_preview", n] for n in state["volumes"]], ["database", "volume_name"]); sys.exit(0)
    if sql.startswith("DROP SCHEMA "):
        name=sql.split(".",1)[1].rsplit(" CASCADE",1)[0].replace(chr(96),"")
        if os.environ.get("FAKE_STICKY_DROP") != sql: state["schemas"]=[n for n in state["schemas"] if n != name]
        save(); ok(); sys.exit(0)
    if sql.startswith("DROP VOLUME "):
        name=sql.rsplit(".",1)[1].replace(chr(96),"")
        if os.environ.get("FAKE_STICKY_DROP") != sql: state["volumes"]=[n for n in state["volumes"] if n != name]
        save(); ok(); sys.exit(0)
print("unexpected command: " + " ".join(args), file=sys.stderr); sys.exit(9)`,
  );
  const local = options.local;
  if (local) {
    fake(
      join(bin, "gh"),
      `import json, os, sys
with open(os.environ["FAKE_CALLS"],"a") as log: log.write(json.dumps(["gh",*sys.argv[1:]])+"\\n")
print(os.environ["FAKE_PR_BRANCH"])`,
    );
    fake(
      join(bin, "git"),
      `import json, os, sys
args=sys.argv[1:]
with open(os.environ["FAKE_CALLS"],"a") as log: log.write(json.dumps(["git",*args])+"\\n")
if args == ["symbolic-ref","--quiet","--short","HEAD"]: print(os.environ["FAKE_CURRENT_BRANCH"]); sys.exit(0)
if args == ["symbolic-ref","--quiet","--short","refs/remotes/origin/HEAD"]: print("origin/"+os.environ["FAKE_DEFAULT_BRANCH"]); sys.exit(0)
if args == ["rev-parse","--show-toplevel"]: print(os.environ["FAKE_CURRENT_WORKTREE"]); sys.exit(0)
if args == ["worktree","list","--porcelain"]:
 print("worktree "+os.environ["FAKE_WORKTREE"]+"\\nHEAD abc\\nbranch refs/heads/"+os.environ["FAKE_PR_BRANCH"]+"\\n"); sys.exit(0)
if len(args)>=4 and args[0]=="-C" and args[2:]==["status","--porcelain"]:
    if os.environ.get("FAKE_DIRTY")=="1": print(" M dirty")
    sys.exit(0)
if args[:2] == ["show-ref","--verify"]: sys.exit(0)
if args[:3] == ["branch","--merged","HEAD"]:
    if os.environ.get("FAKE_MERGED") == "1": print(os.environ["FAKE_PR_BRANCH"])
    sys.exit(0)
sys.exit(0)`,
    );
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"]}`,
    FAKE_CALLS: calls,
    FAKE_STATE: state,
    FAKE_FAIL_DROP: options.failDrop ?? "",
    FAKE_STICKY_DROP: options.stickyDrop ?? "",
    FAKE_VOLUME_SCHEMA_MISSING: options.volumeSchemaMissing ? "1" : "0",
    FAKE_BUNDLE_DESTROY_NOOP: options.bundleDestroyNoop ? "1" : "0",
    FAKE_PR_BRANCH: local?.prBranch ?? "",
    FAKE_CURRENT_BRANCH: local?.currentBranch ?? "main",
    FAKE_DEFAULT_BRANCH: local?.defaultBranch ?? "main",
    FAKE_WORKTREE: local?.worktree ?? "",
    FAKE_CURRENT_WORKTREE: local?.currentWorktree ?? ROOT,
    FAKE_DIRTY: local?.dirty ? "1" : "0",
    FAKE_MERGED: local?.merged === false ? "0" : "1",
  };
  const run = spawnSync("bash", [SCRIPT, ...(options.args ?? ["29"])], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  const logged: string[][] = (existsSync(calls) ? readFileSync(calls, "utf8") : "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const statements = logged
    .filter((a) => a[0] === "databricks" && a[1] === "api" && a[2] === "post")
    .map((a) => JSON.parse(a[a.indexOf("--json") + 1]!).statement as string);
  return { run, calls: logged, statements, state: JSON.parse(readFileSync(state, "utf8")) };
}
const called = (calls: string[][], ...prefix: string[]) =>
  calls.some((args) => prefix.every((v, i) => args[i] === v));

describe("scripts/destroy-preview.sh", { timeout: 30_000 }, () => {
  it.each(["", "0", "-1", "1.5", "abc", "edp-vending-machine", "edp-vm-preview-unset"])(
    "refuses unsafe PR input %j",
    (value) => {
      const { run, calls } = runDestroy({ args: value ? [value] : [] });
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/positive-integer|refus/i);
      expect(calls).toEqual([]);
    },
  );
  it("uses volume_name from the manifest", () => {
    const { run, statements, state } = runDestroy({
      schemas: ["edp_vm_pr29_admin", "edp_vm_pr290_admin"],
      volumes: ["eir_pr29", "eir_pr290"],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(statements).toContain(
      "DROP VOLUME `example_catalog`.`edp_vm_preview`.`eir_pr29`",
    );
    expect(statements).not.toContain(
      "DROP VOLUME `example_catalog`.`edp_vm_preview`.`eir_pr290`",
    );
    expect(state.volumes).toEqual(["eir_pr290"]);
    expect(statements).not.toContain(
      "DROP SCHEMA `example_catalog`.`edp_vm_pr290_admin` CASCADE",
    );
    expect(state.schemas).toEqual(["edp_vm_pr290_admin"]);
  });
  it("always destroys and re-checks jobs and bundle folder", () => {
    const { run, calls } = runDestroy({
      app: "absent",
      bundleExists: true,
      schemas: [],
      volumes: [],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(called(calls, "databricks", "bundle", "destroy")).toBe(true);
    expect(called(calls, "databricks", "jobs", "list")).toBe(true);
    expect(called(calls, "databricks", "workspace", "get-status")).toBe(true);
    expect(run.stdout).not.toContain("nothing to do");
  });
  it("fails when bundle destroy leaves a rendered job and root folder", () => {
    const { run } = runDestroy({
      app: "absent",
      bundleDestroyNoop: true,
      schemas: [],
      volumes: [],
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("remaining job: edp-vm-pr29-provision-store");
    expect(run.stderr).toContain("remaining bundle folder:");
  });
  it.each(["edp_vm_preview", "membership", "demo"])(
    "explicitly refuses shared schema %s",
    (name) => {
      const { run, statements } = runDestroy({ schemas: [name], volumes: [] });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(`refusing shared schema '${name}'`);
      expect(statements.some((s) => s.startsWith("DROP") && s.includes(name))).toBe(false);
    },
  );
  it("drops PR-prefixed demo schema", () => {
    const name = "edp_vm_pr29_demo";
    const { run, statements } = runDestroy({ schemas: [name], volumes: [] });
    expect(run.status, run.stderr).toBe(0);
    expect(statements).toContain(`DROP SCHEMA \`example_catalog\`.\`${name}\` CASCADE`);
  });
  it.each(["EDP_VM_PR29_ADMIN", "edp_vm_pr29_odd-name"])(
    "fails when unsafe listed PR schema remains: %s",
    (name) => {
      const { run } = runDestroy({ schemas: [name], volumes: [] });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`remaining schema: example_catalog.${name}`);
    },
  );
  it("fails when successful DROP leaves resource", () => {
    const { run, state } = runDestroy({ stickyDrop: DROP_ADMIN, schemas: ["edp_vm_pr29_admin"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("teardown incomplete");
    expect(state.schemas).toContain("edp_vm_pr29_admin");
  });
  it("preserves drop_failed", () => {
    const { run } = runDestroy({ failDrop: DROP_ADMIN, schemas: ["edp_vm_pr29_admin"] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("forced partial failure");
    expect(run.stderr).toContain("teardown incomplete");
  });
  it("rejects non-not-found apps error", () => {
    const { run } = runDestroy({ app: "error", schemas: [], volumes: [] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("authentication expired");
  });
  it("allows missing shared volume schema", () => {
    const { run } = runDestroy({ schemas: [], volumes: [], volumeSchemaMissing: true });
    expect(run.status, run.stderr).toBe(0);
  });
  it("dry-run changes nothing", () => {
    const { run, calls, statements, state } = runDestroy({ args: ["29", "--dry-run"] });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("DRY RUN");
    expect(called(calls, "databricks", "bundle", "destroy")).toBe(false);
    expect(statements.every((s) => !s.startsWith("DROP"))).toBe(true);
    expect(state.schemas).toContain("edp_vm_pr29_admin");
  });
  it("is idempotent but still runs bundle destroy", () => {
    const { run, calls } = runDestroy({
      app: "absent",
      bundleExists: false,
      schemas: [],
      volumes: [],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("nothing to do");
    expect(called(calls, "databricks", "bundle", "destroy")).toBe(true);
  });
  it.each([
    ["main", "feature", "/tmp/other"],
    ["trunk", "feature", "/tmp/other"],
    ["feature", "feature", "/tmp/other"],
    ["feature", "current", "/tmp/current worktree"],
  ])("--local refuses protected target %#", (prBranch, currentBranch, worktree) => {
    const { run, calls } = runDestroy({
      args: ["29", "--local"],
      app: "absent",
      bundleExists: false,
      schemas: [],
      volumes: [],
      local: {
        prBranch,
        currentBranch,
        defaultBranch: "trunk",
        worktree,
        currentWorktree: "/tmp/current worktree",
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/refusing/i);
    expect(called(calls, "git", "worktree", "remove")).toBe(false);
  });
  it("--local refuses dirty path with spaces", () => {
    const worktree = "/tmp/PR 29 worktree";
    const { run, calls } = runDestroy({
      args: ["29", "--local"],
      app: "absent",
      bundleExists: false,
      schemas: [],
      volumes: [],
      local: {
        prBranch: "feature",
        currentBranch: "main",
        worktree,
        currentWorktree: "/tmp/main",
        dirty: true,
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`dirty worktree ${worktree}`);
    expect(called(calls, "git", "worktree", "remove")).toBe(false);
  });
  it("--local removes clean path with spaces", () => {
    const worktree = "/tmp/PR 29 worktree";
    const { run, calls } = runDestroy({
      args: ["29", "--local"],
      app: "absent",
      bundleExists: false,
      schemas: [],
      volumes: [],
      local: { prBranch: "feature", currentBranch: "main", worktree, currentWorktree: "/tmp/main" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(calls).toContainEqual(["git", "worktree", "remove", worktree]);
    expect(calls).toContainEqual(["git", "branch", "-d", "feature"]);
  });
  it("--local refuses an unmerged PR branch", () => {
    const { run, calls } = runDestroy({
      args: ["29", "--local"],
      app: "absent",
      bundleExists: false,
      schemas: [],
      volumes: [],
      local: {
        prBranch: "feature",
        currentBranch: "main",
        worktree: "/tmp/feature",
        currentWorktree: "/tmp/main",
        merged: false,
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unmerged branch");
    expect(called(calls, "git", "worktree", "remove")).toBe(false);
  });
});
