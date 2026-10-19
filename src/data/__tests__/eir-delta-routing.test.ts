import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadStore, resetStoreForTests } from "../loadStore";
import { saveFailureMessage } from "../../components/Eir/EirShared";
import { EIR_VALUES } from "./eir-fixtures";

const values = EIR_VALUES;
const volumePath =
  "/Volumes/edp/docs/eir/scim-1/1790887200000-123e4567-e89b-42d3-a456-426614174000.pdf";
const record = {
  principalId: "scim-1",
  personName: "Test Person",
  stage: "submitted",
  submissions: [],
  actions: [],
  version: 1,
  draftVersion: 1,
  draftValues: values,
  draftStartedAt: "2026-10-01T12:00:00.000Z",
};
const evaluation = {
  definitionVersion: "bootstrap-2",
  formVersion: "bootstrap-2",
  effectiveAt: "2026-10-01T12:00:00.000Z",
  evaluatedDraftVersion: 1,
  outcome: "pass",
  outcomes: [],
  automaticValidityEligible: true,
  actorPrincipalId: "system",
  actorDisplay: "EDP Vending Machine",
  actorApp: "system",
};

function fakeServer() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body =
      url === "/api/session"
        ? { principalId: "scim-1", name: "Test Person", initials: "TP", isAdmin: true }
        : url.endsWith("/api/eir/uploads")
          ? { volumePath }
          : url.endsWith("/api/commands/eir/evaluate")
            ? { replayed: false, result: evaluation }
            : url.startsWith("/api/commands/")
              ? { replayed: false, result: record }
              : { ...record, evaluation };
    return new Response(JSON.stringify(body), {
      status: url.endsWith("/api/eir/uploads") ? 201 : 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe.each(["delta", "memory"])("EIR routing with VITE_DATA_BACKEND=%s", (backend) => {
  beforeAll(async () => {
    // Memory mode seeds its other areas from the prototype data.
    await import("../../legacy/appData.js");
  });
  afterEach(() => {
    resetStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts an EIR from the command result without a post-write read", async () => {
    vi.stubEnv("VITE_DATA_BACKEND", backend);
    const fetchSpy = fakeServer();

    await (await loadStore()).eir.start("scim-1", "Test Person");

    expect(fetchSpy.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/session",
      "/api/commands/eir/start",
    ]);
  });

  it("saves a draft with the supplied version and returns the command result without a post-write read", async () => {
    vi.stubEnv("VITE_DATA_BACKEND", backend);
    const fetchSpy = fakeServer();

    await (await loadStore()).eir.saveDraft("scim-1", values, 7);

    expect(fetchSpy.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/session",
      "/api/commands/eir/save-draft",
    ]);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toMatchObject({
      expectedVersion: 7,
      payload: { formVersion: "bootstrap-2", values },
    });
  });

  it("uploads the PDF and returns the eir/submit command result without a post-write read", async () => {
    vi.stubEnv("VITE_DATA_BACKEND", backend);
    const fetchSpy = fakeServer();
    const file = new File(["%PDF-test"], "signed.pdf", { type: "application/pdf" });
    const repository = (await loadStore()).eir;
    await repository.saveDraft("scim-1", values, 0);
    await repository.evaluateDraft("scim-1");

    const saved = await repository.submitWithFile({
      principalId: "scim-1",
      personName: "Test Person",
      file,
      values,
      response: "Answers",
      expectedVersion: 3,
    });

    const calls = fetchSpy.mock.calls.map(([path, init]) => [String(path), init?.method ?? "GET"]);
    expect(calls).toEqual([
      ["/api/session", "GET"],
      ["/api/commands/eir/save-draft", "POST"],
      ["/api/reads/eir/mine", "GET"],
      ["/api/commands/eir/evaluate", "POST"],
      ["/api/reads/eir/mine", "GET"],
      ["/api/eir/uploads", "POST"],
      ["/api/commands/eir/submit", "POST"],
    ]);
    expect(saved).toEqual(record);
    // The upload carries the file and nothing else: who it's for comes from the session.
    const upload = fetchSpy.mock.calls[5]![1]!.body as FormData;
    expect([...upload.keys()]).toEqual(["file"]);
    expect(upload.get("file")).toBeInstanceOf(File);
    // The command names the upload and the signed values; never a hash, a size or an actor.
    const command = JSON.parse(String(fetchSpy.mock.calls[6]![1]!.body)) as Record<string, unknown>;
    expect(command).toEqual({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedVersion: 3,
      payload: { volumePath, formVersion: "bootstrap-2", values, response: "Answers" },
    });
  });

  it("records a validator's decision with the version they read and returns the command result", async () => {
    vi.stubEnv("VITE_DATA_BACKEND", backend);
    const fetchSpy = fakeServer();

    await (await loadStore()).eir.decide("scim-1", "questions", "validator-1", "Why?", "Val", 4);

    const calls = fetchSpy.mock.calls.map(([path]) => String(path));
    expect(calls).toEqual(["/api/session", "/api/commands/eir/decide"]);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toMatchObject({
      expectedVersion: 4,
      payload: { principalId: "scim-1", decision: "questions", note: "Why?" },
    });
  });

  it("responds with the supplied version and returns the command result without a post-write read", async () => {
    vi.stubEnv("VITE_DATA_BACKEND", backend);
    const fetchSpy = fakeServer();

    await (
      await loadStore()
    ).eir.respond({
      principalId: "scim-1",
      values,
      response: "Clarified",
      expectedVersion: 9,
    });

    expect(fetchSpy.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/session",
      "/api/commands/eir/respond",
    ]);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toMatchObject({
      expectedVersion: 9,
      payload: { values, response: "Clarified" },
    });
  });
});

describe("Delta EIR pre-check failures after a saved draft", () => {
  afterEach(() => {
    resetStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    [
      "expired session",
      401,
      "session-expired",
      "Your sign-in has expired. Reload the page to sign in again — nothing was saved.",
    ],
    [
      "gateway timeout",
      504,
      "outcome-unknown",
      "Your draft was saved, but the pre-check couldn't be confirmed. Try again; retrying is safe.",
    ],
  ] as const)(
    "preserves the %s status and code with truthful pre-check copy",
    async (_case, status, code, message) => {
      vi.stubEnv("VITE_DATA_BACKEND", "delta");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url === "/api/session") {
          return new Response(
            JSON.stringify({ principalId: "scim-1", name: "Test Person", initials: "TP" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/reads/eir/mine") {
          return new Response(JSON.stringify(record), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(status === 401 ? "" : "<html>gateway timeout</html>", {
          status,
          headers: { "content-type": status === 401 ? "application/json" : "text/html" },
        });
      });

      const repository = (await loadStore()).eir;
      const failure = await repository.evaluateDraft("scim-1").catch((error: unknown) => error);
      expect(failure).toMatchObject({ status, code, message });
      expect(saveFailureMessage(failure)).toBe(message);
    },
  );
});
