// @vitest-environment node
/**
 * The `eir` area on Delta: the rows it writes, who may do what (validators
 * only for decisions and the inbox, never on their own EIR), races through
 * the runner, idempotent replays, and the server-side checks on the signed
 * PDF. Runs the real API handler, runner and area over the SQLite fake.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { eirVolumePath } from "../../eir-storage";
import { eirIdFor } from "../areas/eir-records.ts";
import { translate } from "./eir-sqlite-warehouse.ts";
import {
  APPLICANT,
  createClock,
  deltaImplementation,
  OTHER_PERSON,
  pdf,
  STAFF,
  VAL,
  VALUES,
  VIC,
  VOLUME,
  type DeltaImplementation,
} from "./eir-harness.ts";
import type { EirRecord } from "../../../data/eir/types";
import type { SessionUser } from "../registry.ts";
import {
  GOVCLOUD_CASES,
  govCloudSessionUser,
  leaksIdentifier,
} from "../../__tests__/govcloud-identity.ts";

const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";
const DAY = 86_400_000;

const post = (path: string, body: unknown) =>
  new Request(`https://app${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`https://app${path}`);

async function commandRecord(
  impl: DeltaImplementation,
  user: SessionUser,
  path: string,
  body: unknown,
): Promise<EirRecord> {
  const response = await impl.request(user, post(path, body));
  expect(response.status, path).toBe(200);
  return ((await response.json()) as { result: EirRecord }).result;
}

async function upload(impl: DeltaImplementation, user: SessionUser, n: number, text = "signed") {
  const current = await impl.as(user).get(user.principalId);
  if (!current.draftVersion || current.evaluation?.evaluatedDraftVersion !== current.draftVersion) {
    await impl.as(user).saveDraft(user.principalId, VALUES);
    await impl.as(user).evaluateDraft(user.principalId);
  }
  const path = eirVolumePath(
    VOLUME,
    user.principalId,
    `${1791000000000 + n}-00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
  );
  impl.files.set(path, new TextEncoder().encode(`%PDF-1.7 ${text}`));
  return path;
}

const submitBody = (volumePath: string, expectedVersion = 0, extra: object = {}) => ({
  idempotencyKey: globalThis.crypto.randomUUID(),
  expectedVersion,
  payload: { volumePath, formVersion: "bootstrap-2", values: VALUES, ...extra },
});

async function submitted(impl: DeltaImplementation, user = APPLICANT) {
  await impl.as(user).saveDraft(user.principalId, VALUES);
  await impl.as(user).evaluateDraft(user.principalId);
  return impl.as(user).submitWithFile({
    principalId: user.principalId,
    personName: user.displayName,
    file: pdf(),
    values: VALUES,
  });
}

describe("EIR on Delta: a GovCloud person with no name (#332)", () => {
  it.each(GOVCLOUD_CASES)(
    "stores the record's display name and the actor as %s, never the numeric id",
    async (_label, govCloud, expected) => {
      const user = await govCloudSessionUser(govCloud);
      const impl = deltaImplementation();
      const response = await impl.request(
        user,
        post("/api/commands/eir/start", { idempotencyKey: KEY, expectedVersion: 0, payload: {} }),
      );
      expect(response.status).toBe(200);
      const [record] = impl.warehouse.query<Record<string, unknown>>(
        "SELECT person_principal_id, person_display FROM eir__eirs",
      );
      expect(record).toEqual({ person_principal_id: user.principalId, person_display: expected });
      const actions = impl.warehouse.query<Record<string, unknown>>(
        "SELECT actor_display FROM eir__eir_actions",
      );
      expect(actions).toEqual([{ actor_display: expected }]);
      expect(leaksIdentifier(record!["person_display"])).toBe(false);
    },
  );
});

describe("EIR on Delta: what's stored", () => {
  it("writes the EIR, its submission and a lead action as the person, with the PDF's server-read hash", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path)),
    );
    expect(response.status).toBe(200);
    const eirId = await eirIdFor(APPLICANT.principalId);
    expect(impl.warehouse.query("SELECT * FROM eir__eirs")).toEqual([
      expect.objectContaining({
        id: eirId,
        person_principal_id: "1001",
        person_display: "Test Person",
        stage: "submitted",
        version: 1,
        created_by_principal_id: "1001",
        sla_due_at: "2026-10-06T12:00:00.000Z",
        sla_due_soon_at: "2026-10-05T12:00:00.000Z",
      }),
    ]);
    const [submission] = impl.warehouse.query<Record<string, unknown>>(
      "SELECT * FROM eir__eir_submissions",
    );
    const bytes = new TextEncoder().encode("%PDF-1.7 signed");
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    expect(submission).toMatchObject({
      eir_id: eirId,
      kind: "first",
      stage: "submitted",
      volume_path: path,
      document_size_bytes: bytes.length,
      document_sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
    });
    expect(JSON.parse(String(submission!["form_values"]))).toEqual(VALUES);
    expect(impl.warehouse.query("SELECT * FROM eir__eir_actions")).toEqual([
      expect.objectContaining({
        eir_id: eirId,
        eir_submission_id: submission!["id"],
        action: "submitted",
        from_stage: "not-started",
        to_stage: "submitted",
        record_version: 1,
        actor_principal_id: "1001",
        actor_display: "Test Person",
        actor_app: "tenant",
        caused_by_action_id: null,
      }),
    ]);
  });

  it("stores EIR SLA due dates from the configured target, due-soon threshold and holidays", async () => {
    const impl = deltaImplementation(createClock("2026-10-01T12:00:00.000Z"), {
      slaConfig: {
        stages: {
          "edp-roi-review": 5,
          ccb: 5,
          "eir-validation": 4,
          "access-request-decision": 3,
        },
        dueSoonThresholdBusinessDays: 0,
        holidays: ["2026-10-02"],
        eirValidityDays: 365,
        accessRequestSlaProvisional: true,
      },
    });
    const path = await upload(impl, APPLICANT, 1);

    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path)),
    );

    expect(response.status).toBe(200);
    expect(
      impl.warehouse.query("SELECT stage, sla_due_at, sla_due_soon_at FROM eir__eirs"),
    ).toEqual([
      expect.objectContaining({
        stage: "submitted",
        sla_due_at: "2026-10-08T12:00:00.000Z",
        sla_due_soon_at: "2026-10-08T12:00:00.000Z",
      }),
    ]);
  });

  it("reads the stored EIR SLA due date when the deployed target changes", async () => {
    const slaConfig = {
      stages: {
        "edp-roi-review": 5,
        ccb: 5,
        "eir-validation": 2,
        "access-request-decision": 3,
      },
      dueSoonThresholdBusinessDays: 0,
      holidays: ["2026-10-02"],
      eirValidityDays: 365,
      accessRequestSlaProvisional: true,
    };
    const impl = deltaImplementation(createClock("2026-10-01T12:00:00.000Z"), { slaConfig });
    await submitted(impl);
    expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).sla?.dueAt).toBe(
      "2026-10-06T12:00:00.000Z",
    );

    slaConfig.stages["eir-validation"] = 7;

    expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).sla?.dueAt).toBe(
      "2026-10-06T12:00:00.000Z",
    );
    expect((await impl.as(VAL).listValidatorInbox())[0]?.sla.dueAt).toBe(
      "2026-10-06T12:00:00.000Z",
    );
  });

  it("records a revocation as a system follow-on that closes the renewal, then the validator's lead action", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "revoked", VAL.principalId, "Left", VAL.displayName);
    interface ActionRow {
      action: string;
      from_stage: string;
      to_stage: string;
      record_version: number;
      actor_principal_id: string;
      actor_app: string;
      caused_by_action_id: string | null;
      action_id: string;
      note: string | null;
    }
    const actions = impl.warehouse.query<ActionRow>(
      "SELECT action, from_stage, to_stage, record_version, actor_principal_id, actor_app, caused_by_action_id, action_id, note FROM eir__eir_actions ORDER BY record_version",
    );
    expect(
      actions.map((a) => [a.action, a.from_stage, a.to_stage, a.record_version, a.actor_app]),
    ).toEqual([
      ["submitted", "not-started", "submitted", 1, "tenant"],
      ["validated", "submitted", "valid", 2, "staff"],
      ["renewal-submitted", "valid", "valid", 3, "tenant"],
      ["renewal-closed", "valid", "valid", 4, "system"],
      ["revoked", "valid", "revoked", 5, "staff"],
    ]);
    expect(actions[3]).toMatchObject({
      actor_principal_id: "system",
      caused_by_action_id: actions[4]!.action_id,
    });
    expect(
      impl.warehouse.query(
        "SELECT stage, kind FROM eir__eir_submissions ORDER BY submitted_at, volume_path",
      ),
    ).toEqual([
      { stage: "valid", kind: "first" },
      { stage: "closed", kind: "renewal" },
    ]);
    expect(
      impl.warehouse.query(
        "SELECT version, stage, renewal_submission_id, open_submission_id, expires_at FROM eir__eirs",
      ),
    ).toEqual([
      {
        version: 5,
        stage: "revoked",
        renewal_submission_id: null,
        open_submission_id: null,
        expires_at: null,
      },
    ]);
  });

  it("keeps a draft on its own row and version, without an action, and never on the EIR", async () => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    const second = await impl
      .as(APPLICANT)
      .saveDraft(APPLICANT.principalId, { ...VALUES, team: "Lead" });
    expect(second).toMatchObject({ stage: "not-started", version: 0, draftVersion: 2 });
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eirs")).toEqual([{ n: 0 }]);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_actions")).toEqual([{ n: 0 }]);
    expect(
      impl.warehouse.query(
        "SELECT action, record_version, actor_app FROM eir__eir_draft_saves ORDER BY record_version",
      ),
    ).toEqual([
      { action: "saved", record_version: 1, actor_app: "tenant" },
      { action: "saved", record_version: 2, actor_app: "tenant" },
    ]);
    const after = await submitted(impl);
    expect(after.draftValues).toBeUndefined();
    expect(impl.warehouse.query("SELECT form_values, version FROM eir__eir_drafts")).toEqual([
      { form_values: null, version: 4 },
    ]);
  });
});

describe("EIR on Delta: the current form (2.0, #217) in the submit command", () => {
  it("refuses blocking answers inside the command, so a direct API call can't skip the pre-check", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    const blockingValues = { ...VALUES, workEmail: "", declarationAgreed: "" };
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, blockingValues);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {
          volumePath: path,
          formVersion: "bootstrap-2",
          values: blockingValues,
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "evaluation-blocking",
      },
    });
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eirs")).toEqual([{ n: 0 }]);
  });

  it("refuses answers sent for another form version", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    const body = submitBody(path);
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", {
        ...body,
        payload: { ...body.payload, formVersion: "1.1" },
      }),
    );
    expect(response.status).toBe(400);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_submissions")).toEqual([
      { n: 0 },
    ]);
  });

  it("stores the form version and start on the submission, and the record's Record ID", async () => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    impl.clock.advance(86_400_000);
    await submitted(impl);
    expect(
      impl.warehouse.query(
        "SELECT form_version, form_started_at, submitted_at FROM eir__eir_submissions",
      ),
    ).toEqual([
      {
        form_version: "bootstrap-2",
        form_started_at: "2026-10-01T12:00:00.000Z",
        submitted_at: "2026-10-02T12:00:00.000Z",
      },
    ]);
    expect(impl.warehouse.query("SELECT display_code, display_number FROM eir__eirs")).toEqual([
      { display_code: "EIR-00000A", display_number: null },
    ]);
    // A display code, not a counter number (ADR-0007 decision 2, amended 2026-10-10).
    expect(
      impl.warehouse.query("SELECT next_number FROM admin__display_counters WHERE prefix = 'EIR'"),
    ).toEqual([{ next_number: 1001 }]);
  });

  it("starts a record as the person: not started, a Record ID and a started action", async () => {
    const impl = deltaImplementation();
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/start", { idempotencyKey: KEY, expectedVersion: 0, payload: {} }),
    );
    expect(response.status).toBe(200);
    expect(
      impl.warehouse.query("SELECT stage, version, display_code, person_display FROM eir__eirs"),
    ).toEqual([
      {
        stage: "not-started",
        version: 1,
        display_code: "EIR-00000A",
        person_display: "Test Person",
      },
    ]);
    expect(
      impl.warehouse.query("SELECT action, from_stage, to_stage, actor_app FROM eir__eir_actions"),
    ).toEqual([
      { action: "started", from_stage: null, to_stage: "not-started", actor_app: "tenant" },
    ]);
    // The next step builds on it: the first submission is version 2.
    const record = await submitted(impl);
    expect(record).toMatchObject({ stage: "submitted", recordId: "EIR-00000A", version: 2 });
    const again = await impl.request(
      APPLICANT,
      post("/api/commands/eir/start", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 2,
        payload: {},
      }),
    );
    expect(again.status).toBe(409);
  });
});

describe("EIR on Delta: who may do what", () => {
  it("refuses a validator their own EIR, in the plan and before writing anything", async () => {
    const impl = deltaImplementation();
    await submitted(impl, VAL);
    const before = impl.warehouse.statements.length;
    const response = await impl.request(
      VAL,
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: VAL.principalId, decision: "valid" },
      }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("own-eir");
    const blocks = impl.warehouse.statements
      .slice(before)
      .filter((s) => s.startsWith("BEGIN ATOMIC"));
    expect(blocks).toHaveLength(0);
    // A second validator decides it.
    const decided = await impl
      .as(VIC)
      .decide(VAL.principalId, "valid", VIC.principalId, undefined, VIC.displayName);
    expect(decided.stage).toBe("valid");
  });

  it.each([
    ["a person", APPLICANT],
    ["EDP staff who aren't validators", STAFF],
  ])("refuses %s every validator command and read, before any SQL", async (_label, user) => {
    const impl = deltaImplementation();
    const requests = [
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: OTHER_PERSON.principalId, decision: "valid" },
      }),
      get("/api/reads/eir/inbox"),
      get(`/api/reads/eir/record?principalId=${OTHER_PERSON.principalId}`),
    ];
    for (const request of requests) {
      const response = await impl.request(user, request);
      expect(response.status, request.url).toBe(403);
    }
    expect(impl.warehouse.statements).toHaveLength(0);
  });

  it("only ever reads the session's own EIR on the tenant read, and takes nobody's ID from the query", async () => {
    const impl = deltaImplementation();
    await submitted(impl, OTHER_PERSON);
    const mine = await impl.request(APPLICANT, get("/api/reads/eir/mine"));
    expect(await mine.json()).toMatchObject({
      principalId: APPLICANT.principalId,
      stage: "not-started",
    });
    const smuggled = await impl.request(
      APPLICANT,
      get(`/api/reads/eir/mine?principalId=${OTHER_PERSON.principalId}`),
    );
    expect(smuggled.status).toBe(400);
  });

  it("never gives a validator the person's draft, on the record or the inbox; the person still gets it", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    await commandRecord(impl, APPLICANT, "/api/commands/eir/save-draft", {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion: 2,
      payload: { formVersion: "bootstrap-2", values: { ...VALUES, team: "Renewal correction" } },
    });
    const draftFields = ["draftValues", "draftFormVersion", "draftStartedAt", "draftVersion"];

    const mine = (await (
      await impl.request(APPLICANT, get("/api/reads/eir/mine"))
    ).json()) as EirRecord;
    expect(mine).toMatchObject({
      draftValues: { team: "Renewal correction" },
      draftFormVersion: "bootstrap-2",
      draftVersion: 3,
    });
    expect(mine.draftStartedAt).toEqual(expect.any(String));

    const record = await impl.request(
      VAL,
      get(`/api/reads/eir/record?principalId=${APPLICANT.principalId}`),
    );
    expect(record.status).toBe(200);
    const seen = (await record.json()) as Record<string, unknown>;
    expect(seen).toMatchObject({ principalId: APPLICANT.principalId, stage: "valid" });
    for (const field of draftFields) expect(seen, field).not.toHaveProperty(field);

    const inbox = (await (await impl.request(VAL, get("/api/reads/eir/inbox"))).json()) as Record<
      string,
      unknown
    >[];
    expect(inbox).toHaveLength(1);
    for (const field of draftFields) expect(inbox[0], field).not.toHaveProperty(field);
    expect(JSON.stringify([seen, inbox])).not.toContain("Renewal correction");

    const decided = await commandRecord(impl, VAL, "/api/commands/eir/decide", {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion: 2,
      payload: { principalId: APPLICANT.principalId, decision: "revoked", note: "Left" },
    });
    expect(decided.stage).toBe("revoked");
    for (const field of draftFields) expect(decided, field).not.toHaveProperty(field);
    expect(await impl.as(APPLICANT).get(APPLICANT.principalId)).toMatchObject({
      draftValues: { team: "Renewal correction" },
    });
  });

  it("keeps a validator's own draft on their own record and their own (test mode) decision", async () => {
    const impl = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(impl, VAL);
    await impl
      .as(VAL)
      .decide(VAL.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    await commandRecord(impl, VAL, "/api/commands/eir/save-draft", {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion: 2,
      payload: { formVersion: "bootstrap-2", values: { ...VALUES, team: "My correction" } },
    });
    const own = { draftValues: { team: "My correction" }, draftVersion: 3 };

    const record = await impl.request(
      VAL,
      get(`/api/reads/eir/record?principalId=${VAL.principalId}`),
    );
    expect(await record.json()).toMatchObject(own);
    const decided = await commandRecord(impl, VAL, "/api/commands/eir/decide", {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion: 2,
      payload: { principalId: VAL.principalId, decision: "revoked", note: "Left" },
    });
    expect(decided).toMatchObject({ stage: "revoked", ...own });
  });

  it("records the signed-in validator as the decider, whoever the payload is about", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    const response = await impl.request(
      VIC,
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: APPLICANT.principalId, decision: "valid" },
      }),
    );
    expect(response.status).toBe(200);
    expect(
      impl.warehouse.query(
        "SELECT actor_principal_id, actor_display, actor_app FROM eir__eir_actions WHERE action = 'validated'",
      ),
    ).toEqual([
      { actor_principal_id: VIC.principalId, actor_display: VIC.displayName, actor_app: "staff" },
    ]);
  });

  it("shows expiry on read without storing it", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    impl.clock.advance(366 * 86_400_000);
    expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).stage).toBe("expired");
    expect(impl.warehouse.query("SELECT stage, version FROM eir__eirs")).toEqual([
      { stage: "valid", version: 2 },
    ]);
  });

  it("takes the actor from the session and refuses a payload naming one", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path, 0, { actorPrincipalId: VAL.principalId })),
    );
    expect(response.status).toBe(400);
    const sha = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path, 0, { sha256: "0".repeat(64) })),
    );
    expect(sha.status).toBe(400);
  });
});

describe("EIR on Delta: the signed PDF", () => {
  it("refuses a PDF in someone else's folder of the volume", async () => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    const path = await upload(impl, OTHER_PERSON, 1);
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path)),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "not-your-file",
    );
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eirs")).toEqual([{ n: 0 }]);
  });

  it("refuses a path outside the EIR volume, a missing upload, and a file that isn't a PDF", async () => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    const outside =
      "/Volumes/other/docs/eir/1001/1791000000001-00000000-0000-4000-9000-000000000001.pdf";
    expect(
      (await impl.request(APPLICANT, post("/api/commands/eir/submit", submitBody(outside)))).status,
    ).toBe(403);
    const missing = eirVolumePath(
      VOLUME,
      APPLICANT.principalId,
      "1791000000002-00000000-0000-4000-9000-000000000002",
    );
    expect(
      (await impl.request(APPLICANT, post("/api/commands/eir/submit", submitBody(missing)))).status,
    ).toBe(409);
    const text = await upload(impl, APPLICANT, 3);
    impl.files.set(text, new TextEncoder().encode("not a pdf"));
    expect(
      (await impl.request(APPLICANT, post("/api/commands/eir/submit", submitBody(text)))).status,
    ).toBe(415);
  });

  const FILE = "1791000000001-00000000-0000-4000-9000-000000000001.pdf";
  const DIR = "/Volumes/edp/docs/eir";
  it.each([
    // #98's path matrix, now against the eir/submit command.
    ["dot-dot", `${DIR}/1001/../1002/${FILE}`],
    ["encoded dot-dot", `${DIR}/1001/%2e%2e/${FILE}`],
    ["the old record file", `${DIR}/1001/record/v1.json`],
    ["a query string", `${DIR}/1001/${FILE}?x=1`],
    ["backslash traversal in the owner", `${DIR}/1001\\..\\1002/${FILE}`],
    ["backslash in the file name", `${DIR}/1001/..\\${FILE}`],
    ["one-dot leaders (U+2024) as the owner", `${DIR}/\u2024\u2024/${FILE}`],
    ["fullwidth full stops (U+FF0E) as the owner", `${DIR}/\uFF0E\uFF0E/${FILE}`],
    ["a fullwidth full stop before pdf", `${DIR}/1001/${FILE.replace(".pdf", "\uFF0Epdf")}`],
    ["small full stops (U+FE52) as the owner", `${DIR}/\uFE52\uFE52/${FILE}`],
    ["a trailing slash", `${DIR}/1001/${FILE}/`],
    ["a null byte in the file name", `${DIR}/1001/${FILE}\u0000.pdf`],
    ["a null byte in the owner", `${DIR}/1001\u0000/${FILE}`],
  ])("refuses %s with no EIR SQL and no volume read or write", async (_label, path) => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    impl.warehouse.statements.length = 0;
    impl.files.set(path, new TextEncoder().encode("%PDF-1.7 x"));
    const before = [...impl.files.keys()];
    const reads = vi.spyOn(impl.files, "get");
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path)),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "not-your-file",
    );
    // The runner checks the key, current draft and evaluation before rejecting the path.
    expect(impl.warehouse.statements).toHaveLength(3);
    expect(impl.warehouse.statements[0]).toContain("WHERE idempotency_key = :key");
    expect(reads).not.toHaveBeenCalled();
    expect([...impl.files.keys()]).toEqual(before);
  });

  it("refuses a PDF over the configured size limit, read from the volume", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    impl.files.set(path, new Uint8Array(10 * 1024 * 1024 + 1).fill(0x25));
    impl.files.get(path)!.set(new TextEncoder().encode("%PDF-"));
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(path)),
    );
    expect(response.status).toBe(413);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eirs")).toEqual([{ n: 0 }]);
  });

  it("never records one PDF as two submissions", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "questions", VAL.principalId, "Why?", VAL.displayName);
    const [first] = impl.warehouse.query<{ volume_path: string }>(
      "SELECT volume_path FROM eir__eir_submissions",
    );
    const response = await impl.request(
      APPLICANT,
      post("/api/commands/eir/submit", submitBody(first!.volume_path, 2, { response: "Because" })),
    );
    expect(response.status).toBe(409);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_submissions")).toEqual([
      { n: 1 },
    ]);
  });
});

describe("EIR on Delta: concurrency and retries through the runner", () => {
  it("lets one of two validators deciding at once win; the other is told to reload", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    const release = impl.warehouse.hold();
    const racing = [VAL, VIC].map((validator) =>
      impl.request(
        validator,
        post("/api/commands/eir/decide", {
          idempotencyKey: globalThis.crypto.randomUUID(),
          expectedVersion: 1,
          payload: {
            principalId: APPLICANT.principalId,
            decision: validator === VAL ? "valid" : "rejected",
            note: "No",
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const statuses = (await Promise.all(racing)).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(impl.warehouse.conflicts).toBeGreaterThanOrEqual(1);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_actions")).toEqual([{ n: 2 }]);
    expect(impl.warehouse.query("SELECT version FROM eir__eirs")).toEqual([{ version: 2 }]);
  });

  it("lets a draft save and a decision on the same EIR both land (the draft retries, never conflicts)", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    const release = impl.warehouse.hold();
    const decision = impl.request(
      VAL,
      post("/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 2,
        payload: { principalId: APPLICANT.principalId, decision: "revoked", note: "Left" },
      }),
    );
    const draft = impl.request(
      APPLICANT,
      post("/api/commands/eir/save-draft", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 2,
        payload: { formVersion: "bootstrap-2", values: { ...VALUES, team: "Lead" } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await Promise.all([decision, draft])).map((r) => r.status)).toEqual([200, 200]);
    const record = await impl.as(APPLICANT).get(APPLICANT.principalId);
    expect(record).toMatchObject({ stage: "revoked", draftValues: { team: "Lead" } });
  });

  it("gives one person's two first submissions at once one EIR: the other tab is told to reload", async () => {
    const impl = deltaImplementation();
    const paths = [
      await upload(impl, APPLICANT, 1, "one"),
      await upload(impl, APPLICANT, 2, "two"),
    ];
    const release = impl.warehouse.hold();
    const racing = paths.map((path) =>
      impl.request(APPLICANT, post("/api/commands/eir/submit", submitBody(path))),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await Promise.all(racing)).map((r) => r.status).sort()).toEqual([200, 409]);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eirs")).toEqual([{ n: 1 }]);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_submissions")).toEqual([
      { n: 1 },
    ]);
  });

  it("replays a resent key with the original answer and writes nothing twice", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    const body = submitBody(path);
    const first = await (
      await impl.request(APPLICANT, post("/api/commands/eir/submit", body))
    ).json();
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    const again = await (
      await impl.request(APPLICANT, post("/api/commands/eir/submit", body))
    ).json();
    expect(again).toMatchObject({ replayed: true, result: (first as { result: unknown }).result });
    expect((again as { result: { stage: string } }).result.stage).toBe("submitted");
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_submissions")).toEqual([
      { n: 1 },
    ]);
  });

  it("replays an old stored EIR result shape by falling back to one fresh read", async () => {
    const impl = deltaImplementation();
    const path = await upload(impl, APPLICANT, 1);
    const body = submitBody(path);
    const first = await impl.request(APPLICANT, post("/api/commands/eir/submit", body));
    expect(first.status).toBe(200);
    const eirId = await eirIdFor(APPLICANT.principalId);
    impl.warehouse.query(
      "UPDATE eir__eir_actions SET result = :result WHERE idempotency_key = :key",
      {
        key: body.idempotencyKey,
        result: JSON.stringify({ id: eirId, eir_id: eirId, stage: "submitted", version: 1 }),
      },
    );
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);

    const replay = await impl.request(APPLICANT, post("/api/commands/eir/submit", body));
    expect(replay.status).toBe(200);
    const payload = (await replay.json()) as { replayed: boolean; result: EirRecord };
    expect(payload.replayed).toBe(true);
    expect(payload.result).toEqual(await impl.as(APPLICANT).get(APPLICANT.principalId));
    expect(payload.result).toMatchObject({
      principalId: APPLICANT.principalId,
      stage: "valid",
      version: 2,
    });
  });

  it("returns the same EIR record as a fresh read for every command, including an expired sent-back renewal", async () => {
    const clock = createClock();
    const impl = deltaImplementation(clock);
    const expectFresh = async (
      target: DeltaImplementation,
      label: string,
      result: EirRecord,
      reader: SessionUser,
      principalId: string,
    ) => {
      expect(result, label).toEqual(await target.as(reader).get(principalId));
      return result;
    };

    const started = await expectFresh(
      impl,
      "start",
      await commandRecord(impl, APPLICANT, "/api/commands/eir/start", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 0,
        payload: {},
      }),
      APPLICANT,
      APPLICANT.principalId,
    );
    const drafted = await expectFresh(
      impl,
      "save-draft",
      await commandRecord(impl, APPLICANT, "/api/commands/eir/save-draft", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: started.draftVersion ?? 0,
        payload: { formVersion: "bootstrap-2", values: VALUES },
      }),
      APPLICANT,
      APPLICANT.principalId,
    );
    const submittedRecord = await expectFresh(
      impl,
      "submit",
      await commandRecord(
        impl,
        APPLICANT,
        "/api/commands/eir/submit",
        submitBody(await upload(impl, APPLICANT, 1), drafted.version),
      ),
      APPLICANT,
      APPLICANT.principalId,
    );
    const sentBack = await expectFresh(
      impl,
      "decide questions",
      await commandRecord(impl, VAL, "/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: submittedRecord.version,
        payload: { principalId: APPLICANT.principalId, decision: "questions", note: "Clarify" },
      }),
      VAL,
      APPLICANT.principalId,
    );
    const answered = await expectFresh(
      impl,
      "respond",
      await commandRecord(impl, APPLICANT, "/api/commands/eir/respond", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: sentBack.version,
        payload: { values: VALUES, response: "Clarified" },
      }),
      APPLICANT,
      APPLICANT.principalId,
    );
    const valid = await expectFresh(
      impl,
      "decide valid",
      await commandRecord(impl, VAL, "/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: answered.version,
        payload: { principalId: APPLICANT.principalId, decision: "valid" },
      }),
      VAL,
      APPLICANT.principalId,
    );
    clock.advance(350 * DAY);
    // A renewal a year on: its training is renewed too, so every rule is met (#217).
    const renewalValues = {
      ...VALUES,
      team: "Renewal Team",
      unauthorizedAccessTrainingDate: "2027-06-01",
      privacyTrainingDate: "2027-06-02",
      cyberAwarenessTrainingDate: "2027-06-03",
    };
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, renewalValues);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    const renewing = await expectFresh(
      impl,
      "renewal submit",
      await commandRecord(
        impl,
        APPLICANT,
        "/api/commands/eir/submit",
        submitBody(await upload(impl, APPLICANT, 2), valid.version, {
          values: renewalValues,
        }),
      ),
      APPLICANT,
      APPLICANT.principalId,
    );
    clock.advance(20 * DAY);
    const expiredQuestions = await expectFresh(
      impl,
      "expired renewal questions",
      await commandRecord(impl, VAL, "/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: renewing.version,
        payload: {
          principalId: APPLICANT.principalId,
          decision: "questions",
          note: "Renewal needs clarification",
        },
      }),
      VAL,
      APPLICANT.principalId,
    );
    expect(expiredQuestions.stage).toBe("expired");
    expect(expiredQuestions.renewal).toMatchObject({ stage: "questions" });
    const renewalAnswered = await expectFresh(
      impl,
      "renewal respond",
      await commandRecord(impl, APPLICANT, "/api/commands/eir/respond", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: expiredQuestions.version,
        payload: {
          values: renewalValues,
          response: "Renewal clarified",
        },
      }),
      APPLICANT,
      APPLICANT.principalId,
    );
    await expectFresh(
      impl,
      "renewal valid",
      await commandRecord(impl, VAL, "/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: renewalAnswered.version,
        payload: { principalId: APPLICANT.principalId, decision: "valid" },
      }),
      VAL,
      APPLICANT.principalId,
    );

    // Fresh stores on a fresh clock: the fixture's training is in date there (#217).
    const rejected = deltaImplementation(createClock());
    await submitted(rejected);
    await expectFresh(
      rejected,
      "decide rejected",
      await commandRecord(rejected, VAL, "/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 1,
        payload: { principalId: APPLICANT.principalId, decision: "rejected", note: "No" },
      }),
      VAL,
      APPLICANT.principalId,
    );

    const revoked = deltaImplementation(createClock());
    await submitted(revoked);
    await revoked
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    const revokedResult = await commandRecord(revoked, VIC, "/api/commands/eir/decide", {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion: 2,
      payload: {
        principalId: APPLICANT.principalId,
        decision: "revoked",
        note: "No longer needs it",
      },
    });
    expect(revokedResult).toEqual(await revoked.as(VIC).get(APPLICANT.principalId));

    const selfDecision = deltaImplementation(createClock(), { selfDecisionTestMode: true });
    await submitted(selfDecision, VAL);
    const selfResult = await commandRecord(selfDecision, VAL, "/api/commands/eir/decide", {
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion: 1,
      payload: { principalId: VAL.principalId, decision: "valid" },
    });
    expect(selfResult).toEqual(await selfDecision.as(VAL).get(VAL.principalId));
    expect(selfResult.actions.at(-1)).toMatchObject({ selfDecisionTestMode: true });
  });

  it("refuses a stale version with the reload message", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "questions", VAL.principalId, "Why?", VAL.displayName);
    const response = await impl.request(
      VIC,
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: APPLICANT.principalId, decision: "valid" },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "version-conflict",
        message: "This changed since you opened it. Reload to see the latest.",
      },
    });
  });

  it("resends the same key when the client retries after a lost answer", async () => {
    const impl = deltaImplementation();
    const repository = impl.as(APPLICANT);
    await repository.saveDraft(APPLICANT.principalId, VALUES);
    await repository.evaluateDraft(APPLICANT.principalId);
    const sent: string[] = [];
    const original = impl.request;
    let failOnce = true;
    impl.request = async (user, request) => {
      if (request.url.includes("/api/commands/")) {
        const body = (await request.clone().json()) as { idempotencyKey: string };
        sent.push(body.idempotencyKey);
        const response = await original(user, request);
        if (failOnce) {
          failOnce = false;
          throw new TypeError("Failed to fetch");
        }
        return response;
      }
      return original(user, request);
    };
    const file = pdf();
    const input = {
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file,
      values: VALUES,
    };
    await expect(repository.submitWithFile(input)).rejects.toThrow("Failed to fetch");
    const record = await repository.submitWithFile(input);
    expect(record.stage).toBe("submitted");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(impl.warehouse.query("SELECT count(*) AS n FROM eir__eir_submissions")).toEqual([
      { n: 1 },
    ]);
    expect(impl.files.size).toBe(1);
  });
});

describe("EIR on Delta: a PR preview's self-decision test mode (2026-10-07)", () => {
  const ownDecide = (
    impl: DeltaImplementation,
    decision: string,
    expectedVersion: number,
    note?: string,
  ) =>
    impl.request(
      VAL,
      post("/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion,
        payload: { principalId: VAL.principalId, decision, ...(note ? { note } : {}) },
      }),
    );

  it.each([
    ["the flag unset", undefined],
    ["the flag false", "false"],
    ["the flag in capitals", "TRUE"],
    ["the flag as yes", "yes"],
    ["the flag as 1", "1"],
  ])(
    "refuses a validator their own EIR with %s, through the app's own check",
    async (_label, flag) => {
      if (flag !== undefined) vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", flag);
      try {
        const impl = deltaImplementation();
        await submitted(impl, VAL);
        const response = await ownDecide(impl, "valid", 1);
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("own-eir");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("refuses it with the flag exactly true but a production store (no prefix)", async () => {
    vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", "true");
    try {
      // The harness's store has no prefix, as production's doesn't.
      const impl = deltaImplementation();
      expect(impl.deps.names.schemaPrefix).toBe("");
      await submitted(impl, VAL);
      const before = impl.warehouse.statements.length;
      const response = await ownDecide(impl, "valid", 1);
      expect(response.status).toBe(403);
      expect(
        impl.warehouse.statements.slice(before).filter((s) => s.startsWith("BEGIN ATOMIC")),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets the validator take every decision on their own EIR when it's on, each marked and by them", async () => {
    const impl = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(impl, VAL);
    expect((await ownDecide(impl, "questions", 1, "Clarify the team")).status).toBe(200);
    await impl.as(VAL).saveDraft(VAL.principalId, VALUES);
    await impl.as(VAL).evaluateDraft(VAL.principalId);
    await impl.as(VAL).submitWithFile({
      principalId: VAL.principalId,
      personName: VAL.displayName,
      file: pdf(),
      values: VALUES,
      response: "Team clarified",
      expectedVersion: 2,
    });
    expect((await ownDecide(impl, "valid", 3)).status).toBe(200);
    expect((await ownDecide(impl, "revoked", 4, "Testing revocation")).status).toBe(200);

    const rejecting = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(rejecting, VAL);
    expect((await ownDecide(rejecting, "rejected", 1, "Testing rejection")).status).toBe(200);

    type Row = {
      action: string;
      actor_principal_id: string;
      actor_app: string;
      note: string | null;
      payload: string | null;
    };
    const rows = [
      ...impl.warehouse.query<Row>("SELECT * FROM eir__eir_actions ORDER BY record_version"),
      ...rejecting.warehouse.query<Row>("SELECT * FROM eir__eir_actions ORDER BY record_version"),
    ];
    // Marked by the structured payload only; each note is as the validator wrote it.
    const SELF = '{"selfDecisionTestMode":true}';
    expect(
      rows.map((r) => [r.action, r.actor_principal_id, r.actor_app, r.note, r.payload]),
    ).toEqual([
      ["submitted", VAL.principalId, "tenant", null, null],
      ["sent-back", VAL.principalId, "staff", "Clarify the team", SELF],
      ["resubmitted", VAL.principalId, "tenant", "Team clarified", null],
      ["validated", VAL.principalId, "staff", null, SELF],
      ["revoked", VAL.principalId, "staff", "Testing revocation", SELF],
      ["submitted", VAL.principalId, "tenant", null, null],
      ["rejected", VAL.principalId, "staff", "Testing rejection", SELF],
    ]);
  });

  it("still needs a note where a decision needs one: the marker doesn't count as one", async () => {
    const impl = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(impl, VAL);
    const response = await ownDecide(impl, "rejected", 1);
    expect(response.status).toBe(400);
  });

  it("doesn't mark another validator's decision, even when it's on", async () => {
    const impl = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(impl, APPLICANT);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    const [, validated] = impl.warehouse.query<{ note: string | null }>(
      "SELECT note FROM eir__eir_actions ORDER BY record_version",
    );
    expect(validated!.note).toBeNull();
  });
});

describe("EIR on Delta: the self-decision marker can't be forged (round 8)", () => {
  const MARKER = "[Self-decision under preview test mode]";
  const decideAs = (
    impl: DeltaImplementation,
    who: SessionUser,
    principalId: string,
    decision: string,
    expectedVersion: number,
    note?: string,
  ) =>
    impl.request(
      who,
      post("/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion,
        payload: { principalId, decision, ...(note ? { note } : {}) },
      }),
    );
  const validThenRenewing = async (impl: DeltaImplementation) => {
    await submitted(impl);
    await impl
      .as(VIC)
      .decide(APPLICANT.principalId, "valid", VIC.principalId, undefined, VIC.displayName);
    await submitted(impl);
  };
  const cases: [string, (impl: DeltaImplementation) => Promise<unknown>, string, number][] = [
    ["send back", (impl) => submitted(impl), "questions", 1],
    ["reject", (impl) => submitted(impl), "rejected", 1],
    ["mark valid", (impl) => submitted(impl), "valid", 1],
    [
      "revoke",
      async (impl) => {
        await submitted(impl);
        await impl
          .as(VIC)
          .decide(APPLICANT.principalId, "valid", VIC.principalId, undefined, VIC.displayName);
      },
      "revoked",
      2,
    ],
    ["send back a renewal", validThenRenewing, "questions", 3],
    ["reject a renewal", validThenRenewing, "rejected", 3],
    ["approve a renewal", validThenRenewing, "valid", 3],
    ["revoke with a renewal waiting", validThenRenewing, "revoked", 3],
  ];

  for (const testMode of [false, true]) {
    it.each(cases)(
      `refuses a forged marker on someone else's EIR (${testMode ? "test mode on" : "default"}): %s`,
      async (_label, setup, decision, version) => {
        const impl = deltaImplementation(undefined, { selfDecisionTestMode: testMode });
        await setup(impl);
        const before = impl.warehouse.query("SELECT * FROM eir__eir_actions");
        for (const note of [`${MARKER} looks fine`, `  ${MARKER.toUpperCase()}`]) {
          const response = await decideAs(
            impl,
            VAL,
            APPLICANT.principalId,
            decision,
            version,
            note,
          );
          expect(response.status).toBe(400);
          expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
            /only the app marks a self-decision/,
          );
        }
        expect(impl.warehouse.query("SELECT * FROM eir__eir_actions")).toEqual(before);
      },
    );
  }

  it("stores the marker as the action's structured payload, and reads it back, only on a self-decision", async () => {
    const impl = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(impl, VAL);
    await submitted(impl, APPLICANT);
    expect((await decideAs(impl, VAL, VAL.principalId, "questions", 1, "Clarify")).status).toBe(
      200,
    );
    expect(
      (await decideAs(impl, VAL, APPLICANT.principalId, "questions", 1, "Clarify")).status,
    ).toBe(200);
    const rows = impl.warehouse.query<{
      actor_principal_id: string;
      action: string;
      note: string;
      payload: string | null;
      eir_id: string;
    }>("SELECT * FROM eir__eir_actions WHERE action = 'sent-back' ORDER BY eir_id");
    const ownId = await eirIdFor(VAL.principalId);
    const theirId = await eirIdFor(APPLICANT.principalId);
    const byOwner = (owner: string) =>
      rows.find((r) => r.eir_id === (owner === VAL.principalId ? ownId : theirId))!;
    expect(byOwner(VAL.principalId)).toMatchObject({
      payload: '{"selfDecisionTestMode":true}',
      note: "Clarify",
    });
    expect(byOwner(APPLICANT.principalId)).toMatchObject({ payload: null, note: "Clarify" });
    const own = await impl.as(VAL).get(VAL.principalId);
    expect(own.actions.at(-1)).toMatchObject({ kind: "questions", selfDecisionTestMode: true });
    const theirs = await impl.as(VAL).get(APPLICANT.principalId);
    expect(theirs.actions.at(-1)?.selfDecisionTestMode).toBeUndefined();
  });
});

describe("EIR on Delta: test mode through the app's own path (env flag + the store's prefix)", () => {
  const PREVIEW = "edp_vm_pr134_";
  const ownValid = (impl: DeltaImplementation) =>
    impl.request(
      VAL,
      post("/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 1,
        payload: { principalId: VAL.principalId, decision: "valid" },
      }),
    );

  it("allows a self-decision with EDP_EIR_ALLOW_SELF_VALIDATION=true on a preview-prefixed store", async () => {
    vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", "true");
    try {
      // No override: the area's default check reads the flag and ctx.names.schemaPrefix.
      const impl = deltaImplementation(undefined, { schemaPrefix: PREVIEW });
      expect(impl.deps.names.schemaPrefix).toBe(PREVIEW);
      await submitted(impl, VAL);
      // Every statement names the preview's schemas.
      expect(impl.warehouse.statements.some((s) => s.includes(`\`${PREVIEW}eir\``))).toBe(true);
      const response = await ownValid(impl);
      expect(response.status).toBe(200);
      const [validated] = impl.warehouse.query<{ payload: string; actor_principal_id: string }>(
        "SELECT * FROM eir__eir_actions WHERE action = 'validated'",
      );
      expect(validated).toMatchObject({
        payload: '{"selfDecisionTestMode":true}',
        actor_principal_id: VAL.principalId,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["the flag unset on a preview-prefixed store", undefined, PREVIEW],
    ["the flag false on a preview-prefixed store", "false", PREVIEW],
    ["the flag true on a non-preview prefix", "true", "edp_vm_preview_"],
  ])("refuses it with %s", async (_label, flag, prefix) => {
    if (flag !== undefined) vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", flag);
    try {
      const impl = deltaImplementation(undefined, { schemaPrefix: prefix });
      await submitted(impl, VAL);
      const response = await ownValid(impl);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("own-eir");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * `audit.eir_branch` as `resources/store-eir.sql` defines it, for this store:
 * the view's SELECT, built from the DDL's own string and run over the fake.
 */
