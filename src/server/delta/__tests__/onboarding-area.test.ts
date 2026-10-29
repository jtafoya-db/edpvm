import { afterEach, describe, expect, it } from "vitest";

import type { OnboardingIntake } from "../../../data/onboarding";
import { COMPLETE_INTAKE_ANSWERS } from "../../../data/onboarding/intake.fixtures";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import type { SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { BAD_TAGS, GOOD_TAGS } from "../../../schema/dataset-tag.fixtures";
import { createTransactionRunner } from "../transaction.ts";
import { DEFAULT_EFFECTIVE_SLA_CONFIG, setConfiguredSlaConfigForTests } from "../../sla-config.ts";
import {
  committed,
  deltaConflict,
  fakeSqlClient,
  insertedValue,
  type RecordedStatement,
} from "./fake-sql-client.ts";
import {
  GOVCLOUD_CASES,
  govCloudSessionUser,
  leaksIdentifier,
} from "../../__tests__/govcloud-identity.ts";

const PROVIDER: SessionUser = {
  principalId: "scim-provider",
  displayName: "Pat Provider",
  email: "pat@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: [],
};

const INTAKE: OnboardingIntake = {
  initiativeName: "Collections case signals",
  businessCase: "Prioritize balance-due cases across treatment streams.",
  annualBenefit: 1_250_000,
  levers: ["taxgap"],
  datasets: [
    {
      name: "Case signals",
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      ingestionMethod: "eftu",
      ingestionDetails: "Nightly secure transfer.",
      datasetTag: "case_signals",
      owners: [{ name: "Olive Owner", email: "Olive.Owner@example.gov" }],
    },
  ],
  workspaceNeeds: { isolation: "shared", teamSize: 6 },
  answers: { dataName: "Collections case signals", ...COMPLETE_INTAKE_ANSWERS },
  initiativeOwner: { kind: "self" },
};

/** INTAKE as the stored request reads back: its dataset and owner under their record IDs. */
const STORED_INTAKE: OnboardingIntake = {
  ...INTAKE,
  datasets: [
    {
      ...INTAKE.datasets[0]!,
      id: "ds-1",
      owners: [{ id: "ow-1", name: "Olive Owner", email: "olive.owner@example.gov" }],
    },
  ],
};

const RESULT_ROW = {
  uuid: "11111111-1111-4111-8111-111111111111",
  id: "ONB-1001",
  display_number: 1001,
  version: 2,
  title: "Collections case signals",
  provider_principal_id: "scim-provider",
  provider_display: "Pat Provider",
  submitted_at: "2026-09-28T09:00:00.000Z",
  stage: "business-roi-review",
  stage_entered_at: "2026-09-28T09:00:00.000Z",
  initiative_name: "Collections case signals",
  business_case: "Prioritize balance-due cases across treatment streams.",
  annual_benefit: 1250000,
  levers: ["taxgap"],
  workspace_isolation: "shared",
  workspace_team_size: 6,
  intake_answers: JSON.stringify(INTAKE.answers),
  open_send_back_from_stage: null,
  open_send_back_action_id: null,
  initiative_owner_kind: "self",
  initiative_owner_display: "Pat Provider",
  initiative_owner_email: "pat@example.gov",
  initiative_owner_principal_id: "scim-provider",
};

const BUSINESS_OFFICE: SessionUser = {
  principalId: "scim-bo",
  displayName: "Bea Office",
  email: "bea@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: ["business-office"],
};

const UUID = "11111111-1111-4111-8111-111111111111";

/** The intake children as the request and action tables hold them. */
const DATASET_ROWS = [
  {
    id: "ds-1",
    onboarding_request_id: UUID,
    position: 0,
    name: "Case signals",
    source_system: "IMF / Individual Master File",
    domain: "individual-filing",
    ingestion_method: "eftu",
    ingestion_details: "Nightly secure transfer.",
    dataset_tag: "case_signals",
  },
];
const OWNER_ROWS = [
  {
    id: "ow-1",
    intake_dataset_id: "ds-1",
    onboarding_request_id: UUID,
    position: 0,
    person_display: "Olive Owner",
    person_email: "olive.owner@example.gov",
    person_principal_id: null,
  },
];
const ACTION_ROWS = [
  {
    action_id: "act-sub",
    action: "submitted",
    from_stage: null,
    to_stage: "submitted",
    record_version: 1,
    actor_principal_id: "scim-provider",
    actor_display: "Pat Provider",
    occurred_at: "2026-09-28T09:00:00.000Z",
    note: null,
  },
  {
    action_id: "act-fwd",
    action: "forwarded",
    from_stage: "submitted",
    to_stage: "business-roi-review",
    record_version: 2,
    actor_principal_id: "system",
    actor_display: "EDP Vending Machine",
    occurred_at: "2026-09-28T09:00:00.000Z",
    note: null,
  },
];

/**
 * The warehouse's answer to the set-based request read: the request row with
 * each child table aggregated in as `to_json(collect_list(...))` text.
 */
function readRows(
  rows: Record<string, unknown>[],
  children: { datasets?: unknown[]; owners?: unknown[]; actions?: unknown[] } = {},
) {
  return {
    rows: rows.map((row) => ({
      ...row,
      datasets_json: JSON.stringify(children.datasets ?? DATASET_ROWS),
      owners_json: JSON.stringify(children.owners ?? OWNER_ROWS),
      actions_json: JSON.stringify(children.actions ?? ACTION_ROWS),
    })),
  };
}

/** True for the set-based request read (one statement for a row and its children). */
const isRequestRead = (statement: string) => statement.includes("r.display_number = :display");

/** The complete result row the submit block hydrates (request columns plus children). */
const RESULT_ROW_FULL = {
  ...RESULT_ROW,
  datasets: DATASET_ROWS.map(
    ({
      id,
      position,
      name,
      source_system,
      domain,
      ingestion_method,
      ingestion_details,
      dataset_tag,
    }) => ({
      id,
      position,
      name,
      source_system,
      domain,
      ingestion_method,
      ingestion_details,
      dataset_tag,
    }),
  ),
  owners: OWNER_ROWS.map(({ id, intake_dataset_id, position, person_display, person_email }) => ({
    id,
    intake_dataset_id,
    position,
    person_display,
    person_email,
  })),
  actions: ACTION_ROWS,
};

const post = (body: unknown) =>
  new Request("https://app.example/api/commands/onboarding/submit", {
    method: "POST",
    body: JSON.stringify(body),
  });

const command = (name: string, body: unknown) =>
  new Request(`https://app.example/api/commands/onboarding/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const readRequest = (id: string) =>
  new Request(`https://app.example/api/reads/onboarding/request?id=${id}`, { method: "GET" });

const SUBMIT_BODY = {
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
  expectedVersion: 0,
  payload: { intake: INTAKE },
};

/** Resolve one `:pN` marker in a block to its bound value (unwrapping typed binds). */
function resolveMarker(block: RecordedStatement, marker: string | undefined): unknown {
  if (!marker?.startsWith(":")) return marker;
  const value = block.parameters[marker.slice(1)];
  return value !== null && typeof value === "object" && "value" in value
    ? (value as { value: unknown }).value
    : value;
}

/** Resolve the `:pN` markers in a block INSERT value list to their bound values. */
function insertedIds(block: RecordedStatement, table: string): string[] {
  return block.statement
    .split("\n")
    .filter((line) => line.startsWith("INSERT INTO") && line.includes(`\`${table}\``))
    .map((line) => {
      const match = /\(([^)]*)\) VALUES \((.*)\);$/.exec(line);
      return String(resolveMarker(block, match?.[2]?.split(/, (?![^(]*\))/)[0]?.trim()));
    });
}

/** Each row a block INSERTs into `table`, as a resolved column → value map. */
function parseInserts(block: RecordedStatement, table: string): Record<string, unknown>[] {
  return block.statement
    .split("\n")
    .filter((line) => line.startsWith("INSERT INTO") && line.includes(`\`${table}\``))
    .map((line) => {
      const match = /\(([^)]*)\) VALUES \((.*)\);$/.exec(line)!;
      const columns = match[1]!.split(", ").map((c) => c.replace(/`/g, ""));
      const values = match[2]!.split(/, (?![^(]*\))/);
      return Object.fromEntries(
        columns.map((column, i) => [column, resolveMarker(block, values[i]?.trim())]),
      );
    });
}

/** The bound ids an UPDATE on `table` targets through `WHERE `id` = :pN`. */
function updatedIds(block: RecordedStatement, table: string): string[] {
  return block.statement
    .split("\n")
    .filter((line) => line.startsWith("UPDATE") && line.includes(`\`${table}\``))
    .map((line) => String(resolveMarker(block, /WHERE `id` = (:p\d+)/.exec(line)?.[1])));
}

function deps(
  responder: (call: RecordedStatement, index: number) => unknown,
  user: SessionUser = PROVIDER,
): DeltaApiDeps {
  const fake = fakeSqlClient((call, index) => responder(call, index) as any);
  const names = createStoreNames("edp_vending");
  return {
    registry: createAppRegistry(),
    runner: createTransactionRunner({
      client: fake.client,
      names,
      newId: () => "00000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      sleep: async () => undefined,
      random: () => 0,
    }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => user,
    requirePrivacyAcknowledgment: async () => undefined,
  };
}

describe("Delta onboarding area", () => {
  it("rejects a missing sensitivity through the real Delta API handler", async () => {
    const { sensitivity: _sensitivity, ...answers } = INTAKE.answers;
    let wrote = false;
    const d = deps((call) => {
      if (call.statement.startsWith("BEGIN ATOMIC")) wrote = true;
      return { rows: [] };
    });
    const response = await handleDeltaApiRequest(
      post({
        ...SUBMIT_BODY,
        payload: { intake: { ...INTAKE, answers } },
      }),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/sensitivity.*required/i);
    expect(wrote).toBe(false);
  });

  it("requires an ingestion method key for every dataset", async () => {
    const { ingestionMethod: _ingestionMethod, ...withoutMethod } = INTAKE.datasets[0]!;
    let wrote = false;
    const d = deps((call) => {
      if (call.statement.startsWith("BEGIN ATOMIC")) wrote = true;
      return { rows: [] };
    });
    const response = await handleDeltaApiRequest(
      post({
        ...SUBMIT_BODY,
        payload: { intake: { ...INTAKE, datasets: [withoutMethod] } },
      }),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-request");
    expect(wrote).toBe(false);
  });

  it.each(["sourceSystem", "domain"] as const)(
    "rejects a dataset with no %s through the real Delta API handler",
    async (field) => {
      const dataset = { ...INTAKE.datasets[0] };
      delete dataset[field];
      let wrote = false;
      const d = deps((call) => {
        if (call.statement.startsWith("BEGIN ATOMIC")) wrote = true;
        return { rows: [] };
      });
      const response = await handleDeltaApiRequest(
        post({
          ...SUBMIT_BODY,
          payload: { intake: { ...INTAKE, datasets: [dataset] } },
        }),
        d,
      );
      expect(response.status).toBe(400);
      expect(wrote).toBe(false);
    },
  );

  it.each([
    ["ingestionMethod", "not-a-real-ingestion-method"],
    ["domain", "not-a-real-domain"],
  ] as const)(
    "rejects an unknown dataset %s through the real Delta API handler",
    async (field, value) => {
      let wrote = false;
      const d = deps((call) => {
        if (call.statement.startsWith("BEGIN ATOMIC")) wrote = true;
        return { rows: [] };
      });
      const response = await handleDeltaApiRequest(
        post({
          ...SUBMIT_BODY,
          payload: {
            intake: {
              ...INTAKE,
              datasets: [{ ...INTAKE.datasets[0]!, [field]: value }],
            },
          },
        }),
        d,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(new RegExp(`unknown.*${field}`, "i"));
      expect(wrote).toBe(false);
    },
  );

  it.each([0, -5])(
    "rejects annual benefit %s through the real Delta API handler",
    async (annualBenefit) => {
      let wrote = false;
      const d = deps((call) => {
        if (call.statement.startsWith("BEGIN ATOMIC")) wrote = true;
        return { rows: [] };
      });
      const response = await handleDeltaApiRequest(
        post({
          ...SUBMIT_BODY,
          payload: { intake: { ...INTAKE, annualBenefit } },
        }),
        d,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(/annual benefit.*more than 0/i);
      expect(wrote).toBe(false);
    },
  );

  it("submits an onboarding request in one atomic runner command with reserved child IDs", async () => {
    const seen: RecordedStatement[] = [];
    const d = deps((call) => {
      seen.push(call);
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) return committed(call, RESULT_ROW);
      return { rows: [] };
    });

    const response = await handleDeltaApiRequest(
      post({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
        expectedVersion: 0,
        payload: { intake: INTAKE },
      }),
      d,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({
      id: "ONB-1001",
      version: 2,
      stage: "business-roi-review",
      providerId: "scim-provider",
    });
    const block = seen.find((call) => call.statement.startsWith("BEGIN ATOMIC"))!;
    expect(block.statement).toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_requests`",
    );
    expect(block.statement).toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_intake_datasets`",
    );
    expect(block.statement).toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_intake_owners`",
    );
    expect(block.statement).toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_request_actions`",
    );
    expect(Object.values(block.parameters)).toContain("olive.owner@example.gov");
    expect(Object.values(block.parameters)).toContain("eftu");
    expect(Object.values(block.parameters)).toContain("Nightly secure transfer.");
    expect(block.statement).not.toContain("Olive.Owner@example.gov");
  });

  it("retries the whole onboarding command when Delta reports a conflict", async () => {
    let blocks = 0;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        blocks += 1;
        if (blocks === 1) throw deltaConflict();
        return committed(call, RESULT_ROW);
      }
      return { rows: [] };
    });

    const response = await handleDeltaApiRequest(
      post({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
        expectedVersion: 0,
        payload: { intake: INTAKE },
      }),
      d,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).attempts).toBe(2);
    expect(blocks).toBe(2);
  });
});

