// Databricks App runtime command (app.yaml and databricks.yml `command`).
//
// This directory is the app's source. scripts/deploy.sh stages the prebuilt
// Nitro node-server bundle into it (server/, public/, build-info.json), so
// the app compute only starts that bundle: no npm install, no build.
//
// Databricks Apps expect the process to listen on DATABRICKS_APP_PORT. Nitro's
// node server reads PORT / NITRO_PORT, so we bridge the platform port onto
// those before importing the server bundle.
import { existsSync, readFileSync } from "node:fs";

const entry = new URL("./server/index.mjs", import.meta.url);
const buildInfo = new URL("./build-info.json", import.meta.url);

if (!existsSync(entry) || !existsSync(buildInfo)) {
  console.error(
    "[serve] No prebuilt server in this app source. Deploy with scripts/deploy-turnkey.sh, which builds and stages it.",
  );
  process.exit(1);
}

// scripts/deploy.sh writes build-info.json. Without every field we can't say
// how this server was built, so refuse rather than guess.
const BACKENDS = ["memory", "delta"];
let build;
try {
  build = JSON.parse(readFileSync(buildInfo, "utf8"));
} catch (error) {
  console.error(
    `[serve] build-info.json is not valid JSON (${error.message}). Redeploy with scripts/deploy-turnkey.sh.`,
  );
  process.exit(1);
}
const problems = [];
if (!BACKENDS.includes(build?.dataBackend)) {
  problems.push(`dataBackend must be one of ${BACKENDS.join(", ")}`);
}
for (const field of ["commit", "builtAt"]) {
  if (typeof build?.[field] !== "string" || build[field] === "")
    problems.push(`${field} is missing`);
}
if (problems.length > 0) {
  console.error(
    `[serve] build-info.json is incomplete: ${problems.join("; ")}. Redeploy with scripts/deploy-turnkey.sh.`,
  );
  process.exit(1);
}

// VITE_DATA_BACKEND is baked into the bundle at build time. The target also
// passes it at runtime, so a build staged for another backend fails here
// instead of serving the wrong store. Unset at runtime means memory, as in
// loadStore().
const built = build.dataBackend;
const expected = process.env.VITE_DATA_BACKEND || "memory";
if (built !== expected) {
  console.error(
    `[serve] This server was built with VITE_DATA_BACKEND=${built}, but the target sets ${expected}. Redeploy with scripts/deploy-turnkey.sh.`,
  );
  process.exit(1);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function readIntegerInRange(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new Error(`${name} must not be blank.`);
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}
function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new Error(`${name} must not be blank.`);
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be "true" or "false".`);
}
function readHolidays() {
  const raw = process.env.EDP_SLA_HOLIDAYS;
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("EDP_SLA_HOLIDAYS must not be blank; use [] for none.");
  if (trimmed === "[]") return [];
  const holidays = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!holidays.length) throw new Error("EDP_SLA_HOLIDAYS must name ISO dates or [].");
  for (const holiday of holidays) {
    const parsed = new Date(`${holiday}T00:00:00.000Z`);
    if (
      !ISO_DATE.test(holiday) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== holiday
    ) {
      throw new Error(`EDP_SLA_HOLIDAYS contains an invalid ISO date: ${holiday}.`);
    }
  }
  return holidays;
}
function validateSlaConfig() {
  readIntegerInRange("EDP_SLA_EDP_ROI_REVIEW_BUSINESS_DAYS", 5, 1, 60);
  readIntegerInRange("EDP_SLA_CCB_BUSINESS_DAYS", 5, 1, 60);
  readIntegerInRange("EDP_SLA_EIR_VALIDATION_BUSINESS_DAYS", 3, 1, 60);
  readIntegerInRange("EDP_SLA_ACCESS_REQUEST_DECISION_BUSINESS_DAYS", 3, 1, 60);
  readIntegerInRange("EDP_SLA_DUE_SOON_BUSINESS_DAYS", 1, 0, 60);
  readHolidays();
  readIntegerInRange("EDP_EIR_VALIDITY_DAYS", 365, 1, 3650);
  readBoolean("EDP_ACCESS_REQUEST_SLA_PROVISIONAL", true);
}
try {
  validateSlaConfig();
} catch (error) {
  console.error(
    `[serve] startup validation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const port = process.env.DATABRICKS_APP_PORT ?? process.env.PORT ?? "8000";
process.env.PORT = port;
process.env.NITRO_PORT = port;
process.env.HOST = process.env.HOST ?? "0.0.0.0";

// The app container's Node (v22.16.0 when this was written) is older than
// package.json's engines (>=24, which applies to building). Log it so every
// deploy shows the version the prebuilt server actually runs on.
console.log(
  `[serve] prebuilt server: commit ${build.commit}, VITE_DATA_BACKEND=${built}, built ${build.builtAt}, node ${process.version}`,
);
try {
  await import(entry.href);
} catch (error) {
  console.error(
    `[serve] server import failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
