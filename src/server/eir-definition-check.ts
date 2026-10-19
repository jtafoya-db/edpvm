/**
 * `POST /api/eir-definitions/check` (#201), staff app only: validate a
 * Safeguards author's EIR definition YAML and preview it (the form it
 * renders and every synthetic scenario's outcome) with the #200 definition
 * service. It reads and writes nothing: publishing is the
 * `eir-definitions/publish` command, which checks the YAML again.
 *
 * Body: `{ sourceYaml }` and nothing else. Who's asking comes from the
 * session. A tenant-only app doesn't mount it (404), and only the Safeguards
 * role may use it (403).
 */
import { z } from "zod";

import { canAuthorEirDefinitions } from "../data/eir/definition/access.ts";
import { resolveSessionIdentity, toSessionUser } from "./session";
import { DeltaConfigError, readSurfaces } from "./delta/config.ts";
import { checkEirDefinition } from "../data/eir/definition/check.ts";
import {
  EirDefinitionError,
  refuseOversizedDefinition,
} from "../data/eir/definition/repository.ts";
import { errorResponse, json } from "./delta/api.ts";
import { DomainError } from "./delta/errors.ts";
import type { AppSurface, SessionUser } from "./delta/registry.ts";

export const EIR_DEFINITION_CHECK_PATH = "/api/eir-definitions/check";

export interface EirDefinitionCheckDeps {
  resolveUser: (request: Request) => Promise<SessionUser>;
  serves: AppSurface[];
}

// The size limit is UTF-8 bytes, checked below with the memory adapter's own rule.
const checkBody = z.object({ sourceYaml: z.string() }).strict();

export async function handleEirDefinitionCheckRequest(
  request: Request,
  deps: EirDefinitionCheckDeps,
): Promise<Response> {
  if (!deps.serves.includes("staff")) {
    return json({ error: { code: "not-found", message: "No such endpoint." } }, 404);
  }
  if (request.method !== "POST") {
    return json({ error: { code: "method-not-allowed" } }, 405, { allow: "POST" });
  }
  try {
    const user = await deps.resolveUser(request);
    if (!canAuthorEirDefinitions(user)) {
      throw new DomainError("forbidden", "Only Safeguards can author EIR definitions.", 403);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new DomainError("invalid-request", "The request body must be JSON.", 400);
    }
    const { sourceYaml } = checkBody.parse(body);
    try {
      refuseOversizedDefinition(sourceYaml);
    } catch (error) {
      if (error instanceof EirDefinitionError) {
        throw new DomainError(error.code, error.message, error.status);
      }
      throw error;
    }
    return json(await checkEirDefinition(sourceYaml));
  } catch (error) {
    return errorResponse(error, `POST ${EIR_DEFINITION_CHECK_PATH}`);
  }
}

/** The server entry's handler: who's asking from the session, the surfaces from `EDP_APP_SURFACES`. */
export async function handleEirDefinitionCheck(request: Request, env?: unknown): Promise<Response> {
  let serves: AppSurface[];
  try {
    serves = readSurfaces(surfacesFromEnv(env));
  } catch (error) {
    if (error instanceof DeltaConfigError) {
      return json({ error: { code: "backend-not-configured", message: error.message } }, 503);
    }
    throw error;
  }
  return handleEirDefinitionCheckRequest(request, {
    serves,
    resolveUser: async (req) => toSessionUser(await resolveSessionIdentity(req, env)),
  });
}

function surfacesFromEnv(env: unknown): string | undefined {
  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.["EDP_APP_SURFACES"];
  if (fromProcess) return fromProcess;
  const value =
    env && typeof env === "object"
      ? (env as Record<string, unknown>)["EDP_APP_SURFACES"]
      : undefined;
  return typeof value === "string" && value ? value : undefined;
}
