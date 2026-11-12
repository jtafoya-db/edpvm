// Runtime smoke for the built server: stage .output/ the way scripts/deploy.sh
// does, start databricks-app/serve.mjs, and require GET /api/seed-config -> 200.
// It catches a server that builds but can't load (a missing _ssr/ module, a
// Zod 3 / `(void 0).` bundle) without a deploy or the logs websocket.
//
//   EDP_UNMINIFIED_BUILD=1 VITE_DATA_BACKEND=delta npm run build:databricks
//   npm run smoke:serve                      # delta, unminified (the govdev shape)
//   npm run smoke:serve -- --backend memory --minified true
//   EDP_SMOKE_NODE=/path/to/node22 npm run smoke:serve   # Databricks Apps runs Node 22
//
// --backend/--minified must describe how .output/ was built: serve.mjs checks
// them against the build-info.json written here, not against the bundle itself.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const backend = option("backend", "delta");
const minified = option("minified", "false");
const output = resolve(option("output", ".output"));
const nodeBinary = process.env.EDP_SMOKE_NODE || process.execPath;
const TIMEOUT_MS = Number(process.env.EDP_SMOKE_TIMEOUT_MS || 30_000);

if (!existsSync(join(output, "server/index.mjs")) || !existsSync(join(output, "public"))) {
  console.error(
    `[smoke:serve] no build at ${output}. Build first: EDP_UNMINIFIED_BUILD=1 VITE_DATA_BACKEND=${backend} npm run build:databricks`,
  );
  process.exit(1);
}

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const app = mkdtempSync(join(tmpdir(), "edp-serve-smoke-"));
cpSync(resolve("databricks-app/serve.mjs"), join(app, "serve.mjs"));
cpSync(join(output, "server"), join(app, "server"), { recursive: true });
cpSync(join(output, "public"), join(app, "public"), { recursive: true });
writeFileSync(
  join(app, "build-info.json"),
  JSON.stringify({
    dataBackend: backend,
    minified: minified === "true",
    commit: "smoke",
    builtAt: new Date().toISOString(),
  }),
);

const port = await freePort();
let logs = "";
const child = spawn(nodeBinary, ["serve.mjs"], {
  cwd: app,
  env: {
    ...process.env,
    NODE_ENV: "production",
    VITE_DATA_BACKEND: backend,
    EDP_CLIENT_MINIFIED: minified,
    DATABRICKS_APP_PORT: String(port),
    HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => (logs += chunk));
child.stderr.on("data", (chunk) => (logs += chunk));
let exited = null;
child.on("exit", (code) => (exited = code ?? -1));

const finish = (ok, message) => {
  child.kill();
  rmSync(app, { recursive: true, force: true });
  if (ok) console.log(`[smoke:serve] ${message}`);
  else console.error(`[smoke:serve] FAILED: ${message}\n--- serve.mjs output ---\n${logs}`);
  process.exit(ok ? 0 : 1);
};

const deadline = Date.now() + TIMEOUT_MS;
let last = "no response";
while (Date.now() < deadline) {
  if (exited !== null) finish(false, `serve.mjs exited with code ${exited} before serving.`);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/seed-config`);
    const body = await response.text();
    if (response.status === 200) {
      const version = await new Promise((done) => {
        const probe = spawn(nodeBinary, ["--version"]);
        let out = "";
        probe.stdout.on("data", (chunk) => (out += chunk));
        probe.on("exit", () => done(out.trim()));
      });
      finish(
        true,
        `GET /api/seed-config -> 200 ${body.trim()} (VITE_DATA_BACKEND=${backend}, minified=${minified}, node ${version}).`,
      );
    }
    last = `HTTP ${response.status} ${body.slice(0, 200)}`;
    break;
  } catch {
    await new Promise((done) => setTimeout(done, 250));
  }
}
finish(false, `GET /api/seed-config: ${last}`);