describe("Delta onboarding command responses are complete", () => {
  it("returns the full intake and decision history, matching the request read", async () => {
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) return committed(call, RESULT_ROW_FULL);
      // The request read: one statement, the row with its children aggregated in.
      if (isRequestRead(call.statement)) return readRows([RESULT_ROW]);
      return { rows: [] };
    });

    const commandResult = (await (await handleDeltaApiRequest(post(SUBMIT_BODY), d)).json()).result;
    const readResult = await (await handleDeltaApiRequest(readRequest("ONB-1001"), d)).json();

    // A mutation returns the same complete request a read hydrates — not empty
    // children — with every dataset and owner under its record ID (#222).
    expect(commandResult.intake.datasets).toEqual([
      {
        id: "ds-1",
        name: "Case signals",
        sourceSystem: "IMF / Individual Master File",
        domain: "individual-filing",
        ingestionMethod: "eftu",
        ingestionDetails: "Nightly secure transfer.",
        datasetTag: "case_signals",
        owners: [{ id: "ow-1", name: "Olive Owner", email: "olive.owner@example.gov" }],
      },
    ]);
    expect(commandResult.decisions.map((d: { kind: string }) => d.kind)).toEqual([
      "submit",
      "forward",
    ]);
    expect(commandResult.intake).toEqual(readResult.intake);
    expect(commandResult.decisions).toEqual(readResult.decisions);
    expect(commandResult.openSendBack).toEqual(readResult.openSendBack);
  });

  it("builds the result row by aggregating children and unioning in the lead action", async () => {
    let resultDeclare = "";
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        resultDeclare = call.statement;
        return committed(call, RESULT_ROW_FULL);
      }
      return { rows: [] };
    });

    await handleDeltaApiRequest(post(SUBMIT_BODY), d);

    // The response row carries the children (so a replay returns them too) and the
    // lead action, which is not yet in the action table when the row is read.
    expect(resultDeclare).toContain("collect_list(named_struct(");
    expect(resultDeclare).toContain("UNION ALL");
    expect(resultDeclare).toContain("`onboarding_intake_datasets`");
    expect(resultDeclare).toContain("`onboarding_intake_owners`");
    expect(resultDeclare).toContain("`onboarding_request_actions`");
  });

  it("refuses loudly when the history holds an action the view does not model", async () => {
    const d = deps((call) => {
      // A future `activated` action (standup, #89) the request view has no kind for.
      if (isRequestRead(call.statement))
        return readRows([RESULT_ROW], {
          actions: [{ ...ACTION_ROWS[0], action: "activated", record_version: 3 }],
        });
      return { rows: [] };
    });

    const response = await handleDeltaApiRequest(readRequest("ONB-1001"), d);
    // It fails rather than silently coercing the unknown action to a resubmit.
    expect(response.status).toBe(500);
  });
});

