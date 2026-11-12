// @vitest-environment node
/**
 * The post-deploy smoke verdict (seam: src/deploy/postDeploySmoke.ts), which
 * scripts/post-deploy-smoke.sh feeds with `apps get`, `apps get-deployment`,
 * the uploaded app.yaml and an authenticated GET of /api/seed-config.
 */
import { describe, expect, it } from "vitest";

import { classifyProbe, evaluatePostDeploy, type SmokeInput } from "../postDeploySmoke.ts";

const APP_YAML = `command:
  - "node"
  - "serve.mjs"
env:
  - name: "VITE_DATA_BACKEND"
    value: "delta"
  - name: "EDP_CLIENT_MINIFIED"
    value: "false"
`;

const healthy = (): SmokeInput => ({
  appName: "edp-vm-test",
  profile: "gov",
  app: {
    url: "https://edp-vm-test.example",
    active_deployment: { deployment_id: "d1", status: { state: "SUCCEEDED" } },
  },
  deployment: {
    deployment_id: "d1",
    status: { state: "SUCCEEDED" },
    env_vars: [
      { name: "VITE_DATA_BACKEND", value: "delta" },
      { name: "EDP_CLIENT_MINIFIED", value: "false" },
    ],
  },
  appYamlText: APP_YAML,
  probe: { status: 200, body: '{"datasetOwnerIds":[]}' },
});

describe("evaluatePostDeploy", () => {
  it("passes a succeeded deployment with the env and a 200 seed-config", () => {
    expect(evaluatePostDeploy(healthy())).toEqual({ ok: true, failures: [] });
  });

  it("fails a deployment that didn't succeed, naming the next command", () => {
    const input = healthy();
    input.app = {
      ...(input.app as object),
      active_deployment: { deployment_id: "d1", status: { state: "FAILED", message: "boom" } },
    };
    const { ok, failures } = evaluatePostDeploy(input);
    expect(ok).toBe(false);
    expect(failures[0]?.message).toMatch(/FAILED.*boom/);
    expect(failures[0]?.next).toContain("databricks apps get edp-vm-test -p gov -o json");
  });

  it("accepts the env from the uploaded app.yaml when the platform dropped env_vars", () => {
    const input = healthy();
    input.deployment = { deployment_id: "d1", status: { state: "SUCCEEDED" } };
    expect(evaluatePostDeploy(input).ok).toBe(true);
  });

  it("accepts env_vars as a name->value map", () => {
    const input = healthy();
    input.deployment = {
      env_vars: { VITE_DATA_BACKEND: "delta", EDP_CLIENT_MINIFIED: "false" },
    };
    input.appYamlText = undefined;
    expect(evaluatePostDeploy(input).ok).toBe(true);
  });

  it("fails when neither the deployment nor app.yaml carries the required env", () => {
    const input = healthy();
    input.deployment = { env_vars: [{ name: "NODE_ENV", value: "production" }] };
    input.appYamlText = "command:\n  - node\n  - serve.mjs\n";
    const { failures } = evaluatePostDeploy(input);
    expect(failures.map((f) => f.check)).toContain("env");
    const env = failures.find((f) => f.check === "env");
    expect(env?.message).toMatch(/VITE_DATA_BACKEND, EDP_CLIENT_MINIFIED/);
    expect(env?.next).toContain("databricks apps get-deployment edp-vm-test d1 -p gov -o json");
  });

  it("fails a non-200 seed-config probe with the response fingerprint", () => {
    const input = healthy();
    input.probe = { status: 500, body: '{"error":true,"status":500,"unhandled":true}' };
    const probe = evaluatePostDeploy(input).failures.find((f) => f.check === "seed-config");
    expect(probe?.message).toMatch(/HTTP 500/);
    expect(probe?.message).toMatch(/server module/);
  });

  it("fails when there is no app URL or no probe", () => {
    const input = healthy();
    input.app = { active_deployment: { status: { state: "SUCCEEDED" } } };
    input.probe = undefined;
    const checks = evaluatePostDeploy(input).failures.map((f) => f.check);
    expect(checks).toEqual(expect.arrayContaining(["url", "seed-config"]));
  });

  it("omits -p from the diagnostic commands when no profile was given", () => {
    const input = healthy();
    input.profile = "";
    input.probe = { status: 502, body: "" };
    const probe = evaluatePostDeploy(input).failures.find((f) => f.check === "seed-config");
    expect(probe?.next).not.toContain("-p");
  });
});

describe("classifyProbe", () => {
  it.each([
    [200, "{}", /ok/],
    [500, '{"error":true,"status":500,"unhandled":true}', /server module.*_ssr/],
    [500, "<html>Something went wrong</html>", /request handler threw/],
    [502, "App Not Available", /not running.*serve\.mjs/],
    [503, "", /not running.*serve\.mjs/],
    [302, "", /sign-in.*token/],
    [401, "", /sign-in.*token/],
    [0, "", /no HTTP response/],
  ])("explains HTTP %s", (status, body, explanation) => {
    expect(classifyProbe(status, body)).toMatch(explanation);
  });
});