function eirAuditBranch(impl: DeltaImplementation) {
  const ddl = readFileSync(join(process.cwd(), "resources/store-eir.sql"), "utf8");
  const statement = ddl.slice(ddl.indexOf("EXECUTE IMMEDIATE\n  'CREATE OR REPLACE VIEW"));
  const body = statement.slice("EXECUTE IMMEDIATE".length, statement.indexOf(";\n"));
  const sql = body
    .split("||")
    .map((part) => part.trim())
    .map((part) => {
      if (part.startsWith("replace(:catalog_name")) return "edp_vending";
      if (part.startsWith("replace(:schema_prefix")) return "";
      const literal = /^'((?:\\.|[^'\\])*)'$/.exec(part);
      if (!literal) throw new Error(`Unexpected view part: ${part}`);
      return literal[1]!.replace(/\\(.)/g, "$1");
    })
    .join("");
  const select = sql.slice(sql.indexOf(" AS SELECT ") + " AS ".length);
  return impl.warehouse.query<{
    action: string;
    note: string | null;
    self_decision_test_mode: number | boolean;
  }>(`${translate(select)} ORDER BY record_version`);
}

describe("EIR on Delta: Send response (round 9)", () => {
  const respond = (
    impl: DeltaImplementation,
    who: SessionUser,
    expectedVersion: number,
    payload: Record<string, unknown>,
  ) =>
    impl.request(
      who,
      post("/api/commands/eir/respond", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion,
        payload,
      }),
    );
  const sentBack = async (impl: DeltaImplementation) => {
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(
        APPLICANT.principalId,
        "questions",
        VAL.principalId,
        "Clarify the team",
        VAL.displayName,
      );
  };

  it("resubmits with the same answers and the signed PDF: no new PDF, back to the validator", async () => {
    const clock = createClock();
    const impl = deltaImplementation(clock);
    await sentBack(impl);
    const [signed] = impl.warehouse.query<{ id: string; volume_path: string }>(
      "SELECT id, volume_path FROM eir__eir_submissions",
    );
    clock.advance(2 * DAY);
    const response = await respond(impl, APPLICANT, 2, {
      values: VALUES,
      response: "  Team confirmed.  ",
    });
    expect(response.status).toBe(200);

    // No new submission: the signed one goes back to review.
    const submissions = impl.warehouse.query<{ id: string; stage: string; volume_path: string }>(
      "SELECT id, stage, volume_path FROM eir__eir_submissions",
    );
    expect(submissions).toEqual([
      { id: signed!.id, stage: "submitted", volume_path: signed!.volume_path },
    ]);
    const [last] = impl.warehouse.query<{
      action: string;
      note: string;
      eir_submission_id: string;
      actor_principal_id: string;
      actor_app: string;
      payload: string | null;
    }>("SELECT * FROM eir__eir_actions ORDER BY record_version DESC LIMIT 1");
    expect(last).toMatchObject({
      action: "resubmitted",
      note: "Team confirmed.",
      eir_submission_id: signed!.id,
      actor_principal_id: APPLICANT.principalId,
      actor_app: "tenant",
      payload: null,
    });
    const [eir] = impl.warehouse.query<{
      stage: string;
      open_submission_id: string;
      sla_due_at: string;
    }>("SELECT stage, open_submission_id, sla_due_at FROM eir__eirs");
    expect(eir).toMatchObject({ stage: "submitted", open_submission_id: signed!.id });

    const record = await impl.as(APPLICANT).get(APPLICANT.principalId);
    expect(record).toMatchObject({ stage: "submitted", response: "Team confirmed.", version: 3 });
    expect(record.questions).toBeUndefined();
    // The validator sees it again, with the SLA counted from the response.
    const [item] = await impl.as(VAL).listValidatorInbox();
    expect(item).toMatchObject({ principalId: APPLICANT.principalId, stage: "submitted" });
    expect(Date.parse(item!.sla.dueAt)).toBeGreaterThan(
      Date.parse(record.submissions[0]!.submittedAt) + 2 * DAY,
    );
    expect(item!.actions.slice(-2)).toEqual([
      expect.objectContaining({ kind: "questions", note: "Clarify the team" }),
      expect.objectContaining({ kind: "submitted", response: "Team confirmed." }),
    ]);
  });

  it("answers renewal questions the same way, keeping the valid EIR valid", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    await impl
      .as(VIC)
      .decide(APPLICANT.principalId, "valid", VIC.principalId, undefined, VIC.displayName);
    await submitted(impl);
    await impl
      .as(VAL)
      .decide(
        APPLICANT.principalId,
        "questions",
        VAL.principalId,
        "Renewal: clarify",
        VAL.displayName,
      );
    const response = await respond(impl, APPLICANT, 4, { values: VALUES, response: "Clarified" });
    expect(response.status).toBe(200);
    const record = await impl.as(APPLICANT).get(APPLICANT.principalId);
    expect(record.stage).toBe("valid");
    expect(record.renewal).toMatchObject({ stage: "submitted", response: "Clarified" });
    expect(record.submissions).toHaveLength(2);
    const [last] = impl.warehouse.query<{ action: string; from_stage: string; to_stage: string }>(
      "SELECT action, from_stage, to_stage FROM eir__eir_actions ORDER BY record_version DESC LIMIT 1",
    );
    expect(last).toEqual({ action: "renewal-submitted", from_stage: "valid", to_stage: "valid" });
  });

  it.each([
    [
      "answers that differ from the signed submission",
      { values: { ...VALUES, team: "Other Team" }, response: "Done" },
      409,
      /You changed your answers/,
    ],
    ["a blank response", { values: VALUES, response: "   " }, 400, /An answer is required/],
    [
      "a form version from the client",
      { values: VALUES, response: "Done", formVersion: "bootstrap-2" },
      400,
      /./,
    ],
    [
      "an answer the form doesn't have",
      { values: { ...VALUES, liveDataWaiver: "yes" }, response: "Done" },
      400,
      /./,
    ],
  ] as [string, Record<string, unknown>, number, RegExp][])(
    "refuses Send response with %s, writing nothing",
    async (_label, payload, status, message) => {
      const impl = deltaImplementation();
      await sentBack(impl);
      const before = impl.warehouse.query("SELECT * FROM eir__eir_actions");
      const response = await respond(impl, APPLICANT, 2, payload);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
        message,
      );
      expect(impl.warehouse.query("SELECT * FROM eir__eir_actions")).toEqual(before);
      expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).stage).toBe("questions");
    },
  );

  it("refuses Send response when nothing was sent back", async () => {
    const impl = deltaImplementation();
    await submitted(impl);
    const response = await respond(impl, APPLICANT, 1, { values: VALUES, response: "Done" });
    expect(response.status).toBe(409);
  });

  it("only ever responds on the session's own EIR", async () => {
    const impl = deltaImplementation();
    await sentBack(impl);
    // OTHER_PERSON has no EIR; nobody's ID comes from the request.
    const response = await respond(impl, OTHER_PERSON, 2, { values: VALUES, response: "Done" });
    expect(response.status).toBe(404);
    expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).stage).toBe("questions");
  });
});

