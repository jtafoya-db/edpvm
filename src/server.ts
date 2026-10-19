import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { isDeltaApiPath } from "./server/delta/api";
import { handleDeltaApi } from "./server/delta/config";
import { handleSeedConfigRequest } from "./server/seed-config";
import { handleSessionRequest } from "./server/session";
import { handleEirFileRequest, handleEirUploadRequest } from "./server/eir-api";
import { EIR_DEFINITION_CHECK_PATH, handleEirDefinitionCheck } from "./server/eir-definition-check";
import "./server/sla-config";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Identity seam: resolve the real signed-in Databricks App identity
      // server-side before handing off to the (client-only) TanStack app.
      // Only GET is a valid read of the session; reject other methods.
      if (new URL(request.url).pathname === "/api/session") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
          });
        }
        return await handleSessionRequest(request, env);
      }
      if (new URL(request.url).pathname === "/api/eir/files") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
          });
        }
        return await handleEirFileRequest(request, env);
      }
      // A signed EIR PDF, stored on the volume; the `eir/submit` command records it.
      if (new URL(request.url).pathname === "/api/eir/uploads") {
        return await handleEirUploadRequest(request, env);
      }
      // Validate and preview an EIR definition (#201): staff app, Safeguards only.
      if (new URL(request.url).pathname === EIR_DEFINITION_CHECK_PATH) {
        return await handleEirDefinitionCheck(request, env);
      }
      // Seed configuration for the in-memory store (who owns the seeded dataset).
      if (new URL(request.url).pathname === "/api/seed-config" && request.method === "GET") {
        return handleSeedConfigRequest(env);
      }
      // The Delta command and read API (#76). The browser never sends SQL:
      // each command and read is a registered server handler, and the actor
      // comes from the session.
      if (isDeltaApiPath(new URL(request.url).pathname)) {
        return await handleDeltaApi(request, env);
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
