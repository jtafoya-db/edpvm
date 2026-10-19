import { IdentityResolutionError } from "./identity";
import { resolveSessionProfile } from "./session";
import {
  createDatabricksEirFileStorage,
  eirVolumePath,
  type EirFileStorageClient,
} from "./eir-storage";
import { isSafePrincipalId, parseEirPdfPath } from "./eir-path";
import { requireConfiguredPrivacyAcknowledgment } from "./delta/config";
import { DomainError } from "./delta/errors";
import type { SessionUser } from "./delta/registry";

function value(env: unknown, name: string): string | undefined {
  const processValue = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
  if (processValue) return processValue;
  const candidate =
    env && typeof env === "object" ? (env as Record<string, unknown>)[name] : undefined;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const oauthTokens = new Map<string, { token: string; expiresAt: number; request: typeof fetch }>();

export function maxUploadBytes(env: unknown): number {
  const configured = value(env, "EIR_MAX_UPLOAD_BYTES");
  if (!configured) return DEFAULT_MAX_UPLOAD_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("EIR_MAX_UPLOAD_BYTES must be a positive integer.");
  }
  return parsed;
}

export async function resolveEirStorage(env: unknown): Promise<EirFileStorageClient> {
  const configuredHost = value(env, "DATABRICKS_HOST");
  if (!configuredHost) throw new Error("DATABRICKS_HOST is required for EIR volume storage.");
  const host = (
    /^https?:\/\//i.test(configuredHost) ? configuredHost : `https://${configuredHost}`
  ).replace(/\/$/, "");
  let token = value(env, "DATABRICKS_TOKEN");
  if (!token) {
    const clientId = value(env, "DATABRICKS_CLIENT_ID");
    const clientSecret = value(env, "DATABRICKS_CLIENT_SECRET");
    if (!clientId || !clientSecret)
      throw new Error(
        "Databricks service-principal credentials are required for EIR volume storage.",
      );
    const cacheKey = `${host}\n${clientId}`;
    const request = fetch;
    const cached = oauthTokens.get(cacheKey);
    if (cached && cached.request === request && cached.expiresAt - 60_000 > Date.now()) {
      token = cached.token;
    } else {
      const response = await request(`${host.replace(/\/$/, "")}/oidc/v1/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials&scope=all-apis",
      });
      if (!response.ok)
        throw new Error(`Databricks OAuth token request failed (${response.status}).`);
      const payload = (await response.json()) as { access_token?: string; expires_in?: number };
      token = payload.access_token;
      if (token) {
        const expiresIn =
          typeof payload.expires_in === "number" && payload.expires_in > 0
            ? payload.expires_in
            : 3600;
        oauthTokens.set(cacheKey, {
          token,
          expiresAt: Date.now() + expiresIn * 1000,
          request,
        });
      }
    }
  }
  if (!token) throw new Error("Databricks OAuth response contained no access token.");
  return createDatabricksEirFileStorage({ host, token });
}

export function resolveEirVolumeConfig(env: unknown) {
  const catalog = value(env, "EIR_VOLUME_CATALOG");
  const schema = value(env, "EIR_VOLUME_SCHEMA");
  const volume = value(env, "EIR_VOLUME_NAME");
  if (!catalog || !schema || !volume)
    throw new Error("EIR volume catalog, schema, and name must be configured.");
  return { catalog, schema, volume };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

type EirPrivacyGuard = (user: SessionUser) => Promise<void>;

const sessionUser = (profile: Awaited<ReturnType<typeof resolveSessionProfile>>): SessionUser => ({
  principalId: profile.principalId,
  displayName: profile.name,
  email: profile.email,
  isAdmin: profile.isAdmin,
  onboardingReviewerRoles: profile.onboardingReviewerRoles ?? [],
  isSafeguardsValidator: profile.isSafeguardsValidator ?? false,
});

const privacyErrorResponse = (error: unknown): Response | undefined =>
  error instanceof DomainError
    ? json({ error: error.message, code: error.code }, error.status)
    : undefined;

export async function handleEirFileRequest(
  request: Request,
  env?: unknown,
  injectedStorage?: EirFileStorageClient,
  injectedPrivacyGuard?: EirPrivacyGuard,
): Promise<Response> {
  try {
    const profile = await resolveSessionProfile(request, env);
    if (!isSafePrincipalId(profile.principalId)) {
      return json({ error: "Invalid principal id." }, 400);
    }
    const storage = injectedStorage ?? (await resolveEirStorage(env));
    if (request.method === "GET") {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      const config = resolveEirVolumeConfig(env);
      const parsed = parseEirPdfPath(path, config);
      if (!parsed || (parsed.owner !== profile.principalId && !profile.isSafeguardsValidator))
        return json({ error: "Forbidden" }, 403);
      if (parsed.owner === profile.principalId) {
        await (
          injectedPrivacyGuard ?? ((user) => requireConfiguredPrivacyAcknowledgment(user, env))
        )(sessionUser(profile));
      }
      const bytes = await storage.read(path);
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "inline; filename=employee-identity-record.pdf",
          "cache-control": "no-store",
        },
      });
    }
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  } catch (error) {
    const privacyResponse = privacyErrorResponse(error);
    if (privacyResponse) return privacyResponse;
    const status = error instanceof IdentityResolutionError ? error.status : 500;
    return json(
      { error: error instanceof Error ? error.message : "EIR file operation failed." },
      status,
    );
  }
}

/**
 * `POST /api/eir/uploads`: store a signed EIR PDF in the caller's own folder
 * of the EIR volume, at a new path (never overwriting), and answer with that
 * path. Submitting it is the `eir/submit` command, which checks the path is
 * the caller's and reads the file back to hash it: nothing the browser says
 * about the file is trusted. An upload that's never submitted stays
 * unreferenced (docs/eir-volume.md).
 */
export async function handleEirUploadRequest(
  request: Request,
  env?: unknown,
  injectedStorage?: EirFileStorageClient,
  injectedPrivacyGuard?: EirPrivacyGuard,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  try {
    const profile = await resolveSessionProfile(request, env);
    if (!isSafePrincipalId(profile.principalId)) {
      return json({ error: "Invalid principal id." }, 400);
    }
    await (injectedPrivacyGuard ?? ((user) => requireConfiguredPrivacyAcknowledgment(user, env)))(
      sessionUser(profile),
    );
    if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
      return json({ error: "Send the signed PDF as multipart form data." }, 415);
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxUploadBytes(env) + 64 * 1024) {
      return json({ error: "The PDF exceeds the configured upload size limit." }, 413);
    }
    const file = (await request.formData()).get("file");
    if (typeof file === "string" || !file || typeof file.arrayBuffer !== "function") {
      return json({ error: "A PDF file is required." }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > maxUploadBytes(env)) {
      return json({ error: "The PDF exceeds the configured upload size limit." }, 413);
    }
    if (
      file.type !== "application/pdf" ||
      bytes.length < 5 ||
      new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
    ) {
      return json({ error: "Only PDF files are accepted." }, 415);
    }
    const storage = injectedStorage ?? (await resolveEirStorage(env));
    const volumePath = eirVolumePath(
      resolveEirVolumeConfig(env),
      profile.principalId,
      `${Date.now()}-${globalThis.crypto.randomUUID()}`,
    );
    await storage.write(volumePath, bytes, { overwrite: false });
    return json({ volumePath }, 201);
  } catch (error) {
    const privacyResponse = privacyErrorResponse(error);
    if (privacyResponse) return privacyResponse;
    const status = error instanceof IdentityResolutionError ? error.status : 500;
    return json(
      { error: error instanceof Error ? error.message : "The PDF upload failed." },
      status,
    );
  }
}