describe("Delta onboarding reserved IDs", () => {
  it("allocates globally-unique ordinals so owners never collide across datasets", async () => {
    // Two datasets; the first names more than 20 owners — the old
    // 100 + datasetIndex*20 + ownerIndex scheme collided here.
    const manyOwners = Array.from({ length: 25 }, (_, i) => ({
      name: `Owner ${i}`,
      email: `owner${i}@example.gov`,
    }));
    const intake: OnboardingIntake = {
      ...INTAKE,
      datasets: [
        {
          name: "A",
          sourceSystem: "IMF / Individual Master File",
          domain: "individual-filing",
          ingestionMethod: "eftu",
          datasetTag: "alpha_set",
          owners: manyOwners,
        },
        {
          name: "B",
          sourceSystem: "BMF / Business Master File",
          domain: "individual-filing",
          ingestionMethod: "informatica",
          datasetTag: "beta_set",
          owners: [{ name: "Solo", email: "solo@example.gov" }],
        },
      ],
    };
    let block: RecordedStatement | undefined;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        block = call;
        return committed(call, RESULT_ROW_FULL);
      }
      return { rows: [] };
    });

    const response = await handleDeltaApiRequest(post({ ...SUBMIT_BODY, payload: { intake } }), d);
    expect(response.status).toBe(200);

    const datasetIds = insertedIds(block!, "onboarding_intake_datasets");
    const ownerIds = insertedIds(block!, "onboarding_intake_owners");
    const all = [...datasetIds, ...ownerIds];
    expect(datasetIds).toHaveLength(2);
    expect(ownerIds).toHaveLength(26);
    expect(new Set(all).size).toBe(all.length); // every reserved ID is unique
  });

  it("keeps the reserved initiative, dataset and owner IDs identical across a resubmission", async () => {
    // A stateful fake of the store: submit populates the reserved rows; later
    // reads serve them back, and any block's INSERTs are applied, so a
    // resubmission that re-reserved IDs would change what reads return.
    const store: {
      request: Record<string, unknown> | null;
      initiativeId: string;
      datasets: Record<string, unknown>[];
      owners: Record<string, unknown>[];
    } = { request: null, initiativeId: "", datasets: [], owners: [] };

    const apply = (block: RecordedStatement) => {
      const req = parseInserts(block, "onboarding_requests")[0];
      if (req) {
        store.initiativeId = String(req["initiative_id"]);
        store.request = {
          ...RESULT_ROW,
          uuid: String(req["id"]),
          stage: "business-roi-review",
          version: 2,
        };
      }
      store.datasets.push(
        ...parseInserts(block, "onboarding_intake_datasets").map((r) => ({
          id: r["id"],
          onboarding_request_id: r["onboarding_request_id"],
          position: r["position"],
          name: r["name"],
          domain: r["domain"],
          dataset_tag: r["dataset_tag"],
        })),
      );
      store.owners.push(
        ...parseInserts(block, "onboarding_intake_owners").map((r) => ({
          id: r["id"],
          intake_dataset_id: r["intake_dataset_id"],
          onboarding_request_id: r["onboarding_request_id"],
          position: r["position"],
          person_display: r["person_display"],
          person_email: r["person_email"],
          person_principal_id: null,
        })),
      );
    };

    const responder = (call: RecordedStatement) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        apply(call);
        return committed(call, RESULT_ROW_FULL);
      }
      if (call.statement.includes("WHERE display_number = :display"))
        return { rows: store.request ? [store.request] : [] };
      if (call.statement.includes("`onboarding_intake_datasets`")) return { rows: store.datasets };
      if (call.statement.includes("`onboarding_intake_owners`")) return { rows: store.owners };
      return { rows: [] };
    };
    const d = deps(responder);

    // Submit reserves the IDs.
    await handleDeltaApiRequest(post(SUBMIT_BODY), d);
    const initiativeIdBefore = store.initiativeId;
    const datasetIdsBefore = store.datasets.map((x) => x["id"]);
    const ownerIdsBefore = store.owners.map((x) => x["id"]);
    expect(initiativeIdBefore).toBeTruthy();
    expect(datasetIdsBefore).toHaveLength(1);
    expect(ownerIdsBefore).toHaveLength(1);

    // Move the request into the send-back state the provider resubmits from.
    store.request = {
      ...store.request,
      stage: "submitted",
      open_send_back_action_id: "act-sb",
      open_send_back_from_stage: "ccb",
    };

    await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "99999999-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", resubmission: { answer: "Clarified." } },
      }),
      d,
    );

    // After the resubmission the reserved IDs are byte-for-byte identical: the
    // initiative, every dataset and every owner ID is unchanged.
    expect(store.initiativeId).toBe(initiativeIdBefore);
    expect(store.datasets.map((x) => x["id"])).toEqual(datasetIdsBefore);
    expect(store.owners.map((x) => x["id"])).toEqual(ownerIdsBefore);
  });
});

