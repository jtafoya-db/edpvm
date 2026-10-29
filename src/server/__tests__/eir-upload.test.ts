// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleEirUploadRequest } from "../eir-api";
import type { SessionUser } from "../delta/registry.ts";
import { resetSessionIdentityCacheForTests } from "../session";
import { GOVCLOUD_CASES } from "./govcloud-identity";

const pdfFile = (text = "%PDF-1.7 signed", type = "application/pdf") =>
  new File([text], "signed.pdf", { type });

function upload(file: File | string | null, headers: Record<string, string> = {}) {
  const body = new FormData();
  if (file !== null) body.set("file", file);
  return new Request("https://app/api/eir/uploads", { method: "POST", body, headers });
}

const storage = () => ({
  write: vi.fn().mockResolvedValue(undefined),
  read: vi.fn(),
  list: vi.fn(),
});
const allowPrivacy = async () => undefined;

describe("POST /api/eir/uploads", () => {
  beforeEach(() => {
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
    vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
    vi.stubEnv("EIR_VOLUME_NAME", "eir");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes the PDF once, at a new path in the caller's own folder, and answers with that path", async () => {
    const files = storage();
    const response = await handleEirUploadRequest(
      upload(pdfFile()),
      undefined,
      files,
      allowPrivacy,
    );
    expect(response.status).toBe(201);
    const { volumePath } = (await response.json()) as { volumePath: string };
    expect(volumePath).toMatch(
      /^\/Volumes\/edp\/docs\/eir\/dev-local-user\/\d+-[0-9a-f-]{36}\.pdf$/,
    );
    expect(files.write).toHaveBeenCalledWith(volumePath, expect.any(Uint8Array), {
      overwrite: false,
    });
  });

  it.each([
    ["a file that isn't a PDF", pdfFile("hello", "text/plain"), 415],
    ["a .pdf that doesn't start like one", pdfFile("hello"), 415],
    ["no file", null, 400],
    ["a text field instead of a file", "%PDF-1.7", 400],
  ])("refuses %s without writing", async (_label, file, status) => {
    const files = storage();
    const response = await handleEirUploadRequest(upload(file), undefined, files, allowPrivacy);
    expect(response.status).toBe(status);
    expect(files.write).not.toHaveBeenCalled();
  });

  it("refuses an oversized upload by Content-Length before reading the body, and by size after", async () => {
    vi.stubEnv("EIR_MAX_UPLOAD_BYTES", "10");
    const files = storage();
    const declared = upload(pdfFile(), { "content-length": String(10 + 64 * 1024 + 1) });
    declared.formData = vi.fn() as typeof declared.formData;
    expect((await handleEirUploadRequest(declared, undefined, files, allowPrivacy)).status).toBe(
      413,
    );
    expect(declared.formData).not.toHaveBeenCalled();
    expect(
      (await handleEirUploadRequest(upload(pdfFile()), undefined, files, allowPrivacy)).status,
    ).toBe(413);
    expect(files.write).not.toHaveBeenCalled();
  });

  it("refuses anything but multipart POST", async () => {
    const files = storage();
    expect(
      (
        await handleEirUploadRequest(
          new Request("https://app/api/eir/uploads"),
          undefined,
          files,
          allowPrivacy,
        )
      ).status,
    ).toBe(405);
    const json = new Request("https://app/api/eir/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ volumePath: "/Volumes/edp/docs/eir/victim/x.pdf" }),
    });
    expect((await handleEirUploadRequest(json, undefined, files, allowPrivacy)).status).toBe(415);
    expect(files.write).not.toHaveBeenCalled();
  });

  it("refuses an unsafe signed-in principal ID before reading the body", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "../victim", displayName: "Unsafe", groups: [] }), {
        status: 200,
      }),
    );
    const files = storage();
    const request = upload(pdfFile(), { "x-forwarded-access-token": "obo" });
    request.formData = vi.fn() as typeof request.formData;
    expect((await handleEirUploadRequest(request, undefined, files, allowPrivacy)).status).toBe(
      400,
    );
    expect(request.formData).not.toHaveBeenCalled();
    expect(files.write).not.toHaveBeenCalled();
  });
});

describe("POST /api/eir/uploads — a GovCloud person with no name (#332)", () => {
  afterEach(() => {
    // Every case sends the same token; /Me is cached per token.
    resetSessionIdentityCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(GOVCLOUD_CASES)(
    "acts as %s, never the numeric X-Forwarded-User",
    async (_label, govCloud, expected) => {
      vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
      vi.stubEnv("EDP_IDENTITY_MODE", "production");
      vi.stubEnv("EIR_VOLUME_CATALOG", "edp");
      vi.stubEnv("EIR_VOLUME_SCHEMA", "docs");
      vi.stubEnv("EIR_VOLUME_NAME", "eir");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(govCloud.me), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const seen: SessionUser[] = [];
      const files = storage();
      const response = await handleEirUploadRequest(
        upload(pdfFile(), {
          "x-forwarded-access-token": "obo-token",
          "x-forwarded-user": govCloud.headers.user!,
          ...(govCloud.headers.email ? { "x-forwarded-email": govCloud.headers.email } : {}),
        }),
        undefined,
        files,
        async (user) => {
          seen.push(user);
        },
      );
      expect(response.status).toBe(201);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ principalId: govCloud.me.id, displayName: expected });
      expect(JSON.stringify(seen[0])).not.toContain("1234567890123456");
    },
  );
});
