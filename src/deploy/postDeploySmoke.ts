/**
 * The post-deploy smoke verdict. scripts/post-deploy-smoke.sh gathers the
 * inputs (`apps get`, `apps get-deployment`, the uploaded app.yaml and an
 * authenticated GET of <app-url>/api/seed-config) and this decides, printing
 * what failed and the next diagnostic command for each failure.
 *
 * /api/seed-config is the probe because the server answers it before it
 * touches the store or SSR, but only after server/index.mjs and the lazily
 * loaded _ssr/ssr.mjs both import. So a 200 proves the launcher accepted its
 * env and the server modules load, before provisioning or grants run.
 */
import { parseAppYaml, REQUIRED_RUNTIME_ENV } from "./appYaml.ts";

export interface SmokeInput {
  appName: string;
  /** The CLI profile, or "" for the default auth. */
  profile: string;
  /** `databricks apps get <name> -o json`. */
  app: unknown;
  /** `databricks apps get-deployment <name> <id> -o json`, if it could be read. */
  deployment?: unknown | undefined;
  /** The staged app.yaml, which deploy.sh verified matches the workspace copy. */
  appYamlText?: string | undefined;
  /** The GET of /api/seed-config; status 0 means no HTTP response. */
  probe?: { status: number; body: string } | undefined;
}

export interface SmokeFailure {
  check: "deployment" | "url" | "env" | "seed-config";
  message: string;
  next: string;
}

const NITRO_UNHANDLED = /"unhandled"\s*:\s*true/;

/** Explain an /api/seed-config response by its status and body fingerprint. */
export function classifyProbe(status: number, body: string): string {
  if (status === 200) return "ok";
  if (status === 0) return "no HTTP response (DNS, proxy or TLS failure, or a timeout)";
  if (status === 301 || status === 302 || status === 303 || status === 401 || status === 403) {
    return "the app redirected to sign-in or refused the token: check the profile and `databricks auth token`";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "the app is not running: serve.mjs exited at startup (missing or mismatched VITE_DATA_BACKEND / EDP_CLIENT_MINIFIED, or bad SLA env); run it locally with the deployed app.yaml env";
  }
  if (status === 500 && NITRO_UNHANDLED.test(body)) {
    return "Nitro could not load a server module: server/_ssr/ssr.mjs or _chunks/ missing from the upload, or the module throws at load (a Zod 3 / (void 0). bundle)";
  }
  if (status === 500)
    return "the request handler threw (an HTML error page): the server loaded but failed this request";
  return `unexpected HTTP ${status}`;
}

const envNames = (deployment: unknown): Set<string> => {
  const raw = (deployment as { env_vars?: unknown } | undefined)?.env_vars;
  if (Array.isArray(raw)) {
    return new Set(
      raw
        .map((entry) => (entry as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === "string"),
    );
  }
  if (raw && typeof raw === "object") return new Set(Object.keys(raw));
  return new Set();
};

const appYamlNames = (text: string | undefined): Set<string> => {
  if (text === undefined) return new Set();
  try {
    return new Set(
      parseAppYaml(text)
        .env.filter((entry) => entry.value !== undefined || entry.valueFrom !== undefined)
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
};

export function evaluatePostDeploy(input: SmokeInput): { ok: boolean; failures: SmokeFailure[] } {
  const p = input.profile ? ` -p ${input.profile}` : "";
  const app = (input.app ?? {}) as {
    url?: unknown;
    active_deployment?: {
      deployment_id?: unknown;
      status?: { state?: unknown; message?: unknown };
    };
  };
  const failures: SmokeFailure[] = [];
  const deploymentId =
    typeof app.active_deployment?.deployment_id === "string"
      ? app.active_deployment.deployment_id
      : "<deployment-id>";

  const state = app.active_deployment?.status?.state;
  if (state !== "SUCCEEDED") {
    const message = app.active_deployment?.status?.message;
    failures.push({
      check: "deployment",
      message: `the active deployment is ${typeof state === "string" ? state : "missing"}${typeof message === "string" && message ? `: ${message}` : ""}.`,
      next: `databricks apps get ${input.appName}${p} -o json`,
    });
  }

  const url = typeof app.url === "string" && app.url ? app.url : "";
  if (!url) {
    failures.push({
      check: "url",
      message: "apps get reported no app URL.",
      next: `databricks apps get ${input.appName}${p} -o json`,
    });
  }

  const deployed = envNames(input.deployment);
  const uploaded = appYamlNames(input.appYamlText);
  const absent = REQUIRED_RUNTIME_ENV.filter((name) => !deployed.has(name) && !uploaded.has(name));
  if (absent.length) {
    failures.push({
      check: "env",
      message: `neither the deployment's env_vars nor the uploaded app.yaml sets ${absent.join(", ")}; serve.mjs exits without them.`,
      next: `databricks apps get-deployment ${input.appName} ${deploymentId}${p} -o json`,
    });
  }

  const probe = input.probe;
  if (!probe || probe.status !== 200) {
    const status = probe?.status ?? 0;
    const body = (probe?.body ?? "").replace(/\s+/g, " ").slice(0, 200);
    failures.push({
      check: "seed-config",
      message: `GET ${url || "<app-url>"}/api/seed-config returned ${status ? `HTTP ${status}` : "nothing"}${body ? ` (${body})` : ""}: ${classifyProbe(status, probe?.body ?? "")}.`,
      next: `curl -i -H "Authorization: Bearer <access_token from: databricks auth token${p}>" ${url || "<app-url>"}/api/seed-config  (then docs/databricks-app.md -> "Diagnosing a GovCloud deploy")`,
    });
  }

  return { ok: failures.length === 0, failures };
}