describe("Delta onboarding lifecycle at the public seam", () => {
  const currentAt = (
    stage: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    ...RESULT_ROW,
    uuid: UUID,
    stage,
    version: 2,
    provider_principal_id: "scim-provider",
    open_send_back_from_stage: null,
    open_send_back_action_id: null,
    ...extra,
  });

  function decideDeps(current: Record<string, unknown>, user: SessionUser) {
    let block: RecordedStatement | undefined;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      // The block references the child tables in its result row, so match it before them.
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        block = call;
        return committed(call, RESULT_ROW_FULL);
      }
      if (call.statement.includes("WHERE display_number = :display")) return { rows: [current] };
      if (call.statement.includes("`onboarding_intake_datasets`")) return { rows: DATASET_ROWS };
      if (call.statement.includes("`onboarding_intake_owners`")) return { rows: OWNER_ROWS };
      return { rows: [] };
    }, user);
    return { d, block: () => block };
  }

  it("records a business-office approval, moving the request to the CCB", async () => {
    const { d } = decideDeps(currentAt("business-roi-review"), BUSINESS_OFFICE);
    const response = await handleDeltaApiRequest(
      command("decide", {
        idempotencyKey: "22222222-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", decision: { type: "approve", note: "Strong ROI" } },
      }),
      d,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).recordVersion).toBe(3);
  });

  it("records a send-back with its questions and leaves the request with the provider", async () => {
    const { d, block } = decideDeps(currentAt("business-roi-review"), BUSINESS_OFFICE);
    const response = await handleDeltaApiRequest(
      command("decide", {
        idempotencyKey: "33333333-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: {
          requestId: "ONB-1001",
          decision: { type: "send-back", to: "submitted", note: "Clarify the workspace." },
        },
      }),
      d,
    );
    expect(response.status).toBe(200);
    // The send-back stores the question note and opens the send-back on the request row.
    expect(Object.values(block()!.parameters)).toContain("Clarify the workspace.");
    expect(block()!.statement).toContain("`open_send_back_action_id`");
  });

  it("refuses a send-back without questions", async () => {
    const { d } = decideDeps(currentAt("business-roi-review"), BUSINESS_OFFICE);
    const response = await handleDeltaApiRequest(
      command("decide", {
        idempotencyKey: "44444444-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: {
          requestId: "ONB-1001",
          decision: { type: "send-back", to: "submitted", note: "   " },
        },
      }),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/send-back needs questions/i);
  });

  it("resubmits a request waiting on the provider without re-creating its intake records", async () => {
    const { d, block } = decideDeps(
      currentAt("submitted", {
        open_send_back_action_id: "act-sb",
        open_send_back_from_stage: "ccb",
      }),
      PROVIDER,
    );
    const response = await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "55555555-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", resubmission: { answer: "Clarified." } },
      }),
      d,
    );
    expect(response.status).toBe(200);
    // A resubmission only updates the request row; the reserved dataset and owner
    // IDs from submit are never rewritten, so they stay stable.
    expect(block()!.statement).not.toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_intake_datasets`",
    );
    expect(block()!.statement).not.toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_intake_owners`",
    );
    expect(block()!.statement).not.toContain("`initiative_id`");
  });

  it("updates dataset field values on resubmit while keeping reserved child IDs", async () => {
    const { d, block } = decideDeps(
      currentAt("submitted", {
        open_send_back_action_id: "act-sb",
        open_send_back_from_stage: "ccb",
      }),
      PROVIDER,
    );
    const response = await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "56565656-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: {
          requestId: "ONB-1001",
          resubmission: {
            answer: "Updated the dataset tag.",
            intake: {
              ...STORED_INTAKE,
              datasets: [
                {
                  id: "ds-1",
                  name: "Case signals gold",
                  sourceSystem: "IDRS case extract",
                  domain: "other",
                  ingestionMethod: "informatica",
                  ingestionDetails: "Daily managed transfer.",
                  datasetTag: "case_signals_gold",
                  owners: [{ id: "ow-1", name: "Olivia Owner", email: "Olivia.Owner@example.gov" }],
                },
              ],
            },
          },
        },
      }),
      d,
    );

    expect(response.status).toBe(200);
    expect(block()!.statement).not.toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_intake_datasets`",
    );
    expect(block()!.statement).not.toContain(
      "INSERT INTO `edp_vending`.`onboarding`.`onboarding_intake_owners`",
    );
    expect(block()!.statement).toContain(
      "UPDATE `edp_vending`.`onboarding`.`onboarding_intake_datasets`",
    );
    expect(block()!.statement).toContain(
      "UPDATE `edp_vending`.`onboarding`.`onboarding_intake_owners`",
    );
    expect(updatedIds(block()!, "onboarding_intake_datasets")).toEqual(["ds-1"]);
    expect(updatedIds(block()!, "onboarding_intake_owners")).toEqual(["ow-1"]);
    expect(Object.values(block()!.parameters)).toContain("Case signals gold");
    expect(Object.values(block()!.parameters)).toContain("IDRS case extract");
    expect(Object.values(block()!.parameters)).toContain("case_signals_gold");
    expect(Object.values(block()!.parameters)).toContain("informatica");
    expect(Object.values(block()!.parameters)).toContain("Daily managed transfer.");
    expect(Object.values(block()!.parameters)).toContain("Olivia Owner");
    expect(JSON.stringify(Object.values(block()!.parameters))).toContain("Dataset 1 source system");
    expect(Object.values(block()!.parameters)).toContain("olivia.owner@example.gov");
    expect(Object.values(block()!.parameters)).toContain(
      "Updated the dataset tag. Dataset tag changed: case_signals -> case_signals_gold.",
    );
  });

  /** Two stored datasets, the first with its owner; the provider resubmits `intake`. */
  async function resubmitTwo(intake: OnboardingIntake) {
    let block: RecordedStatement | undefined;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        block = call;
        return committed(call, RESULT_ROW_FULL);
      }
      if (call.statement.includes("WHERE display_number = :display"))
        return {
          rows: [
            {
              ...RESULT_ROW,
              stage: "submitted",
              open_send_back_action_id: "act-sb",
              open_send_back_from_stage: "ccb",
            },
          ],
        };
      if (call.statement.includes("`onboarding_intake_datasets`"))
        return { rows: TWO_DATASET_ROWS };
      if (call.statement.includes("`onboarding_intake_owners`")) return { rows: TWO_OWNER_ROWS };
      return { rows: [] };
    }, PROVIDER);
    const response = await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "56565656-3333-4333-8444-555555555555",
        expectedVersion: 2,
        payload: {
          requestId: "ONB-1001",
          resubmission: { answer: "Reworked the datasets.", intake },
        },
      }),
      d,
    );
    return { response, block };
  }

  const TWO_DATASET_ROWS = [
    DATASET_ROWS[0]!,
    {
      ...DATASET_ROWS[0]!,
      id: "ds-2",
      position: 1,
      name: "Case indicators",
      dataset_tag: "case_indicators",
    },
  ];
  const TWO_OWNER_ROWS = [
    OWNER_ROWS[0]!,
    {
      ...OWNER_ROWS[0]!,
      id: "ow-2",
      intake_dataset_id: "ds-2",
      person_display: "Oscar Owner",
      person_email: "oscar.owner@example.gov",
    },
  ];

  /** The bound ids a DELETE on `table` removes. */
  function deletedIds(block: RecordedStatement, table: string): string[] {
    return block.statement
      .split("\n")
      .filter((line) => line.startsWith("DELETE FROM") && line.includes(`\`${table}\``))
      .map((line) => String(resolveMarker(block, /WHERE `id` = (:p\d+)/.exec(line)?.[1])));
  }

  function updatedDatasetValues(block: RecordedStatement) {
    return block.statement
      .split("\n")
      .filter((line) => line.startsWith("UPDATE") && line.includes("`onboarding_intake_datasets`"))
      .map((line) => ({
        id: String(resolveMarker(block, /WHERE `id` = (:p\d+)/.exec(line)?.[1])),
        position: Number(resolveMarker(block, /position = (:p\d+)/.exec(line)?.[1])),
        sourceSystem: String(resolveMarker(block, /source_system = (:p\d+)/.exec(line)?.[1])),
        domain: String(resolveMarker(block, /domain = (:p\d+)/.exec(line)?.[1])),
        ingestionMethod: String(resolveMarker(block, /ingestion_method = (:p\d+)/.exec(line)?.[1])),
      }));
  }

  it("keeps each dataset's ingestion method by stable ID when datasets are reordered", async () => {
    const first = STORED_INTAKE.datasets[0]!;
    const second = {
      ...first,
      id: "ds-2",
      name: "Case indicators",
      sourceSystem: "BMF / Business Master File",
      domain: "enforcement-collections",
      ingestionMethod: "informatica",
      ingestionDetails: "Managed daily transfer.",
      datasetTag: "case_indicators",
      owners: [{ id: "ow-2", name: "Oscar Owner", email: "oscar.owner@example.gov" }],
    };
    const { response, block } = await resubmitTwo({
      ...STORED_INTAKE,
      datasets: [second, first],
    });

    expect(response.status).toBe(200);
    expect(updatedDatasetValues(block!)).toEqual([
      {
        id: "ds-2",
        position: 0,
        sourceSystem: "BMF / Business Master File",
        domain: "enforcement-collections",
        ingestionMethod: "informatica",
      },
      {
        id: "ds-1",
        position: 1,
        sourceSystem: "IMF / Individual Master File",
        domain: "individual-filing",
        ingestionMethod: "eftu",
      },
    ]);
  });

  it("adds and removes datasets and owners on resubmit, keeping the IDs of the ones it keeps", async () => {
    const { response, block } = await resubmitTwo({
      ...STORED_INTAKE,
      datasets: [
        {
          ...STORED_INTAKE.datasets[0]!,
          owners: [
            STORED_INTAKE.datasets[0]!.owners[0]!,
            { name: "Nia New", email: "Nia.New@example.gov" },
          ],
        },
        {
          name: "Collections ledger",
          sourceSystem: "BMF / Business Master File",
          domain: "enforcement-collections",
          ingestionMethod: "eftu",
          datasetTag: "collections_ledger",
          owners: [{ name: "Lee Ledger", email: "lee.ledger@example.gov" }],
        },
      ],
    });

    expect(response.status).toBe(200);
    // Kept rows are updated in place under their stored IDs.
    expect(updatedIds(block!, "onboarding_intake_datasets")).toEqual(["ds-1"]);
    expect(updatedIds(block!, "onboarding_intake_owners")).toEqual(["ow-1"]);
    // New rows get follow-on IDs of this resubmission, never a stored or browser one.
    const [added] = parseInserts(block!, "onboarding_intake_datasets");
    expect(added).toMatchObject({ position: 1, name: "Collections ledger" });
    expect(["ds-1", "ds-2"]).not.toContain(added!["id"]);
    const owners = parseInserts(block!, "onboarding_intake_owners");
    expect(owners.map((o) => [o["intake_dataset_id"], o["person_email"]])).toEqual([
      ["ds-1", "nia.new@example.gov"],
      [added!["id"], "lee.ledger@example.gov"],
    ]);
    // The removed dataset and its owner are deleted, and the removal is in the log.
    expect(deletedIds(block!, "onboarding_intake_datasets")).toEqual(["ds-2"]);
    expect(deletedIds(block!, "onboarding_intake_owners")).toEqual(["ow-2"]);
    const [lead] = parseInserts(block!, "onboarding_request_actions");
    expect(lead!["note"]).toBe(
      "Reworked the datasets. Removed dataset: Case indicators (case_indicators).",
    );
    expect(JSON.parse(String(lead!["payload"])).changes).toContainEqual({
      field: "Dataset 2 removed",
      before: "Case indicators (case_indicators); owners: Oscar Owner (oscar.owner@example.gov)",
      after: "",
      kind: "removed",
    });
  });

  it.each([
    {
      label: "a dataset ID the request doesn't have",
      datasets: [{ ...STORED_INTAKE.datasets[0]!, id: "ds-elsewhere" }],
    },
    {
      label: "an owner ID from another dataset",
      datasets: [
        STORED_INTAKE.datasets[0]!,
        {
          ...STORED_INTAKE.datasets[0]!,
          id: "ds-2",
          datasetTag: "case_indicators",
          owners: [{ id: "ow-1", name: "Olive Owner", email: "olive.owner@example.gov" }],
        },
      ],
    },
  ])("refuses a resubmission naming $label before any write", async ({ datasets }) => {
    const { response, block } = await resubmitTwo({ ...STORED_INTAKE, datasets });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-intake");
    expect(block).toBeUndefined();
  });

  it("re-validates the whole intake on resubmit before any write", async () => {
    const { response, block } = await resubmitTwo({
      ...STORED_INTAKE,
      datasets: STORED_INTAKE.datasets.map((dataset, index) =>
        index === 0 ? { ...dataset, domain: "" } : dataset,
      ),
      answers: { ...STORED_INTAKE.answers, domain: "", engModel: "" },
    });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("invalid-intake");
    expect(error.message).toMatch(/delivery model is required.*Dataset 1.*domain/i);
    expect(block).toBeUndefined();
  });

  it("refuses a resubmitted dataset with an unknown ingestion method and domain before any write", async () => {
    const { response, block } = await resubmitTwo({
      ...STORED_INTAKE,
      datasets: STORED_INTAKE.datasets.map((dataset, index) =>
        index === 0 ? { ...dataset, ingestionMethod: "zzz", domain: "not-a-domain" } : dataset,
      ),
    });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("invalid-intake");
    expect(error.message).toMatch(/Dataset 1 has an unknown ingestionMethod: zzz/);
    expect(block).toBeUndefined();
  });

  it.each([
    ["ingestionMethod", "zzz"],
    ["domain", "not-a-domain"],
  ] as const)(
    "refuses a resubmitted dataset with only an unknown %s before any write",
    async (field, value) => {
      const { response, block } = await resubmitTwo({
        ...STORED_INTAKE,
        datasets: STORED_INTAKE.datasets.map((dataset, index) =>
          index === 0 ? { ...dataset, [field]: value } : dataset,
        ),
      });
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.code).toBe("invalid-intake");
      expect(error.message).toMatch(new RegExp(`Dataset 1 has an unknown ${field}: ${value}`));
      expect(block).toBeUndefined();
    },
  );

  it("accepts 'other' as a resubmitted dataset's domain and ingestion method", async () => {
    const { response, block } = await resubmitTwo({
      ...STORED_INTAKE,
      datasets: STORED_INTAKE.datasets.map((dataset, index) =>
        index === 0 ? { ...dataset, ingestionMethod: "other", domain: "other" } : dataset,
      ),
    });
    expect(response.status).toBe(200);
    expect(updatedDatasetValues(block!)[0]).toMatchObject({
      id: "ds-1",
      domain: "other",
      ingestionMethod: "other",
    });
  });

  it("refuses a new request that names record IDs", async () => {
    let wrote = false;
    const d = deps((call) => {
      if (call.statement.startsWith("BEGIN ATOMIC")) wrote = true;
      return { rows: [] };
    });
    const response = await handleDeltaApiRequest(
      post({ ...SUBMIT_BODY, payload: { intake: STORED_INTAKE } }),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-intake");
    expect(wrote).toBe(false);
  });

  it("withdraws the provider's own request", async () => {
    const { d } = decideDeps(currentAt("business-roi-review"), PROVIDER);
    const response = await handleDeltaApiRequest(
      command("withdraw", {
        idempotencyKey: "66666666-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", note: "Duplicate." },
      }),
      d,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).recordVersion).toBe(3);
  });

  it("hides the request behind not-found when a non-reviewer tries to decide", async () => {
    const { d } = decideDeps(currentAt("business-roi-review"), PROVIDER);
    const response = await handleDeltaApiRequest(
      command("decide", {
        idempotencyKey: "77777777-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", decision: { type: "approve" } },
      }),
      d,
    );
    // The contract hides existence/stage: not-found (404), never a distinguishable 403.
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not-found");
  });

  /** The bound value of an UPDATE's assignment to `column`, or null for an explicit NULL. */
  function updatedValue(block: RecordedStatement, column: string): unknown {
    const update = block.statement.split("\n").find((line) => line.startsWith("UPDATE"));
    const marker = new RegExp("`" + column + "` = (:p\\d+|NULL)").exec(update ?? "")?.[1];
    if (!marker || marker === "NULL") return marker === "NULL" ? null : undefined;
    const value = block.parameters[marker.slice(1)];
    return value !== null && typeof value === "object" && "value" in value
      ? (value as { value: unknown }).value
      : value;
  }

  /** Resubmit ONB-1001 from `current`, with `actions` as the stored history, and return the block. */
  async function resubmitFrom(
    current: Record<string, unknown>,
    resubmission: Record<string, unknown> = { answer: "Clarified." },
    actions: Record<string, unknown>[] = [],
  ) {
    let block: RecordedStatement | undefined;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        block = call;
        return committed(call, RESULT_ROW_FULL);
      }
      if (call.statement.includes("WHERE display_number = :display")) return { rows: [current] };
      if (call.statement.includes("`onboarding_intake_datasets`")) return { rows: DATASET_ROWS };
      if (call.statement.includes("`onboarding_intake_owners`")) return { rows: OWNER_ROWS };
      if (call.statement.includes("`onboarding_request_actions`")) return { rows: actions };
      return { rows: [] };
    }, PROVIDER);
    const response = await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "57575757-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", resubmission },
      }),
      d,
    );
    return { response, block };
  }

  const SENT_BACK_BY = (stage: string) => ({
    action_id: "act-sb",
    action: "sent-back",
    from_stage: stage,
    to_stage: "submitted",
    record_version: 3,
    actor_principal_id: "scim-reviewer",
    actor_display: "Rae Viewer",
    occurred_at: "2026-09-28T09:00:00.000Z",
    note: "Why?",
  });

  it.each([
    // CCB five business days from Monday 2026-09-28 09:00 (the runner's clock).
    { from: "ccb", dueAt: "2026-10-05T09:00:00.000Z" },
    { from: "business-roi-review", dueAt: "2026-10-05T09:00:00.000Z" },
  ])("returns a resubmission to the $from stage that sent it back", async ({ from, dueAt }) => {
    const { response, block } = await resubmitFrom(
      currentAt("submitted", {
        open_send_back_action_id: "act-sb",
        open_send_back_from_stage: from,
      }),
    );

    expect(response.status).toBe(200);
    expect(updatedValue(block!, "stage")).toBe(from);
    expect(updatedValue(block!, "stage_entered_at")).toBe("2026-09-28T09:00:00.000Z");
    expect(updatedValue(block!, "sla_due_at")).toBe(dueAt);
    expect(updatedValue(block!, "open_send_back_from_stage")).toBeNull();
    const [lead] = parseInserts(block!, "onboarding_request_actions");
    expect(lead).toMatchObject({ action: "resubmitted", from_stage: "submitted", to_stage: from });
  });

  it("starts the CCB's own configured SLA target when a resubmission returns there", async () => {
    setConfiguredSlaConfigForTests({
      ...DEFAULT_EFFECTIVE_SLA_CONFIG,
      stages: { ...DEFAULT_EFFECTIVE_SLA_CONFIG.stages, "edp-roi-review": 7, ccb: 2 },
    });
    try {
      const { block } = await resubmitFrom(
        currentAt("submitted", {
          open_send_back_action_id: "act-sb",
          open_send_back_from_stage: "ccb",
        }),
      );
      // Two business days from Monday 2026-09-28: Wednesday 2026-09-30.
      expect(updatedValue(block!, "sla_due_at")).toBe("2026-09-30T09:00:00.000Z");
    } finally {
      setConfiguredSlaConfigForTests(DEFAULT_EFFECTIVE_SLA_CONFIG);
    }
  });

  it("falls back to the stage on the send-back action row when the request row lacks it", async () => {
    const { response, block } = await resubmitFrom(
      currentAt("submitted", {
        open_send_back_action_id: "act-sb",
        open_send_back_from_stage: null,
      }),
      { answer: "Clarified." },
      [...ACTION_ROWS, SENT_BACK_BY("ccb")],
    );

    expect(response.status).toBe(200);
    expect(updatedValue(block!, "stage")).toBe("ccb");
  });

  it("refuses a resubmission body that names a stage to return to", async () => {
    const { response, block } = await resubmitFrom(
      currentAt("submitted", {
        open_send_back_action_id: "act-sb",
        open_send_back_from_stage: "ccb",
      }),
      { answer: "Clarified.", to: "business-roi-review" },
    );

    expect(response.status).toBe(400);
    expect(block).toBeUndefined();
  });

  it("stores the answer and every changed intake field on the resubmit action", async () => {
    const { block } = await resubmitFrom(
      currentAt("submitted", {
        open_send_back_action_id: "act-sb",
        open_send_back_from_stage: "ccb",
      }),
      {
        answer: "  Retagged.  ",
        intake: {
          ...STORED_INTAKE,
          datasets: [{ ...STORED_INTAKE.datasets[0]!, datasetTag: "case_signals_gold" }],
          workspaceNeeds: { isolation: "dedicated", teamSize: 6 },
        },
      },
    );

    const [lead] = parseInserts(block!, "onboarding_request_actions");
    expect(JSON.parse(String(lead!["payload"]))).toEqual({
      answer: "Retagged.",
      changes: [
        { field: "Dataset 1 dataset tag", before: "case_signals", after: "case_signals_gold" },
        { field: "Workspace isolation", before: "shared", after: "dedicated" },
      ],
    });
    // #215's tag-change note is unchanged.
    expect(lead!["note"]).toBe("Retagged. Dataset tag changed: case_signals -> case_signals_gold.");
  });

  it("clears the persisted SLA deadlines when a request withdraws (no target)", async () => {
    const { d, block } = decideDeps(currentAt("business-roi-review"), PROVIDER);
    await handleDeltaApiRequest(
      command("withdraw", {
        idempotencyKey: "88888888-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001" },
      }),
      d,
    );
    expect(updatedValue(block()!, "sla_due_at")).toBeNull();
    expect(updatedValue(block()!, "sla_due_soon_at")).toBeNull();
  });
});

