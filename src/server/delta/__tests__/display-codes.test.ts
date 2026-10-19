// @vitest-environment node
/**
 * Counter-free display codes (#177; ADR-0007 decision 2, amended 2026-10-10),
 * at the transaction runner's seam: real commands through the Delta API on
 * the SQLite fake warehouse built from the provisioning DDL.
 *
 * - An EIR or onboarding create takes a random code (`ONB-7K3QFD`) and never
 *   touches `admin.display_counters`.
 * - The block refuses a code its table already has; the runner retries the
 *   command with a fresh code.
 * - A replayed idempotency key returns the original code.
 * - Records numbered by the old counter (`ONB-1000`, `EIR-1042`) keep their
 *   labels and still resolve.
 * - Change-list entries stay sequential on the counter (teams-area.test.ts).
 * - A write check gets no display number.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { newDisplayCode } from "../../../data/display-codes.ts";
import type { OnboardingIntake, OnboardingRequest } from "../../../data/onboarding";
import { COMPLETE_INTAKE_ANSWERS } from "../../../data/onboarding/intake.fixtures";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import type { SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner, type AttemptInfo } from "../transaction.ts";
import { APPLICANT, deltaImplementation } from "./eir-harness.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const CODE = /^ONB-[0-9A-HJKMNP-TV-Z]{6}$/;
const names = createStoreNames("edp_vending", "");

const PROVIDER: SessionUser = {
  principalId: "scim-provider",
  displayName: "Pat Provider",
  email: "pat.provider@example.test",
  isAdmin: false,
  onboardingReviewerRoles: [],
};
const STAFF: SessionUser = { ...PROVIDER, principalId: "scim-staff", isAdmin: true };
const BUSINESS_OFFICE: SessionUser = {
  ...PROVIDER,
  principalId: "scim-bo",
  displayName: "Bea Office",
  email: "bea.office@example.test",
  onboardingReviewerRoles: ["business-office"],
};

const intake = (n: number): OnboardingIntake => ({
  initiativeName: `Initiative ${n}`,
  businessCase: "Prioritize balance-due cases across treatment streams.",
  annualBenefit: 1_000_000 + n,
  levers: ["taxgap"],
  datasets: [
    {
      name: `Dataset ${n}`,
      domain: "individual-filing",
      datasetTag: `dataset_${n}`,
      owners: [{ name: "Olive Owner", email: "olive.owner@example.test" }],
    },
  ],
  workspaceNeeds: { isolation: "shared", teamSize: 4 },
  answers: { ...COMPLETE_INTAKE_ANSWERS },
  initiativeOwner: { kind: "self" },
});

let warehouse: SqliteWarehouse;
let deps: DeltaApiDeps;
let attempts: AttemptInfo[];
/** The codes the runner hands out, in order; a fresh random one once these run out. */
let scripted: string[];
let signedIn: SessionUser;
let keys = 0;

