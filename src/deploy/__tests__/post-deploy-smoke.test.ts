// @vitest-environment node
/**
 * scripts/post-deploy-smoke.sh against fake `databricks` and a real local HTTP
 * server. The Bearer token must reach the app only through stdin to the HTTP
 * client: never on any process's command line or in its environment.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TOKEN = "test-only-bearer";
let server: ReturnType<typeof spawn>;
let port = 0;
let headersFile = "";

beforeAll(async () => {
  headersFile = join(mkdtempSync(join(tmpdir(), "edp-smoke-srv-")), "auth.txt");
  server = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       require("node:http").createServer((req, res) => {
         fs.appendFileSync(process.argv[1], (req.headers.authorization ?? "") + "\\n");
         res.writeHead(req.url === "/api/seed-config" ? 200 : 404, { "content-type": "application/json" });
         res.end('{"datasetOwnerIds":[]}');
       }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`,
      headersFile,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  port = await new Promise<number>((done) =>
    server.stdout!.once("data", (chunk) => done(Number(String(chunk).trim()))),
  );
});
afterAll(() => server.kill());

function smoke(client: "curl" | "node") {
  const dir = mkdtempSync(join(tmpdir(), "edp-smoke-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of ["post-deploy-smoke.sh", "post-deploy-smoke.ts"]) {
    cpSync(join(ROOT, "scripts", file), join(dir, "scripts", file));
  }
  cpSync(join(ROOT, "src/deploy"), join(dir, "src/deploy"), { recursive: true });
  const bin = join(mkdtempSync(join(tmpdir(), "edp-smoke-bin-")), "bin");
  mkdirSync(bin);
  const log = join(bin, "..", "procs.log");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Every node and curl process records its argv and environment.
  const record = `{ echo "argv: $*"; env | sed 's/^/env: /'; } >> "${log}"`;
  fake("node", `${record}\nexec "${process.execPath}" "$@"`);
  fake("curl", `${record}\nexec /usr/bin/curl "$@"`);
  fake(
    "databricks",
    `case "$1 $2" in
  "apps get") echo '{"url":"http://127.0.0.1:${port}","active_deployment":{"deployment_id":"d1","source_code_path":"/Workspace/x/files/databricks-app","status":{"state":"SUCCEEDED"}}}' ;;
  "apps get-deployment") echo '{"env_vars":[{"name":"VITE_DATA_BACKEND","value":"delta"},{"name":"EDP_CLIENT_MINIFIED","value":"false"}]}' ;;
  "auth token") echo '{"access_token":"${TOKEN}"}' ;;
  *) exit 1 ;;
esac`,
  );
  const run = spawnSync(
    "bash",
    [join(dir, "scripts/post-deploy-smoke.sh"), "edp-vm-test", "-p", "gov"],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"]}`,
        EDP_SMOKE_HTTP_CLIENT: client,
        EDP_SMOKE_ATTEMPTS: "1",
      },
      encoding: "utf8",
    },
  );
  return { run, procs: readFileSync(log, "utf8") };
}

describe("scripts/post-deploy-smoke.sh", { timeout: 30_000 }, () => {
  it.each(["curl", "node"] as const)(
    "sends the Bearer token via %s, never in argv or env",
    (client) => {
      const before = readFileSyncSafe(headersFile);
      const { run, procs } = smoke(client);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("/api/seed-config returned 200");
      expect(readFileSyncSafe(headersFile).slice(before.length)).toContain(`Bearer ${TOKEN}`);
      expect(procs).toContain(client === "curl" ? "argv: -sS" : "argv: -e");
      expect(procs).not.toContain(TOKEN);
    },
  );
});

function readFileSyncSafe(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