describe("EIR on Delta: no free text can look like the self-decision marker (round 9)", () => {
  const MARKER = "[Self-decision under preview test mode]";
  const forgeries = [
    `${MARKER} looks fine`,
    `  ${MARKER.toUpperCase()}`,
    `\u200B\u200D${MARKER}`,
    `\uFEFF ${MARKER}`,
    // Fullwidth brackets fold to ASCII under NFKC.
    `\uFF3BSelf-decision under preview test mode\uFF3D`,
  ];

  it.each([
    [
      "a first submission's response",
      async (impl: DeltaImplementation, text: string) =>
        impl.request(
          APPLICANT,
          post(
            "/api/commands/eir/submit",
            submitBody(await upload(impl, APPLICANT, 1), 0, { response: text }),
          ),
        ),
    ],
    [
      "a resubmission's response",
      async (impl: DeltaImplementation, text: string) => {
        await submitted(impl);
        await impl
          .as(VAL)
          .decide(APPLICANT.principalId, "questions", VAL.principalId, "Clarify", VAL.displayName);
        return impl.request(
          APPLICANT,
          post(
            "/api/commands/eir/submit",
            submitBody(await upload(impl, APPLICANT, 2), 2, { response: text }),
          ),
        );
      },
    ],
    [
      "a renewal's response",
      async (impl: DeltaImplementation, text: string) => {
        await submitted(impl);
        await impl
          .as(VAL)
          .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
        return impl.request(
          APPLICANT,
          post(
            "/api/commands/eir/submit",
            submitBody(await upload(impl, APPLICANT, 2), 2, { response: text }),
          ),
        );
      },
    ],
    [
      "a Send response",
      async (impl: DeltaImplementation, text: string) => {
        await submitted(impl);
        await impl
          .as(VAL)
          .decide(APPLICANT.principalId, "questions", VAL.principalId, "Clarify", VAL.displayName);
        return impl.request(
          APPLICANT,
          post("/api/commands/eir/respond", {
            idempotencyKey: globalThis.crypto.randomUUID(),
            expectedVersion: 2,
            payload: { values: VALUES, response: text },
          }),
        );
      },
    ],
    [
      "a decision note",
      async (impl: DeltaImplementation, text: string) => {
        await submitted(impl);
        return impl.request(
          VAL,
          post("/api/commands/eir/decide", {
            idempotencyKey: globalThis.crypto.randomUUID(),
            expectedVersion: 1,
            payload: { principalId: APPLICANT.principalId, decision: "questions", note: text },
          }),
        );
      },
    ],
  ] as [string, (impl: DeltaImplementation, text: string) => Promise<Response>][])(
    "refuses it in %s (400), writing nothing",
    async (_label, send) => {
      for (const text of forgeries) {
        const impl = deltaImplementation();
        const response = await send(impl, text);
        expect(response.status, text).toBe(400);
        expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
          /only the app marks a self-decision/,
        );
        const notes = impl.warehouse.query<{ note: string | null }>(
          "SELECT note FROM eir__eir_actions",
        );
        expect(notes.some((row) => row.note?.includes("preview test mode"))).toBe(false);
      }
    },
  );

  it("marks only real self-decisions in the audit view, from the payload, never from the note", async () => {
    const impl = deltaImplementation(undefined, { selfDecisionTestMode: true });
    await submitted(impl, VAL);
    await impl.request(
      VAL,
      post("/api/commands/eir/decide", {
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion: 1,
        payload: { principalId: VAL.principalId, decision: "questions", note: "Clarify" },
      }),
    );
    await submitted(impl, APPLICANT);
    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "questions", VAL.principalId, "Clarify", VAL.displayName);
    // A row PR #134's rounds 7 and 8 left on a preview: the marker in the note, no payload.
    impl.warehouse.query(
      `INSERT INTO eir__eir_actions (action_id, eir_id, action, from_stage, to_stage, record_version, actor_principal_id, actor_display, actor_app, occurred_at, idempotency_key, note) SELECT 'legacy-row', eir_id, 'sent-back', 'submitted', 'questions', 99, actor_principal_id, actor_display, 'staff', occurred_at, 'legacy-key', '${MARKER} Old note' FROM eir__eir_actions LIMIT 1`,
    );
    const rows = eirAuditBranch(impl).map((r) => [
      r.action,
      r.note,
      Boolean(r.self_decision_test_mode),
    ]);
    expect(rows).toContainEqual(["sent-back", "Clarify", true]);
    expect(rows).toContainEqual(["sent-back", "Clarify", false]);
    expect(rows).toContainEqual(["sent-back", "Old note", false]);
    expect(rows.filter(([, , marked]) => marked)).toEqual([["sent-back", "Clarify", true]]);
    expect(rows.some(([, note]) => String(note).includes("preview test mode"))).toBe(false);
    // The person's own view drops the old prefix too.
    const own = await impl.as(VAL).get(VAL.principalId);
    expect(own.actions.find((a) => a.kind === "questions")).toMatchObject({
      note: "Clarify",
      selfDecisionTestMode: true,
    });
  });
});
