import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabricksEirFileStorage, eirVolumePath } from "../eir-storage";
import { handleEirFileRequest, resolveEirStorage } from "../eir-api";
import { resetSessionIdentityCacheForTests } from "../session";

describe("injected EIR file-storage seam", () => {
  afterEach(() => {
    resetSessionIdentityCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes and reads unique files through the Databricks Files API", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70, 45])));
    const storage = createDatabricksEirFileStorage({
      host: "https://workspace.example",
      token: "secret",
      fetch: request,
    });
    const path = eirVolumePath(
      { catalog: "edp", schema: "docs", volume: "eir" },
      "scim/42",
      "submission-1",
    );
    expect(path).toBe("/Volumes/edp/docs/eir/scim_42/submission-1.pdf");
    await storage.write(path, new Uint8Array([37, 80, 68, 70, 45]));
    await expect(storage.read(path)).resolves.toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    expect(request.mock.calls[1]?.[0]).toContain(
      "/api/2.0/fs/files/Volumes/edp/docs/eir/scim_42/submission-1.pdf",
    );
  });

  it.each([
    "/Volumes/edp/docs/eir/person/%2e%2e/victim/_record.json?.pdf",
    "/Volumes/edp/docs/eir/person/../victim/file.pdf",
    "/Volumes/edp/docs/eir/person/file?.pdf",
    "/Volumes/edp/docs/eir/person/file#.pdf",
  ])("rejects unsafe path segments before issuing a workspace request: %s", async (path) => {
    const request = vi.fn();
    const storage = createDatabricksEirFileStorage({
      host: "https://workspace.example",
      token: "secret",
      fetch: request,
    });

    await expect(storage.read(path)).rejects.toThrow("Unsafe Unity Catalog volume path");
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes a scheme-less injected host before service-principal OAuth", async () => {
    vi.stubEnv("DATABRICKS_HOST", "workspace.example");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "client-id");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "client-secret");
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "runtime-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("%PDF-test"), { status: 200 }));
    const storage = await resolveEirStorage(undefined);
    await storage.read("/Volumes/c/s/v/person/a.pdf");
    expect(request.mock.calls[0]?.[0]).toBe("https://workspace.example/oidc/v1/token");
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://workspace.example/api/2.0/fs/files/Volumes/c/s/v/person/a.pdf",
    );
  });

  it("reuses a service-principal OAuth token until it approaches expiry", async () => {
    vi.stubEnv("DATABRICKS_HOST", "cache.example");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "cache-client");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "cache-secret");
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/oidc/v1/token")) {
        return new Response(JSON.stringify({ access_token: "cached-token", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(new TextEncoder().encode("%PDF-test"), { status: 200 });
    });

    const first = await resolveEirStorage(undefined);
    await first.read("/Volumes/c/s/v/person/a.pdf");
    const second = await resolveEirStorage(undefined);
    await second.read("/Volumes/c/s/v/person/b.pdf");

    expect(
      request.mock.calls.filter(([input]) => String(input).endsWith("/oidc/v1/token")),
    ).toHaveLength(1);
  });

  it("rejects the removed upload-only POST route", async () => {
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    const storage = { write: vi.fn(), read: vi.fn(), list: vi.fn() };
    const request = new Request("https://app/api/eir/files", { method: "POST" });

    const response = await handleEirFileRequest(request, undefined, storage);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(storage.write).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])(
    "rejects an unsafe authenticated principal id before a %s file operation",
    async (method) => {
      vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
      vi.stubEnv("EDP_IDENTITY_MODE", "production");
      vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
      vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
      vi.stubEnv("EIR_VOLUME_NAME", "eir");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id: "../victim", displayName: "Unsafe", groups: [] }), {
          status: 200,
        }),
      );
      const storage = { write: vi.fn(), read: vi.fn(), list: vi.fn() };
      const path =
        "/Volumes/edp/docs/eir/victim/1790887200000-123e4567-e89b-42d3-a456-426614174000.pdf";
      const request = new Request(`https://app/api/eir/files?path=${encodeURIComponent(path)}`, {
        method,
        headers: { "x-forwarded-access-token": "obo" },
      });
      request.formData = vi.fn() as typeof request.formData;

      const response = await handleEirFileRequest(request, undefined, storage);

      expect(response.status).toBe(400);
      expect(request.formData).not.toHaveBeenCalled();
      expect(storage.write).not.toHaveBeenCalled();
      expect(storage.read).not.toHaveBeenCalled();
    },
  );

  it("allows only the owner or an EDP admin group member (a validator) to read a PDF", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "validators");
    vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
    vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
    vi.stubEnv("EIR_VOLUME_NAME", "eir");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "validator-1",
          displayName: "Val",
          groups: [{ value: "validators" }],
        }),
        { status: 200 },
      ),
    );
    const storage = {
      write: vi.fn(),
      read: vi.fn().mockResolvedValue(new TextEncoder().encode("%PDF-test")),
      list: vi.fn(),
    };
    const path =
      "/Volumes/edp/docs/eir/someone-else/1790887200000-123e4567-e89b-42d3-a456-426614174000.pdf";
    const response = await handleEirFileRequest(
      new Request(`https://app/api/eir/files?path=${encodeURIComponent(path)}`, {
        headers: { "x-forwarded-access-token": "obo" },
      }),
      undefined,
      storage,
    );
    expect(response.status).toBe(200);
    expect(storage.read).toHaveBeenCalledWith(path);
  });

  it("refuses another person's PDF to someone in only the reserved validator group (#226)", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "edp-admins");
    vi.stubEnv("EDP_SAFEGUARDS_VALIDATOR_GROUP_ID", "validators");
    vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
    vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
    vi.stubEnv("EIR_VOLUME_NAME", "eir");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "person-2", displayName: "Other", groups: [{ value: "validators" }] }),
        { status: 200 },
      ),
    );
    const storage = { write: vi.fn(), read: vi.fn(), list: vi.fn() };
    const path =
      "/Volumes/edp/docs/eir/person-1/1790887200000-123e4567-e89b-42d3-a456-426614174000.pdf";
    const response = await handleEirFileRequest(
      new Request(`https://app/api/eir/files?path=${encodeURIComponent(path)}`, {
        headers: { "x-forwarded-access-token": "obo" },
      }),
      undefined,
      storage,
    );
    expect(response.status).toBe(403);
    expect(storage.read).not.toHaveBeenCalled();
  });

  it("refuses another person's PDF to a non-validator", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
    vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
    vi.stubEnv("EIR_VOLUME_NAME", "eir");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "person-2", displayName: "Other", groups: [] }), {
        status: 200,
      }),
    );
    const storage = { write: vi.fn(), read: vi.fn(), list: vi.fn() };
    const path =
      "/Volumes/edp/docs/eir/person-1/1790887200000-123e4567-e89b-42d3-a456-426614174000.pdf";
    const response = await handleEirFileRequest(
      new Request(`https://app/api/eir/files?path=${encodeURIComponent(path)}`, {
        headers: { "x-forwarded-access-token": "obo" },
      }),
      undefined,
      storage,
    );
    expect(response.status).toBe(403);
    expect(storage.read).not.toHaveBeenCalled();
  });

  it.each([
    "/Volumes/edp/docs/eir/validator-1/%2e%2e/victim/_record.json?.pdf",
    "/Volumes/edp/docs/eir/validator-1/1790887200000-123e4567-e89b-42d3-a456-426614174000.pdf?target=/api/2.0/clusters/list",
  ])("refuses a malformed PDF path before reading with validator authority: %s", async (path) => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "validators");
    vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
    vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
    vi.stubEnv("EIR_VOLUME_NAME", "eir");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "validator-1",
          displayName: "Val",
          groups: [{ value: "validators" }],
        }),
        { status: 200 },
      ),
    );
    const storage = { write: vi.fn(), read: vi.fn(), list: vi.fn() };

    const response = await handleEirFileRequest(
      new Request(`https://app/api/eir/files?path=${encodeURIComponent(path)}`, {
        headers: { "x-forwarded-access-token": "obo" },
      }),
      undefined,
      storage,
    );

    expect(response.status).toBe(403);
    expect(storage.read).not.toHaveBeenCalled();
  });
});