describe("Delta onboarding: a GovCloud provider with no name (#332)", () => {
  it.each(GOVCLOUD_CASES)(
    "stores the provider, the Myself owner and the actor as %s, never the numeric id",
    async (_label, govCloud, expected) => {
      const user = await govCloudSessionUser(govCloud);
      let block: RecordedStatement | undefined;
      const d = deps((call) => {
        if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
        if (call.statement.startsWith("BEGIN ATOMIC")) {
          block = call;
          return committed(call, RESULT_ROW_FULL);
        }
        return { rows: [] };
      }, user);

      const response = await handleDeltaApiRequest(post(SUBMIT_BODY), d);
      expect(response.status).toBe(200);

      const request = parseInserts(block!, "onboarding_requests")[0]!;
      expect(request["provider_principal_id"]).toBe(user.principalId);
      expect(request["provider_display"]).toBe(expected);
      expect(request["initiative_owner_kind"]).toBe("self");
      expect(request["initiative_owner_display"]).toBe(expected);
      // The user's own action; the forward after it is the system's.
      const actions = parseInserts(block!, "onboarding_request_actions").filter(
        (action) => action["actor_principal_id"] === user.principalId,
      );
      expect(actions.map((action) => [action["action"], action["actor_display"]])).toEqual([
        ["submitted", expected],
      ]);
      for (const value of [request["provider_display"], request["initiative_owner_display"]]) {
        expect(leaksIdentifier(value)).toBe(false);
      }
    },
  );
});