beforeEach(() => {
  warehouse = createSqliteWarehouse({ files: ["store-admin.sql", "store-onboarding.sql"] });
  attempts = [];
  scripted = [];
  signedIn = PROVIDER;
  deps = {
    registry: createAppRegistry(),
    runner: createTransactionRunner({
      client: warehouse.client,
      names,
      sleep: async () => {},
      onAttempt: (info) => attempts.push(info),
      newDisplayCode: (prefix) => scripted.shift() ?? newDisplayCode(prefix),
    }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => signedIn,
    requirePrivacyAcknowledgment: async () => undefined,
  };
});

async function api<T>(user: SessionUser, method: "GET" | "POST", path: string, body?: unknown) {
  signedIn = user;
  const response = await handleDeltaApiRequest(
    new Request(`https://app.example/api/${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as T };
}

async function submit(
  n: number,
  key = `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`,
) {
  const res = await api<{ result: OnboardingRequest; replayed: boolean }>(
    PROVIDER,
    "POST",
    "commands/onboarding/submit",
    { idempotencyKey: key, expectedVersion: 0, payload: { intake: intake(n) } },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const readRequest = (id: string) =>
  api<OnboardingRequest | null>(PROVIDER, "GET", `reads/onboarding/request?id=${id}`);

describe("onboarding display codes", () => {
  it("a submit stores a random code, no number, and leaves the counter alone", async () => {
    const counter = warehouse.query(`SELECT * FROM admin__display_counters WHERE prefix = 'ONB'`);
    const { result } = await submit(1);

    expect(result.id).toMatch(CODE);
    expect(
      warehouse.query("SELECT display_code, display_number FROM onboarding__onboarding_requests"),
    ).toEqual([{ display_code: result.id, display_number: null }]);
    expect(warehouse.query(`SELECT * FROM admin__display_counters WHERE prefix = 'ONB'`)).toEqual(
      counter,
    );
    const block = warehouse.statements.find((s) => s.startsWith("BEGIN ATOMIC"))!;
    expect(block).not.toContain("display_counters");
    // The uniqueness read on the code column, inside the same block.
    expect(block).toMatch(
      /IF \(EXISTS \(SELECT 1 FROM `edp_vending`\.`onboarding`\.`onboarding_requests` WHERE display_code = :p\d+\)\) THEN\n  SIGNAL SQLSTATE 'ED004'/,
    );
    expect((await readRequest(result.id)).body).toMatchObject({ id: result.id });
  });

  it("a code that's taken is refused in the block, and the command retries with a fresh one", async () => {
    scripted = ["ONB-7K3QFD"];
    const first = await submit(1);
    expect(first.result.id).toBe("ONB-7K3QFD");

    scripted = ["ONB-7K3QFD", "ONB-9X2MRT"];
    attempts = [];
    const second = await submit(2);
    expect(second.result.id).toBe("ONB-9X2MRT");
    expect(attempts.map((a) => a.outcome)).toEqual(["retry", "committed"]);
    expect(
      warehouse.query(
        "SELECT display_code FROM onboarding__onboarding_requests ORDER BY display_code",
      ),
    ).toEqual([{ display_code: "ONB-7K3QFD" }, { display_code: "ONB-9X2MRT" }]);
    // The refused attempt left nothing behind.
    expect(
      warehouse.query("SELECT count(*) AS n FROM onboarding__onboarding_request_actions"),
    ).toEqual([{ n: 4 }]);
  });

  it("a replay of the key returns the original code, not a new one", async () => {
    const key = "00000000-0000-4000-8000-00000000abcd";
    const first = await submit(1, key);
    scripted = ["ONB-ZZZZZZ"];
    const replay = await submit(1, key);
    expect(replay.replayed).toBe(true);
    expect(replay.result.id).toBe(first.result.id);
    expect(warehouse.query("SELECT count(*) AS n FROM onboarding__onboarding_requests")).toEqual([
      { n: 1 },
    ]);
  });

  it("a tag-fix resubmit keeps the same display code and reserved child IDs", async () => {
    scripted = ["ONB-7K3QFD"];
    const { result: created } = await submit(1);
    const before = {
      request: warehouse.query(
        "SELECT id, display_code, display_number FROM onboarding__onboarding_requests",
      ),
      datasets: warehouse.query(
        "SELECT id, onboarding_request_id FROM onboarding__onboarding_intake_datasets ORDER BY position",
      ),
      owners: warehouse.query(
        "SELECT id, intake_dataset_id, onboarding_request_id FROM onboarding__onboarding_intake_owners ORDER BY position",
      ),
    };

    const sendBack = await api<{ result: OnboardingRequest }>(
      BUSINESS_OFFICE,
      "POST",
      "commands/onboarding/decide",
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000000bc",
        expectedVersion: created.version,
        payload: {
          requestId: created.id,
          decision: { type: "send-back", to: "submitted", note: "Fix the dataset tag." },
        },
      },
    );
    expect(sendBack.status, JSON.stringify(sendBack.body)).toBe(200);

    const resubmit = await api<{ result: OnboardingRequest }>(
      PROVIDER,
      "POST",
      "commands/onboarding/resubmit",
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000000bd",
        expectedVersion: sendBack.body.result.version,
        payload: {
          requestId: created.id,
          resubmission: {
            answer: "Updated the dataset tag.",
            intake: {
              ...created.intake,
              datasets: [{ ...created.intake.datasets[0]!, datasetTag: "dataset_1_fixed" }],
            },
          },
        },
      },
    );

    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    expect(resubmit.body.result).toMatchObject({
      id: created.id,
      stage: "business-roi-review",
      intake: { datasets: [{ datasetTag: "dataset_1_fixed" }] },
    });
    expect(resubmit.body.result.decisions.at(-1)).toMatchObject({
      kind: "resubmit",
      note: "Updated the dataset tag. Dataset tag changed: dataset_1 -> dataset_1_fixed.",
    });
    expect(
      warehouse.query(
        "SELECT id, display_code, display_number FROM onboarding__onboarding_requests",
      ),
    ).toEqual(before.request);
    expect(
      warehouse.query(
        "SELECT id, onboarding_request_id FROM onboarding__onboarding_intake_datasets ORDER BY position",
      ),
    ).toEqual(before.datasets);
    expect(
      warehouse.query(
        "SELECT id, intake_dataset_id, onboarding_request_id FROM onboarding__onboarding_intake_owners ORDER BY position",
      ),
    ).toEqual(before.owners);
    expect((await readRequest(created.id)).body).toMatchObject({
      id: created.id,
      intake: { datasets: [{ datasetTag: "dataset_1_fixed" }] },
    });
  });

  it("a request numbered by the old counter keeps its label and still resolves, beside a coded one", async () => {
    const { result } = await submit(1);
    // Rewrite the stored row into the old shape: a number and no code.
    warehouse.query(
      "UPDATE onboarding__onboarding_requests SET display_code = NULL, display_number = 1000",
    );
    const legacy = (await readRequest("ONB-1000")).body;
    expect(legacy).toMatchObject({ id: "ONB-1000", title: result.title });
    expect((await readRequest(result.id)).body).toBeNull();

    const coded = await submit(2);
    expect((await readRequest(coded.result.id)).body).toMatchObject({ id: coded.result.id });
    // A person typing it in lower case finds it too.
    expect((await readRequest(coded.result.id.toLowerCase())).body).toMatchObject({
      id: coded.result.id,
    });
    const mine = (await api<OnboardingRequest[]>(PROVIDER, "GET", "reads/onboarding/mine")).body;
    expect(mine.map((r) => r.id).sort()).toEqual(["ONB-1000", coded.result.id].sort());
  });

  it("an action on a legacy-numbered request still finds it", async () => {
    await submit(1);
    warehouse.query(
      "UPDATE onboarding__onboarding_requests SET display_code = NULL, display_number = 1000",
    );
    const res = await api<{ result: OnboardingRequest }>(
      PROVIDER,
      "POST",
      "commands/onboarding/withdraw",
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000000ff",
        expectedVersion: 2,
        payload: { requestId: "ONB-1000" },
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({ id: "ONB-1000", stage: "withdrawn" });
  });
});

describe("write checks", () => {
  it("get no display number and touch no counter", async () => {
    const res = await api<{ result: Record<string, unknown> }>(
      STAFF,
      "POST",
      "commands/admin/record-write-check",
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000000aa",
        expectedVersion: 0,
        payload: { name: "smoke" },
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({ name: "smoke", stage: "recorded" });
    expect(res.body.result).not.toHaveProperty("label");
    expect(res.body.result).not.toHaveProperty("displayNumber");
    expect(warehouse.query("SELECT display_number FROM admin__write_checks")).toEqual([
      { display_number: null },
    ]);
    const block = warehouse.statements.find((s) => s.startsWith("BEGIN ATOMIC"))!;
    expect(block).not.toContain("display_counters");
  });
});

describe("EIR display codes", () => {
  const EIR_CODE = /^EIR-[0-9A-HJKMNP-TV-Z]{6}$/;

  it("starting a record gives it a code, with no counter update, and the record shows it", async () => {
    const impl = deltaImplementation();
    const before = impl.warehouse.query(
      "SELECT next_number FROM admin__display_counters WHERE prefix = 'EIR'",
    );
    const started = await impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName);
    expect(started.recordId).toMatch(EIR_CODE);
    expect(impl.warehouse.query("SELECT display_code, display_number FROM eir__eirs")).toEqual([
      { display_code: started.recordId, display_number: null },
    ]);
    expect(
      impl.warehouse.query("SELECT next_number FROM admin__display_counters WHERE prefix = 'EIR'"),
    ).toEqual(before);
    expect(impl.warehouse.statements.join("\n")).not.toContain("display_counters");
  });

  it("an EIR numbered by the old counter keeps its Record ID", async () => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName);
    impl.warehouse.query("UPDATE eir__eirs SET display_code = NULL, display_number = 1042");
    expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).recordId).toBe("EIR-1042");
  });
});
