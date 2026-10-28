/**
 * The pilot configuration (src/server/pilot-config.ts): what each deployment
 * loads into Delta, through the configured-dataset loader over the SQLite
 * fake warehouse built from `resources/store-teams.sql`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DATASET_SEED } from "../../../data/datasets/seed";
import { configuredSeed, parsePilotConfig, PilotConfigError } from "../../pilot-config";
import { BAD_TAGS, GOOD_TAGS } from "../../../schema/dataset-tag.fixtures";
import { configuredDatasetsLoader } from "../areas/teams-seed.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const PILOT = {
  initiative: { id: "INI-PILOT", name: "Pilot Analytics", tenant: "RAAS" },
  datasets: [
    {
      name: "Pilot refunds",
      domainTag: "individual-filing",
      datasetTag: "pilot_refunds",
      owners: [{ principalId: "1234567890", displayName: "Pat Owner", email: "pat@example.gov" }],
    },
    {
      id: "ds-pilot-business",
      name: "Pilot business returns",
      domainTag: "business-tax",
      datasetTag: "pilot_business",
      owners: [{ principalId: "2345678901", displayName: "Lee Owner" }],
    },
  ],
};

const PRODUCTION = { schemaPrefix: undefined, seedOwnerIds: undefined };
const PREVIEW = { schemaPrefix: "edp_vm_pr130_", seedOwnerIds: "4055694201057157" };

function load(env: Parameters<typeof configuredSeed>[0]) {
  const warehouse = createSqliteWarehouse();
  const names = createStoreNames("edp_test", "");
  const runner = createTransactionRunner({
    client: warehouse.client,
    names,
    sleep: async () => undefined,
  });
  const { seed, source } = configuredSeed(env);
  const run = configuredDatasetsLoader(() => seed, {
    runner,
    names,
    ...(source ? { source } : {}),
  });
  return { warehouse, run };
}

const rows = <T>(warehouse: SqliteWarehouse, sql: string) => warehouse.query<T & object>(sql);
const count = (warehouse: SqliteWarehouse, table: string) =>
  Number(rows<{ n: number }>(warehouse, `SELECT count(*) AS n FROM "${table}"`)[0]!.n);

describe("the pilot configuration", () => {
  it("loads nothing in production when no pilot configuration is set", async () => {
    const { warehouse, run } = load({ ...PRODUCTION, pilotConfigJson: undefined });
    await run();
    for (const table of [
      "initiatives__initiatives",
      "initiatives__datasets",
      "teams__dataset_owners",
      "teams__dataset_members",
      "initiatives__initiative_actions",
    ]) {
      expect(count(warehouse, table), table).toBe(0);
    }
  });

  it("treats the bundle's default, none, as no pilot configuration", () => {
    expect(configuredSeed({ ...PRODUCTION, pilotConfigJson: "none" })).toEqual({
      seed: { initiatives: [], datasets: [] },
      source: null,
    });
    expect(configuredSeed({ ...PREVIEW, pilotConfigJson: "none" }).source).toBe("preview-sample");
  });

  it("loads exactly the configured pilot in production, recording where it came from", async () => {
    const { warehouse, run } = load({ ...PRODUCTION, pilotConfigJson: JSON.stringify(PILOT) });
    await run();
    await run();

    expect(
      rows(warehouse, `SELECT id, name, tenant, stage FROM "initiatives__initiatives"`),
    ).toEqual([{ id: "INI-PILOT", name: "Pilot Analytics", tenant: "RAAS", stage: "active" }]);
    expect(
      rows(
        warehouse,
        `SELECT id, initiative_id, name, domain_tag, dataset_tag FROM "initiatives__datasets" ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "ds-pilot-business",
        initiative_id: "INI-PILOT",
        name: "Pilot business returns",
        domain_tag: "business-tax",
        dataset_tag: "pilot_business",
      },
      {
        id: "ds-pilot-refunds",
        initiative_id: "INI-PILOT",
        name: "Pilot refunds",
        domain_tag: "individual-filing",
        dataset_tag: "pilot_refunds",
      },
    ]);
    expect(
      rows(
        warehouse,
        `SELECT dataset_id, person_display, person_email, person_principal_id, source FROM "teams__dataset_owners" ORDER BY dataset_id`,
      ),
    ).toEqual([
      {
        dataset_id: "ds-pilot-business",
        person_display: "Lee Owner",
        person_email: null,
        person_principal_id: "2345678901",
        source: "configuration",
      },
      {
        dataset_id: "ds-pilot-refunds",
        person_display: "Pat Owner",
        person_email: "pat@example.gov",
        person_principal_id: "1234567890",
        source: "configuration",
      },
    ]);
    const all = JSON.stringify(rows(warehouse, `SELECT * FROM "initiatives__datasets"`));
    for (const sample of DEFAULT_DATASET_SEED.datasets) expect(all).not.toContain(sample.id);
    expect(
      rows(
        warehouse,
        `SELECT action, actor_principal_id, actor_app, note, payload FROM "initiatives__initiative_actions"`,
      ),
    ).toEqual([
      {
        action: "created",
        actor_principal_id: "system",
        actor_app: "system",
        note: "Loaded from the pilot configuration (EDP_PILOT_CONFIG_JSON).",
        payload: JSON.stringify({ source: "pilot-config" }),
      },
    ]);
  });

  it("uses the pilot configuration on a preview too, instead of the sample", () => {
    expect(configuredSeed({ ...PREVIEW, pilotConfigJson: JSON.stringify(PILOT) })).toMatchObject({
      source: "pilot-config",
      seed: { initiatives: [{ id: "INI-PILOT" }] },
    });
  });

  it("still gives a preview the sample datasets, owned by its UAT reviewer", async () => {
    const { warehouse, run } = load({ ...PREVIEW, pilotConfigJson: undefined });
    await run();

    expect(rows(warehouse, `SELECT id FROM "initiatives__datasets" ORDER BY id`)).toEqual(
      DEFAULT_DATASET_SEED.datasets
        .map((d) => ({ id: d.id }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(
      rows(
        warehouse,
        `SELECT person_principal_id FROM "teams__dataset_owners" WHERE dataset_id = 'ds-refund-anomaly-scores'`,
      ),
    ).toEqual([{ person_principal_id: "4055694201057157" }]);
    expect(rows(warehouse, `SELECT payload FROM "initiatives__initiative_actions"`)).toEqual([
      { payload: JSON.stringify({ source: "preview-sample" }) },
    ]);
  });

  it.each([
    ["not JSON", "{initiative:", /isn't JSON/],
    ["an unknown field", { ...PILOT, extra: true }, /Unrecognized key.*extra/],
    [
      "a missing tenant",
      { ...PILOT, initiative: { id: "INI-PILOT", name: "Pilot" } },
      /initiative\.tenant/,
    ],
    ["no datasets", { ...PILOT, datasets: [] }, /at least one dataset/],
    [
      "a dataset with no owner",
      { ...PILOT, datasets: [{ ...PILOT.datasets[0]!, owners: [] }] },
      /datasets\.0\.owners: a dataset needs at least one owner/,
    ],
    [
      "an owner with no Databricks account ID",
      {
        ...PILOT,
        datasets: [
          { ...PILOT.datasets[0]!, owners: [{ displayName: "Pat", email: "pat@example.gov" }] },
        ],
      },
      /owners\.0\.principalId/,
    ],
    [
      "a bad email",
      {
        ...PILOT,
        datasets: [
          {
            ...PILOT.datasets[0]!,
            owners: [{ principalId: "1", displayName: "Pat", email: "pat" }],
          },
        ],
      },
      /owners\.0\.email: an email address/,
    ],
    [
      "a dataset tag with spaces",
      { ...PILOT, datasets: [{ ...PILOT.datasets[0]!, datasetTag: "a b" }] },
      /datasetTag/,
    ],
    [
      "a repeated dataset tag",
      {
        ...PILOT,
        datasets: [PILOT.datasets[0]!, { ...PILOT.datasets[1]!, datasetTag: "pilot_refunds" }],
      },
      /dataset tag pilot_refunds repeats/,
    ],
  ])("refuses %s, listing the problem, and loads nothing", (_label, config, message) => {
    const raw = typeof config === "string" ? config : JSON.stringify(config);
    expect(() => parsePilotConfig(raw)).toThrow(PilotConfigError);
    expect(() => parsePilotConfig(raw)).toThrow(message);
    expect(() => configuredSeed({ ...PRODUCTION, pilotConfigJson: raw })).toThrow(PilotConfigError);
    // A preview doesn't fall back to the sample either.
    expect(() => configuredSeed({ ...PREVIEW, pilotConfigJson: raw })).toThrow(PilotConfigError);
  });

  it("keeps Zod 3's exact operator-facing shape messages", () => {
    expect(() => parsePilotConfig(JSON.stringify({ ...PILOT, extra: true }))).toThrow(
      "EDP_PILOT_CONFIG_JSON is invalid: (top level): Unrecognized key(s) in object: 'extra'",
    );
    expect(() =>
      parsePilotConfig(
        JSON.stringify({ ...PILOT, initiative: { id: "INI-PILOT", name: "Pilot" } }),
      ),
    ).toThrow("EDP_PILOT_CONFIG_JSON is invalid: initiative.tenant: Required");
    expect(() => parsePilotConfig(JSON.stringify({ ...PILOT, initiative: 3 }))).toThrow(
      "EDP_PILOT_CONFIG_JSON is invalid: initiative: Expected object, received number",
    );
  });

  it.each(BAD_TAGS)("refuses a dataset tag with %s", (_label, tag, message) => {
    const raw = JSON.stringify({
      ...PILOT,
      datasets: [{ ...PILOT.datasets[0]!, datasetTag: tag }],
    });
    expect(() => parsePilotConfig(raw)).toThrow(PilotConfigError);
    expect(() => parsePilotConfig(raw)).toThrow(message);
  });

  it.each(GOOD_TAGS)("accepts the dataset tag %s", (tag) => {
    const raw = JSON.stringify({
      ...PILOT,
      datasets: [{ ...PILOT.datasets[0]!, datasetTag: tag }],
    });
    expect(parsePilotConfig(raw).datasets[0]?.datasetTag).toBe(tag);
  });
});

describe("the Delta API with an invalid pilot configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("refuses every request with the reason, before any SQL", async () => {
    vi.resetModules();
    for (const [name, value] of Object.entries({
      DATABRICKS_HOST: "https://example.test",
      DATABRICKS_WAREHOUSE_ID: "wh",
      EDP_STORE_CATALOG: "edp_test",
      DATABRICKS_CLIENT_ID: "id",
      DATABRICKS_CLIENT_SECRET: "secret",
      EDP_PILOT_CONFIG_JSON: JSON.stringify({ ...PILOT, datasets: [] }),
    })) {
      vi.stubEnv(name, value);
    }
    const fetchSpy = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handleDeltaApi } = await import("../config.ts");

    for (const path of ["/api/reads/initiatives/datasets", "/api/reads/eir/mine"]) {
      const response = await handleDeltaApi(new Request(`http://edp.test${path}`));
      expect(response.status, path).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: "backend-not-configured",
          message: expect.stringMatching(/at least one dataset/),
        },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sample identities in the configuration (#312)", () => {
  const withOwner = (owner: { principalId: string; displayName: string; email?: string }) =>
    JSON.stringify({
      ...PILOT,
      datasets: [{ ...PILOT.datasets[0]!, owners: [owner] }, PILOT.datasets[1]!],
    });
  const SAMPLES = [
    ["a sample principal ID", { principalId: "seed-priya-natarajan", displayName: "Priya" }],
    [
      "a sample email",
      { principalId: "1234567890", displayName: "Tom", email: "tom.becker@example.gov" },
    ],
    [
      "a +tag alias of a sample email, in mixed case",
      {
        principalId: "1234567890",
        displayName: "Priya",
        email: "Priya.Natarajan+pilot@Example.gov",
      },
    ],
  ] as const;

  it.each(SAMPLES)("refuses %s in production's pilot configuration", (_label, owner) => {
    expect(() => configuredSeed({ ...PRODUCTION, pilotConfigJson: withOwner(owner) })).toThrow(
      PilotConfigError,
    );
    expect(() => configuredSeed({ ...PRODUCTION, pilotConfigJson: withOwner(owner) })).toThrow(
      /sample/,
    );
  });

  it("refuses one on a preview too, unless sample mode is on there", () => {
    const pilotConfigJson = withOwner(SAMPLES[0][1]);
    expect(() => configuredSeed({ ...PREVIEW, pilotConfigJson })).toThrow(PilotConfigError);
    expect(() =>
      configuredSeed({ ...PREVIEW, pilotConfigJson, sampleAccessRequests: " true" }),
    ).toThrow(PilotConfigError);
    expect(() =>
      configuredSeed({ ...PRODUCTION, pilotConfigJson, sampleAccessRequests: "true" }),
    ).toThrow(PilotConfigError);
    expect(
      configuredSeed({ ...PREVIEW, pilotConfigJson, sampleAccessRequests: "true" }).source,
    ).toBe("pilot-config");
  });

  it("refuses a sample principal as a preview's seed owner outside sample mode", () => {
    expect(() =>
      configuredSeed({ ...PREVIEW, pilotConfigJson: undefined, seedOwnerIds: "seed-tom-becker" }),
    ).toThrow(PilotConfigError);
  });

  it("the loader refuses one too, and writes nothing", async () => {
    const warehouse = createSqliteWarehouse();
    const names = createStoreNames("edp_test", "");
    const runner = createTransactionRunner({
      client: warehouse.client,
      names,
      sleep: async () => undefined,
    });
    const seed = parsePilotConfig(withOwner(SAMPLES[2][1]));
    const run = configuredDatasetsLoader(() => seed, { runner, names, source: "pilot-config" });

    await expect(run()).rejects.toThrow(/sample/);
    for (const table of [
      "initiatives__initiatives",
      "initiatives__datasets",
      "teams__dataset_owners",
      "teams__dataset_members",
    ]) {
      expect(count(warehouse, table), table).toBe(0);
    }
  });

  it("fails the Delta API closed, before any SQL", async () => {
    vi.resetModules();
    for (const [name, value] of Object.entries({
      DATABRICKS_HOST: "https://example.test",
      DATABRICKS_WAREHOUSE_ID: "wh",
      EDP_STORE_CATALOG: "edp_test",
      DATABRICKS_CLIENT_ID: "id",
      DATABRICKS_CLIENT_SECRET: "secret",
      EDP_PILOT_CONFIG_JSON: withOwner(SAMPLES[1][1]),
    })) {
      vi.stubEnv(name, value);
    }
    const fetchSpy = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handleDeltaApi } = await import("../config.ts");

    const response = await handleDeltaApi(
      new Request("http://edp.test/api/reads/initiatives/datasets"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "backend-not-configured", message: expect.stringMatching(/sample/) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe("the documented example", () => {
  it("is a valid pilot configuration", () => {
    const doc = readFileSync(join(process.cwd(), "docs", "delta-backend.md"), "utf8");
    const section = doc.slice(doc.indexOf("## The pilot configuration"));
    const example = /```json\n([\s\S]*?)```/.exec(section)?.[1];
    expect(example).toBeDefined();
    expect(parsePilotConfig(example!).datasets.map((d) => d.id)).toEqual([
      "ds-refund-anomaly-scores",
    ]);
  });
});