describe("Delta onboarding persists SLA deadlines on stage entry", () => {
  it("records the review-stage deadlines a submit enters, not null", async () => {
    let block: RecordedStatement | undefined;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        block = call;
        return committed(call, RESULT_ROW_FULL);
      }
      return { rows: [] };
    });

    await handleDeltaApiRequest(post(SUBMIT_BODY), d);

    // Submitted at Monday 2026-09-28 09:00; business & ROI review targets 5 business
    // days (due 2026-10-05) and the due-soon window opens one business day earlier.
    expect(insertedValue(block!, "onboarding_requests", "sla_due_at")).toBe(
      "2026-10-05T09:00:00.000Z",
    );
    expect(insertedValue(block!, "onboarding_requests", "sla_due_soon_at")).toBe(
      "2026-10-02T09:00:00.000Z",
    );
  });
});

describe("Delta onboarding uses the deploy-time SLA config (#157)", () => {
  // Business & ROI review two business days, no due-soon lead, Tuesday a holiday:
  // a Monday 09:00 submit is due Thursday 2026-10-01 09:00, not the default
  // five-day Monday 2026-10-05.
  const CONFIGURED = {
    ...DEFAULT_EFFECTIVE_SLA_CONFIG,
    stages: { ...DEFAULT_EFFECTIVE_SLA_CONFIG.stages, "edp-roi-review": 2 },
    dueSoonThresholdBusinessDays: 0,
    holidays: ["2026-09-29"],
  };

  afterEach(() => setConfiguredSlaConfigForTests(DEFAULT_EFFECTIVE_SLA_CONFIG));

  it("persists deadlines from the configured targets and holidays, not the defaults", async () => {
    setConfiguredSlaConfigForTests(CONFIGURED);
    let block: RecordedStatement | undefined;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        block = call;
        return committed(call, RESULT_ROW_FULL);
      }
      return { rows: [] };
    });

    const response = await handleDeltaApiRequest(post(SUBMIT_BODY), d);

    expect(response.status).toBe(200);
    expect(insertedValue(block!, "onboarding_requests", "sla_due_at")).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    expect(insertedValue(block!, "onboarding_requests", "sla_due_soon_at")).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    // The command response's SLA reads the same configured clock.
    expect((await response.json()).result.sla).toMatchObject({
      stage: "business-roi-review",
      target: 2,
      dueAt: "2026-10-01T09:00:00.000Z",
    });
  });

  it("reads a row's SLA from the configured targets when it has no stored deadline", async () => {
    setConfiguredSlaConfigForTests(CONFIGURED);
    const d = deps((call) => {
      if (isRequestRead(call.statement)) return readRows([RESULT_ROW]);
      return { rows: [] };
    });

    const read = await (await handleDeltaApiRequest(readRequest("ONB-1001"), d)).json();

    expect(read.sla).toMatchObject({ target: 2, dueAt: "2026-10-01T09:00:00.000Z" });
  });

  it("keeps the due date stored on an existing record when the targets change", async () => {
    setConfiguredSlaConfigForTests(CONFIGURED);
    // Entered under the old five-day default; the redeploy must not move it.
    const stored = {
      ...RESULT_ROW,
      sla_due_at: "2026-10-05T09:00:00.000Z",
      sla_due_soon_at: "2026-10-02T09:00:00.000Z",
    };
    const d = deps((call) => {
      if (isRequestRead(call.statement)) return readRows([stored]);
      return { rows: [] };
    });

    const read = await (await handleDeltaApiRequest(readRequest("ONB-1001"), d)).json();

    expect(read.sla).toMatchObject({ dueAt: "2026-10-05T09:00:00.000Z" });
  });
});

describe("Delta onboarding refuses dataset tags that aren't identifier-safe", () => {
  /** Submit `tags` (one dataset each) and return the response and whether a write block ran. */
  async function submitTags(tags: string[]) {
    let wrote = false;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        wrote = true;
        return committed(call, RESULT_ROW_FULL);
      }
      return { rows: [] };
    });
    const intake: OnboardingIntake = {
      ...INTAKE,
      datasets: tags.map((datasetTag, i) => ({
        ...INTAKE.datasets[0]!,
        name: `D${i}`,
        datasetTag,
      })),
    };
    const response = await handleDeltaApiRequest(post({ ...SUBMIT_BODY, payload: { intake } }), d);
    return { response, wrote: () => wrote };
  }

  it.each(BAD_TAGS)(
    "refuses a submit whose tag has %s, before any write",
    async (_l, tag, message) => {
      const { response, wrote } = await submitTags([tag]);
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.code).toBe("invalid-dataset-tag");
      expect(error.message).toMatch(message);
      expect(wrote()).toBe(false);
    },
  );

  it.each(GOOD_TAGS)("accepts the tag %s", async (tag) => {
    const { response, wrote } = await submitTags([tag]);
    expect(response.status).toBe(200);
    expect(wrote()).toBe(true);
  });

  it("refuses two datasets in one request with the same tag", async () => {
    const { response, wrote } = await submitTags(["case_signals", "case_signals"]);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("duplicate-dataset-tag");
    expect(wrote()).toBe(false);
  });

  it("refuses to resubmit a stored request whose tag breaks the rule", async () => {
    let wrote = false;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        wrote = true;
        return committed(call, RESULT_ROW_FULL);
      }
      if (call.statement.includes("WHERE display_number = :display"))
        return {
          rows: [
            {
              ...RESULT_ROW,
              stage: "submitted",
              open_send_back_action_id: "act-sb",
              open_send_back_from_stage: "ccb",
            },
          ],
        };
      if (call.statement.includes("`onboarding_intake_datasets`"))
        return { rows: [{ ...DATASET_ROWS[0], dataset_tag: "Case Signals" }] };
      if (call.statement.includes("`onboarding_intake_owners`")) return { rows: OWNER_ROWS };
      return { rows: [] };
    }, PROVIDER);
    const response = await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "99999999-2222-4333-8444-555555555555",
        expectedVersion: 2,
        payload: { requestId: "ONB-1001", resubmission: { answer: "Clarified." } },
      }),
      d,
    );
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("invalid-dataset-tag");
    expect(error.message).toMatch(/Use case_signals instead/);
    expect(wrote).toBe(false);
  });

  it("refuses resubmit dataset tag edits that duplicate another dataset before any write", async () => {
    let wrote = false;
    const d = deps((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        wrote = true;
        return committed(call, RESULT_ROW_FULL);
      }
      if (call.statement.includes("WHERE display_number = :display"))
        return {
          rows: [
            {
              ...RESULT_ROW,
              stage: "submitted",
              open_send_back_action_id: "act-sb",
              open_send_back_from_stage: "ccb",
            },
          ],
        };
      if (call.statement.includes("`onboarding_intake_datasets`"))
        return {
          rows: [
            DATASET_ROWS[0],
            { ...DATASET_ROWS[0], id: "ds-2", position: 1, name: "Case indicators" },
          ],
        };
      if (call.statement.includes("`onboarding_intake_owners`"))
        return {
          rows: [
            OWNER_ROWS[0],
            {
              ...OWNER_ROWS[0],
              id: "ow-2",
              intake_dataset_id: "ds-2",
              person_display: "Oscar Owner",
              person_email: "oscar.owner@example.gov",
            },
          ],
        };
      return { rows: [] };
    }, PROVIDER);
    const response = await handleDeltaApiRequest(
      command("resubmit", {
        idempotencyKey: "99999999-3333-4333-8444-555555555555",
        expectedVersion: 2,
        payload: {
          requestId: "ONB-1001",
          resubmission: {
            answer: "Fixed.",
            intake: {
              ...STORED_INTAKE,
              datasets: [
                {
                  id: "ds-1",
                  name: "Case signals",
                  sourceSystem: "IMF / Individual Master File",
                  domain: "individual-filing",
                  ingestionMethod: "eftu",
                  datasetTag: "case_signals",
                  owners: [{ id: "ow-1", name: "Olive Owner", email: "olive.owner@example.gov" }],
                },
                {
                  id: "ds-2",
                  name: "Case indicators",
                  sourceSystem: "BMF / Business Master File",
                  domain: "individual-filing",
                  ingestionMethod: "informatica",
                  datasetTag: "case_signals",
                  owners: [{ id: "ow-2", name: "Oscar Owner", email: "oscar.owner@example.gov" }],
                },
              ],
            },
          },
        },
      }),
      d,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("duplicate-dataset-tag");
    expect(wrote).toBe(false);
  });
});

describe("Delta onboarding reads child rows the way the warehouse aggregates them", () => {
  it("reads a dropped null field (to_json drops nulls) as null, as the old per-row read did", async () => {
    // Spark's to_json leaves `from_stage` (and `note`) out when they're null.
    const actions = ACTION_ROWS.map(({ from_stage, note, ...rest }) => ({
      ...rest,
      ...(from_stage === null ? {} : { from_stage }),
      ...(note === null ? {} : { note }),
    }));
    const d = deps((call) =>
      isRequestRead(call.statement) ? readRows([RESULT_ROW], { actions }) : { rows: [] },
    );

    const read = await (await handleDeltaApiRequest(readRequest("ONB-1001"), d)).json();

    expect(read.decisions.map((x: { from: unknown; note: unknown }) => [x.from, x.note])).toEqual([
      [null, ""],
      ["submitted", ""],
    ]);
  });
});

describe("Delta onboarding reads a resubmission's recorded changes (#221)", () => {
  const resubmitted = (payload?: unknown) => ({
    action_id: "act-rs",
    action: "resubmitted",
    from_stage: "submitted",
    to_stage: "ccb",
    record_version: 5,
    actor_principal_id: "scim-provider",
    actor_display: "Pat Provider",
    occurred_at: "2026-09-29T09:00:00.000Z",
    note: "Retagged. Dataset tag changed: a -> b.",
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  const CCB_REVIEWER: SessionUser = { ...BUSINESS_OFFICE, onboardingReviewerRoles: ["ccb"] };

  async function readWith(action: Record<string, unknown>) {
    const d = deps((call) => {
      if (isRequestRead(call.statement))
        return readRows([{ ...RESULT_ROW, stage: "ccb" }], { actions: [...ACTION_ROWS, action] });
      return { rows: [] };
    }, CCB_REVIEWER);
    return (await handleDeltaApiRequest(readRequest("ONB-1001"), d)).json();
  }

  it("selects each action's payload in the set-based read", async () => {
    let statement = "";
    const d = deps((call) => {
      if (isRequestRead(call.statement)) {
        statement = call.statement;
        return readRows([RESULT_ROW]);
      }
      return { rows: [] };
    });
    await handleDeltaApiRequest(readRequest("ONB-1001"), d);
    expect(statement).toContain("'payload', a.payload");
  });

  it("returns the answer and changes on the resubmit decision", async () => {
    const changes = [{ field: "Dataset 1 dataset tag", before: "a", after: "b" }];
    const read = await readWith(resubmitted({ answer: "Retagged.", changes }));
    expect(read.decisions.at(-1)).toMatchObject({
      kind: "resubmit",
      to: "ccb",
      resubmission: { answer: "Retagged.", changes },
    });
  });

  it("serves the returned request in the CCB inbox from the in-memory snapshot as SQL does (#193)", async () => {
    const action = resubmitted({ answer: "Retagged.", changes: [] });
    const row = {
      ...RESULT_ROW,
      id: UUID,
      stage: "ccb",
      stage_entered_at: "2026-09-29T09:00:00.000Z",
    };
    const actions = [...ACTION_ROWS, action].map((a) => ({ ...a, onboarding_request_id: UUID }));
    const inbox = createAppRegistry().findRead("onboarding", "inbox")!;
    const names = createStoreNames("edp_vending");
    const tables: Record<string, Record<string, unknown>[]> = {
      "onboarding.onboarding_requests": [row],
      "onboarding.onboarding_intake_datasets": DATASET_ROWS,
      "onboarding.onboarding_intake_owners": OWNER_ROWS,
      "onboarding.onboarding_request_actions": actions,
    };
    const snapshot = {
      table: (schema: string, table: string) => tables[`${schema}.${table}`] ?? [],
      stats: () => ({}),
    };

    const viaSnapshot = await inbox.snapshot!({
      query: { role: "ccb" },
      user: CCB_REVIEWER,
      names,
      snapshot: snapshot as never,
    });
    const viaSql = await inbox.run({
      query: { role: "ccb" },
      user: CCB_REVIEWER,
      names,
      read: (async () =>
        readRows(
          [{ ...RESULT_ROW, uuid: UUID, stage: "ccb", stage_entered_at: row.stage_entered_at }],
          {
            actions: [...ACTION_ROWS, action],
          },
        ).rows) as never,
    });

    expect(viaSnapshot).toEqual(viaSql);
    expect(
      (viaSnapshot as { decisions: { resubmission?: unknown }[] }[])[0]?.decisions.at(-1),
    ).toMatchObject({
      resubmission: { answer: "Retagged." },
    });
  });

  it("leaves a resubmission stored before #221 with only its note", async () => {
    const read = await readWith(resubmitted());
    expect(read.decisions.at(-1).note).toBe("Retagged. Dataset tag changed: a -> b.");
    expect(read.decisions.at(-1)).not.toHaveProperty("resubmission");
  });
});
