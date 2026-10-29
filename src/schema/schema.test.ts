import { describe, it, expect } from "vitest";
import {
  assembleRequest,
  canAdvance,
  computeRoi,
  estimateSizing,
  fmtUsd,
  getField,
  loadSchema,
  readNumber,
  resolveSelections,
  validateDatasets,
  validateStep,
} from "./index";
import type { IntakeSchema, IntakeState, LeverOption, PatternOption } from "./types";

// -----------------------------------------------------------------------------
// Oracles: copies of the ORIGINAL onboarding.jsx logic (pre-refactor). The
// schema-driven helpers must produce identical results.
// -----------------------------------------------------------------------------

const FREQ_FACTOR: Record<string, number> = {
  Monthly: 0.4,
  Weekly: 0.7,
  Daily: 1,
  Hourly: 1.8,
  Streaming: 2.6,
};
const CPLX_FACTOR: Record<string, number> = {
  Light: 0.6,
  Moderate: 1,
  Heavy: 1.7,
  "Very heavy / ML features": 2.4,
};

interface SizeInput {
  sizeGb: number;
  freq: string;
  complexity: string;
  users: number;
}

function oracleSizing({ sizeGb, freq, complexity, users }: SizeInput) {
  const gb = Math.max(1, Number(sizeGb) || 1);
  const u = Math.max(1, Number(users) || 1);
  const f = FREQ_FACTOR[freq] ?? 1;
  const c = CPLX_FACTOR[complexity] ?? 1;

  const storageTb = Math.max(0.1, Math.round(((gb * 1.6) / 1024) * 10) / 10);
  const dbu = Math.round((gb / 100) * f * c * 60 + u * 8 + 120);
  const monthlyCost = Math.round((dbu * 3.5 + storageTb * 28 + u * 45) / 10) * 10;
  const annualCost = monthlyCost * 12;

  const load = dbu;
  const tier =
    load < 600
      ? "Small — shared capacity"
      : load < 2000
        ? "Medium — dedicated pipeline"
        : load < 6000
          ? "Large — dedicated pipeline + autoscale"
          : "Extra large — reserved capacity";
  const cluster =
    load < 600
      ? "2 × Standard_DS4"
      : load < 2000
        ? "4 × Standard_DS5"
        : load < 6000
          ? "8 × Standard_DS5 (autoscale)"
          : "16 × Standard_DS5 (reserved)";
  const warehouse =
    u < 15
      ? "2X-Small serverless"
      : u < 50
        ? "Small serverless"
        : u < 150
          ? "Medium serverless"
          : "Large serverless";
  const confidence = Math.max(62, 92 - (c > 1.5 ? 12 : 0) - (f > 1.5 ? 8 : 0));

  return { storageTb, dbu, monthlyCost, annualCost, tier, cluster, warehouse, confidence };
}

function oracleRoi(benefit: number, annualCost: number) {
  const b = Math.max(0, Number(benefit) || 0);
  const cost = Math.max(1, annualCost);
  const ratio = Math.round((b / cost) * 10) / 10;
  const paybackMonths = b > 0 ? Math.max(1, Math.round((cost / b) * 12)) : "—";
  return { ratio, paybackMonths };
}

function oracleFmtUsd(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1000000) return "$" + Math.round(v / 100000) / 10 + "M";
  if (v >= 1000) return "$" + Math.round(v / 1000) + "K";
  return "$" + v;
}

function oracleCanNext(step: number, s: IntakeState): boolean {
  const dataName = String(s["dataName"] ?? "");
  const useCase = String(s["useCase"] ?? "");
  const levers = (s["levers"] as string[]) ?? [];
  return Boolean(
    step === 0
      ? dataName.trim() && !!s["initiativeOwner"] && !!s["domain"]
      : step === 1
        ? !!s["access"]
        : step === 2
          ? !!s["engModel"]
          : step === 3
            ? useCase.trim().length > 10 && Number(s["annualBenefit"]) > 0 && levers.length > 0
            : step === 4
              ? s["estimated"]
              : true,
  );
}

const schema = loadSchema();

// Independently hardcoded copies of the ORIGINAL onboarding.jsx option lists.
// The oracle uses these (not the schema under test) so a drifted id/name/flag
// in intake.config.json is caught rather than silently mirrored.
const ORIG_INGEST: PatternOption[] = [
  {
    id: "eftu",
    name: "Enterprise File Transfer Utility (EFTU)",
    desc: "Scheduled, secure file drops from an IRS source system into EDP.",
    approved: true,
    box: "EFTU",
  },
  {
    id: "informatica",
    name: "Informatica data transfer",
    desc: "Informatica extracts and loads the source into EDP bronze tables.",
    approved: true,
    box: "Informatica",
  },
  {
    id: "epz",
    name: "Secure cloud storage landing area",
    desc: "Source writes objects to the EPZ landing bucket; EDP ingests from there.",
    approved: true,
    box: "EPZ landing zone",
  },
  {
    id: "other",
    name: "I don’t know or need something else — consultation required",
    desc: "Direct DB links, APIs, streaming or custom connectors require an EDP architecture consultation.",
    approved: false,
    box: "Custom path",
  },
];

const ORIG_ACCESS: PatternOption[] = [
  {
    id: "dbx",
    name: "All within Databricks",
    desc: "Notebooks, SQL editor and dashboards inside Databricks only.",
    approved: true,
    box: "Databricks SQL & notebooks",
  },
  {
    id: "tableau",
    name: "Tableau",
    desc: "Tableau connects to Databricks SQL warehouse via Unity Catalog.",
    approved: true,
    box: "Tableau",
  },
  {
    id: "powerbi",
    name: "Power BI",
    desc: "Power BI connects to Databricks SQL warehouse via Unity Catalog.",
    approved: true,
    box: "Power BI",
  },
  {
    id: "other-access",
    name: "I’m not sure or need another tool — consult EDP staff",
    desc: "Extracts to other platforms or custom apps require an EDP architecture consultation.",
    approved: false,
    box: "Other consumer",
  },
];

const ORIG_ENG: PatternOption[] = [
  {
    id: "self",
    name: "We have our own resources",
    desc: "Our team builds the pipelines and models using EDP patterns, guidelines and reference notebooks. No platform-team engineering capacity needed.",
    approved: true,
    platform: false,
    box: "Tenant-built pipelines",
  },
  {
    id: "assisted",
    name: "Guided build — light platform help",
    desc: "Our engineers build, with EDP platform team pairing on pattern review, code review and a design walkthrough.",
    approved: true,
    platform: true,
    box: "Guided build",
  },
  {
    id: "full",
    name: "We need data engineering support",
    desc: "EDP platform team builds the ingestion and medallion transformations for us. Requires platform engineering capacity in the CCB decision.",
    approved: true,
    platform: true,
    box: "Platform-built pipelines",
  },
];

const ORIG_LEVERS: LeverOption[] = [
  {
    id: "fraud",
    name: "Reduce fraud and improper payments",
    icon: "shield",
    measure: "Estimate refund fraud / improper payments prevented per year.",
  },
  {
    id: "taxgap",
    name: "Reduce the tax gap",
    icon: "trending_up",
    measure: "Estimate additional assessments or collections enabled per year.",
  },
  {
    id: "service",
    name: "Better taxpayer services",
    icon: "support_agent",
    measure: "Estimate value of faster case resolution and fewer taxpayer touches.",
  },
  {
    id: "cost",
    name: "Reduce cost and contractor support",
    icon: "savings",
    measure: "Estimate contractor hours and O&M dollars avoided per year.",
  },
  {
    id: "itspend",
    name: "Reduce IT spend / retire duplicate systems",
    icon: "delete",
    measure: "Estimate license, hosting and duplicate-system costs retired per year.",
  },
  {
    id: "compliance",
    name: "Improve data quality, security and compliance posture",
    icon: "verified",
    measure: "Estimate rework, audit findings and manual controls avoided per year.",
  },
];

function oracleLaunch(values: IntakeState, domainName: string, num: number) {
  const find = (list: PatternOption[], id: unknown) => list.find((p) => p.id === id)!;
  const patternDef = find(ORIG_INGEST, values["pattern"]);
  const accessDef = find(ORIG_ACCESS, values["access"]);
  const engDef = find(ORIG_ENG, values["engModel"]);
  const outcomeDef = ORIG_LEVERS.find((l) => l.id === values["outcome"]);
  const outcomeName = outcomeDef?.name ?? "not chosen";
  const outcomeSummary = outcomeDef?.name ?? "Primary outcome: not chosen";
  const leverArr = (values["levers"] as string[]) ?? [];
  const leverLabels = ORIG_LEVERS.filter((l) => leverArr.includes(l.id)).map((l) => l.name);
  const needsConsult = !patternDef.approved || !accessDef.approved;

  const dataName = String(values["dataName"] ?? "");
  const sourceSystem = String(values["sourceSystem"] ?? "");
  const useCase = String(values["useCase"] ?? "");
  const freq = String(values["freq"] ?? "");
  const complexity = String(values["complexity"] ?? "");
  const sizeGb = Number(values["sizeGb"]) || 0;
  const users = Number(values["users"]) || 0;
  const annualBenefit = Number(values["annualBenefit"]) || 0;

  const sizing = oracleSizing({ sizeGb, freq, complexity, users });
  const roi = oracleRoi(annualBenefit, sizing.annualCost);

  return {
    id: "REQ-" + num,
    title: `EDP data onboarding: ${dataName}`,
    submittedAt: "Jun 5, 2026",
    status: "In progress",
    overall: "Submitted — pending EDP business and ROI review",
    purpose: `Onboard ${dataName} from ${sourceSystem} into the ${domainName} domain via ${patternDef.name}, consumed through ${accessDef.name}. ${useCase} Mission value: ${leverLabels.join(", ")} (primary: ${outcomeName}). Sizing: ${sizing.tier} (${sizeGb} GB, ${freq} loads, ${complexity} transforms, ${users} query users) · est. ${oracleFmtUsd(sizing.annualCost)}/yr vs. ${oracleFmtUsd(annualBenefit)} annual benefit (ROI ${roi.ratio}x).`,
    items: [
      {
        kind: "Onboarding",
        label: dataName,
        sub: `Target: the ${domainName} domain · ${sizing.tier}`,
      },
      {
        kind: "Onboarding",
        label: `Ingestion — ${patternDef.name}`,
        sub: `${freq} · ${complexity} transforms`,
      },
      { kind: "Onboarding", label: `Consumption — ${accessDef.name}`, sub: `${users} query users` },
      {
        kind: "Onboarding",
        label: "Platform capacity",
        sub: `${sizing.dbu} DBU/mo · ${sizing.storageTb} TB`,
      },
      {
        kind: "Onboarding",
        label: `Mission value — ${outcomeSummary}`,
        sub: leverLabels.join(" · "),
      },
      {
        kind: "Onboarding",
        label: `Delivery — ${engDef.name}`,
        sub: engDef.platform
          ? "EDP data engineering support requested"
          : "Tenant-built with approved patterns",
      },
    ],
    subRequests: [
      ...(needsConsult
        ? [
            {
              system: "Architecture consultation",
              status: "active",
              detail: "Pattern outside approved list — EDP architecture review required",
            },
          ]
        : []),
      ...(engDef.platform
        ? [
            {
              system: "Data engineering capacity review",
              status: "pending",
              detail: `${engDef.name} — EDP platform engineering effort`,
            },
          ]
        : []),
      {
        system: "EDP business and ROI review",
        status: needsConsult ? "pending" : "active",
        detail: `${outcomeSummary} · ${oracleFmtUsd(sizing.annualCost)}/yr est. cost · ROI ${roi.ratio}x`,
      },
      {
        system: "EDP intake CCB",
        status: "pending",
        detail: `Intake change control board for the ${domainName} domain`,
      },
      {
        system: "BEARS entitlement creation",
        status: "pending",
        detail: `Access entitlements for ${users} query users`,
      },
      {
        system: "DBX users, Unity Catalog, and compute provisioning",
        status: "pending",
        detail: "Medallion layers + pipeline scaffold",
      },
    ],
    stageIndex: 0,
  };
}

// -----------------------------------------------------------------------------

describe("loadSchema", () => {
  it("returns the original wizard steps, extended with datasets and workspace needs (#86)", () => {
    expect(schema.steps.map((s) => s.label)).toEqual([
      "Initiative",
      "Architecture",
      "Delivery support",
      "Business case",
      "Datasets",
      "Workspace",
      "Sizing",
      "Review & submit",
    ]);
  });

  it("is a stable singleton", () => {
    expect(loadSchema()).toBe(loadSchema());
  });

  it("starts provider-supplied answers empty instead of claiming prototype examples", () => {
    expect(getField(schema, "sourceSystem")).toBeUndefined();
    expect(getField(schema, "sensitivity")?.default).toBeNull();
    expect(getField(schema, "sensitivity")?.placeholder).toBe("Choose a sensitivity");
    expect(getField(schema, "access")?.default).toBeNull();
    expect(getField(schema, "engModel")?.default).toBeNull();
    expect(getField(schema, "levers")?.default).toEqual([]);
    expect(getField(schema, "outcome")?.default).toBeNull();
    expect(getField(schema, "annualBenefit")?.default).toBeNull();
    expect(getField(schema, "hoursSaved")?.default).toBeNull();
    expect(getField(schema, "sizeGb")?.default).toBeNull();
    expect(getField(schema, "freq")?.default).toBeNull();
    expect(getField(schema, "complexity")?.default).toBeNull();
    expect(getField(schema, "users")?.default).toBeNull();
  });

  it("preserves the sizing coefficients", () => {
    expect(schema.sizing.freqFactor).toEqual(FREQ_FACTOR);
    expect(schema.sizing.cplxFactor).toEqual(CPLX_FACTOR);
  });

  it("preserves stable option ids while using provider-facing explanations", () => {
    expect(schema.optionLists.ingestPatterns.map((option) => option.id)).toEqual(
      ORIG_INGEST.map((option) => option.id),
    );
    expect(schema.optionLists.accessPatterns.map((option) => option.id)).toEqual(
      ORIG_ACCESS.map((option) => option.id),
    );
    expect(schema.optionLists.engModels.map((option) => option.id)).toEqual(
      ORIG_ENG.map((option) => option.id),
    );
    expect(schema.optionLists.ingestPatterns[0]?.name).toMatch(/Enterprise File Transfer Utility/);
    expect(schema.optionLists.roiLevers).toEqual(ORIG_LEVERS);
  });
});

describe("canAdvance (canNext parity)", () => {
  // The original six steps, in their original order; the oracle indexes them by position.
  const stepIds = ["source", "architecture", "delivery", "business", "sizing", "review"];

  const states: IntakeState[] = [
    {},
    { dataName: "  ", steward: "x", domain: "individual-filing" },
    { dataName: "Set", steward: "  ", domain: "individual-filing" },
    { dataName: "Set", steward: "A. Reyes", domain: "" },
    { dataName: "Set", steward: "A. Reyes", domain: "individual-filing" },
    { pattern: "eftu", access: "" },
    { pattern: "eftu", access: "dbx" },
    { engModel: "" },
    { engModel: "self" },
    { useCase: "too short", annualBenefit: 750000, levers: ["fraud"] },
    { useCase: "this is long enough", annualBenefit: 0, levers: ["fraud"] },
    { useCase: "this is long enough", annualBenefit: 100, levers: [] },
    { useCase: "this is long enough", annualBenefit: 100, levers: ["fraud"] },
    { estimated: false },
    { estimated: true },
  ];

  it("matches the original per-step gates across sample states", () => {
    // Source system/domain/ingestion moved to each dataset, so the original
    // initiative/source and architecture gates no longer have parity.
    for (let step = 2; step < stepIds.length; step++) {
      for (const state of states) {
        // The original wizard had no initiative owner (#103), so it's answered here.
        const answered = {
          initiativeOwner: { kind: "self" },
          sensitivity: "SBU",
          ...state,
        };
        expect(canAdvance(schema, stepIds[step]!, answered)).toBe(oracleCanNext(step, answered));
      }
    }
  });

  it("gates the review step open regardless of state", () => {
    expect(canAdvance(schema, "review", {})).toBe(true);
  });
});

describe("required mission meaning", () => {
  it("requires positive benefit but leaves outcome and priority optional", () => {
    const state = {
      useCase: "A sufficiently detailed mission case",
      levers: ["fraud"],
      annualBenefit: 100,
    };
    expect(validateStep(schema, "business", state)).toEqual([]);
    expect(canAdvance(schema, "business", state)).toBe(true);
  });
});

describe("estimateSizing / computeRoi / fmtUsd parity", () => {
  const freqs = Object.keys(FREQ_FACTOR);
  const complexities = Object.keys(CPLX_FACTOR);
  const gbValues = [0, 1, 250, 500, 5000, 40000];
  const userValues = [0, 1, 14, 40, 149, 500];

  it("reproduces the sizing heuristic over a matrix of inputs", () => {
    for (const freq of freqs) {
      for (const complexity of complexities) {
        for (const sizeGb of gbValues) {
          for (const users of userValues) {
            const input = { sizeGb, freq, complexity, users };
            expect(estimateSizing(schema, input)).toEqual(oracleSizing(input));
          }
        }
      }
    }
  });

  it("maps provider-facing complexity labels to the original sizing factors", () => {
    const estimate = (complexity: string) =>
      estimateSizing(schema, { sizeGb: 500, freq: "Daily", complexity, users: 40 });
    expect(estimate("Light — copy, filter, or rename")).toMatchObject({
      dbu: 620,
      monthlyCost: 3990,
    });
    expect(
      estimate("Heavy — many joins, large aggregations, or frequent recomputation"),
    ).toMatchObject({
      dbu: 950,
      monthlyCost: 5150,
    });
    expect(estimate("Machine learning — feature engineering or model workloads")).toMatchObject({
      dbu: 1160,
      monthlyCost: 5880,
    });
  });

  it("reproduces ROI computation", () => {
    for (const benefit of [0, 750000, 1200000, 50000]) {
      for (const annualCost of [1, 84000, 250000]) {
        expect(computeRoi(benefit, annualCost)).toEqual(oracleRoi(benefit, annualCost));
      }
    }
  });

  it("reproduces USD formatting", () => {
    for (const n of [0, 999, 1000, 84000, 750000, 999999, 1000000, 1250000]) {
      expect(fmtUsd(n)).toBe(oracleFmtUsd(n));
    }
  });
});

describe("resolveSelections", () => {
  it("does not substitute the first option for blank or unknown ids", () => {
    const sel = resolveSelections(schema, {});
    expect(sel.patternDef.name).toBe("Not chosen");
    expect(sel.accessDef.name).toBe("Not chosen");
    expect(sel.engDef.name).toBe("Not chosen");
    expect(sel.outcomeDef).toBeNull();
    expect(sel.needsConsult).toBe(true);
    expect(sel.leverLabels).toEqual([]);
  });

  it("flags consultation for off-pattern selections", () => {
    expect(resolveSelections(schema, { pattern: "other" }).needsConsult).toBe(true);
    expect(resolveSelections(schema, { access: "other-access" }).needsConsult).toBe(true);
  });
});

describe("assembleRequest (launch parity)", () => {
  const scenarios: { values: IntakeState; domainName: string; num: number }[] = [
    {
      values: {
        dataName: "Preparer e-file submissions (curated)",
        sourceSystem: "IMF / Individual Master File",
        pattern: "eftu",
        access: "dbx",
        engModel: "self",
        levers: ["fraud"],
        useCase: "Score preparer risk weekly instead of quarterly.",
        outcome: "fraud",
        annualBenefit: 750000,
        sizeGb: 500,
        freq: "Daily",
        complexity: "Moderate",
        users: 40,
      },
      domainName: "Individual Filing",
      num: 2085,
    },
    {
      values: {
        dataName: "Collections case signals",
        sourceSystem: "IDRS",
        pattern: "other",
        access: "other-access",
        engModel: "full",
        levers: ["taxgap", "cost"],
        useCase: "Prioritize balance-due cases.",
        outcome: "taxgap",
        annualBenefit: 1250000,
        sizeGb: 40000,
        freq: "Streaming",
        complexity: "Very heavy / ML features",
        users: 200,
      },
      domainName: "Enforcement & Collections",
      num: 2098,
    },
    {
      values: {
        dataName: "Guided build dataset",
        sourceSystem: "BMF",
        pattern: "informatica",
        access: "tableau",
        engModel: "assisted",
        levers: [],
        useCase: "",
        outcome: "unknown-id",
        annualBenefit: 0,
        sizeGb: 1,
        freq: "Monthly",
        complexity: "Light",
        users: 1,
      },
      domainName: "Business Filing",
      num: 2080,
    },
  ];

  it("builds the identical request object as the original launch()", () => {
    for (const { values, domainName, num } of scenarios) {
      expect(assembleRequest(schema, { values, domainName, num })).toEqual(
        oracleLaunch(values, domainName, num),
      );
    }
  });
});

describe("assembleRequest interprets (not ignores) the declarative request config", () => {
  const baseValues: IntakeState = {
    dataName: "Alpha dataset",
    sourceSystem: "Zeta source",
    pattern: "eftu",
    access: "dbx",
    engModel: "self",
    levers: ["fraud"],
    useCase: "A sufficiently long justification.",
    outcome: "fraud",
    annualBenefit: 750000,
    sizeGb: 500,
    freq: "Daily",
    complexity: "Moderate",
    users: 40,
  };
  const args = { values: baseValues, domainName: "Individual Filing", num: 2090 };

  const withRequest = (patch: Partial<IntakeSchema["request"]>): IntakeSchema => {
    const clone = structuredClone(schema);
    return { ...clone, request: { ...clone.request, ...patch } };
  };

  it("uses the configured id prefix", () => {
    expect(assembleRequest(withRequest({ idPrefix: "TKT-" }), args).id).toBe("TKT-2090");
  });

  it("uses the configured title and purpose templates", () => {
    const out = assembleRequest(
      withRequest({
        titleTemplate: "Intake for {dataName}",
        purposeTemplate: "Purpose: {dataName} / {sourceSystem}",
      }),
      args,
    );
    expect(out.title).toBe("Intake for Alpha dataset");
    expect(out.purpose).toBe("Purpose: Alpha dataset / Zeta source");
  });

  it("keeps a blank optional primary outcome blank in confirmation copy", () => {
    const out = assembleRequest(schema, {
      ...args,
      values: { ...baseValues, outcome: "" },
    });
    expect(out.purpose).toContain("(primary: not chosen)");
    expect(out.items).toContainEqual(
      expect.objectContaining({ label: "Mission value — Primary outcome: not chosen" }),
    );
    expect(out.purpose).not.toContain("primary: Reduce fraud and improper payments");
    const businessReview = out.subRequests.find(
      (sub) => sub.system === "EDP business and ROI review",
    );
    expect(businessReview?.detail).toMatch(/^Primary outcome: not chosen · \$\S+\/yr est\. cost/);
  });

  it("lists every dataset domain in confirmation copy", () => {
    const out = assembleRequest(schema, {
      ...args,
      values: {
        ...baseValues,
        datasets: [
          {
            name: "Returns",
            sourceSystem: "IMF",
            domain: "individual-filing",
            ingestionMethod: "eftu",
            datasetTag: "returns",
            owners: [],
          },
          {
            name: "Cases",
            sourceSystem: "ICS",
            domain: "enforcement-collections",
            ingestionMethod: "informatica",
            datasetTag: "cases",
            owners: [],
          },
        ],
      },
      domainNames: {
        "individual-filing": "Individual Filing",
        "enforcement-collections": "Enforcement & Collections",
      },
    });
    expect(out.purpose).toContain("the Individual Filing; Enforcement & Collections domains");
    expect(out.items[0]?.sub).toBe(
      "Target: the Individual Filing; Enforcement & Collections domains · Medium — dedicated pipeline",
    );
    expect(out.subRequests).toContainEqual({
      system: "EDP intake CCB",
      status: "pending",
      detail:
        "Intake change control board for the Individual Filing; Enforcement & Collections domains",
    });
  });

  it("actually consumes fieldMap (remapping a context var changes output)", () => {
    const base = assembleRequest(schema, args);
    const remapped = assembleRequest(
      withRequest({ fieldMap: { ...schema.request.fieldMap, dataName: "sourceSystem" } }),
      args,
    );
    expect(base.title).toBe("EDP data onboarding: Alpha dataset");
    expect(remapped.title).toBe("EDP data onboarding: Zeta source");
  });

  it("honors declarative conditional inclusion of subrequests", () => {
    const cfg = withRequest({
      subRequests: [
        { when: "needsConsult", system: "Only when consult", status: "active", detail: "x" },
        { system: "Always", status: "pending", detail: "y" },
      ],
    });
    const approved = assembleRequest(cfg, args); // eftu/dbx -> no consult
    expect(approved.subRequests.map((s) => s.system)).toEqual(["Always"]);

    const offPattern = assembleRequest(cfg, {
      ...args,
      values: { ...baseValues, pattern: "other" },
    });
    expect(offPattern.subRequests.map((s) => s.system)).toEqual(["Only when consult", "Always"]);
  });
});

describe("the extended intake — datasets and workspace needs (#86)", () => {
  const owner = { name: "Olive Owner", email: "olive.owner@example.gov" };
  const dataset = {
    name: "Case signals",
    sourceSystem: "IMF / Individual Master File",
    domain: "individual-filing",
    ingestionMethod: "eftu",
    datasetTag: "case_signals",
    owners: [owner],
  };

  it("labels the dataName field as the initiative name", () => {
    expect(getField(schema, "dataName")?.label).toBe("Initiative name");
  });

  it("needs at least one dataset", () => {
    expect(validateDatasets([])).toEqual(["Add at least one dataset."]);
    expect(validateDatasets(undefined)).toEqual(["Add at least one dataset."]);
    expect(canAdvance(schema, "datasets", { datasets: [] })).toBe(false);
  });

  it("needs a domain (or other), a dataset tag and an owner on every dataset", () => {
    expect(validateDatasets([dataset])).toEqual([]);
    expect(validateDatasets([{ ...dataset, domain: "other" }])).toEqual([]);
    expect(
      validateDatasets([dataset, { name: "", domain: "", datasetTag: "  ", owners: [] }]),
    ).toEqual([
      "Dataset 2: enter a dataset name.",
      "Dataset 2: enter a source system.",
      'Dataset 2: choose a domain, or "Other".',
      "Dataset 2: choose how this dataset gets into EDP.",
      "Dataset 2: enter a dataset tag.",
      "Dataset 2: name at least one dataset owner.",
    ]);
  });

  it("needs a name and a valid email for each owner", () => {
    expect(
      validateDatasets([{ ...dataset, owners: [owner, { name: " ", email: "not-an-email" }] }]),
    ).toEqual([
      "Dataset 1, owner 2: enter the owner's name.",
      "Dataset 1, owner 2: enter a valid email address.",
    ]);
  });

  it("reports the datasets step's problems as validation errors", () => {
    expect(validateStep(schema, "datasets", { datasets: [] })).toEqual([
      { field: "datasets", key: "add", message: "Add at least one dataset." },
    ]);
    expect(validateStep(schema, "datasets", { datasets: [dataset] })).toEqual([]);
    expect(canAdvance(schema, "datasets", { datasets: [dataset] })).toBe(true);
  });

  it("records the workspace-needs answers and requires both", () => {
    expect(validateStep(schema, "workspace", {}).map((issue) => issue.field)).toEqual([
      "isolation",
      "teamSize",
    ]);
    const answered = { isolation: "Not sure", teamSize: 6 };
    expect(validateStep(schema, "workspace", answered)).toEqual([]);
    expect(canAdvance(schema, "workspace", answered)).toBe(true);
  });

  it("derives a message from the field label when a rule has none", () => {
    expect(validateStep(schema, "source", { domain: "individual-filing" })).toEqual([
      { field: "dataName", message: "Initiative name is required." },
      { field: "initiativeOwner", key: "kind", message: "Choose who owns the initiative." },
      { field: "sensitivity", message: "Data sensitivity is required." },
    ]);
  });

  it("carries a display-only compute policy overview that notes changes come later", () => {
    expect(schema.computePolicy?.items.length).toBeGreaterThan(0);
    expect(schema.computePolicy?.changeNote).toMatch(/change your compute policy/i);
  });
});

describe("the initiative point of contact (#103)", () => {
  const owner = (value: unknown) => validateStep(schema, "source", { initiativeOwner: value });
  const ownerIssues = (value: unknown) =>
    owner(value).filter((issue) => issue.field === "initiativeOwner");

  it("declares a required initiative point of contact on the first step", () => {
    expect(getField(schema, "initiativeOwner")).toMatchObject({
      step: "source",
      type: "initiative-owner",
      label: "Initiative point of contact",
      required: true,
    });
    expect(schema.steps[0]?.layout?.flat()).toContain("initiativeOwner");
  });

  it("requires the provider to choose one of the original sensitivity values", () => {
    expect(getField(schema, "sensitivity")).toMatchObject({
      required: true,
      options: ["SBU", "SBU (FTI)", "Non-SBU"],
    });
    expect(
      validateStep(schema, "source", { sensitivity: "" }).map((issue) => issue.message),
    ).toContain("Data sensitivity is required.");
  });

  it("needs Myself or Someone else to be chosen", () => {
    expect(ownerIssues(undefined)).toEqual([
      { field: "initiativeOwner", key: "kind", message: "Choose who owns the initiative." },
    ]);
    expect(ownerIssues({ kind: "nobody" })).toHaveLength(1);
  });

  it("takes Myself with nothing typed: the server fills it in from the session", () => {
    expect(ownerIssues({ kind: "self" })).toEqual([]);
  });

  it("needs a name and a valid email for Someone else", () => {
    expect(ownerIssues({ kind: "someone-else", name: " ", email: "not-an-email" })).toEqual([
      {
        field: "initiativeOwner",
        key: "name",
        message: "Enter the initiative point of contact's name.",
      },
      {
        field: "initiativeOwner",
        key: "email",
        message: "Enter a valid email address for the initiative point of contact.",
      },
    ]);
    expect(
      ownerIssues({ kind: "someone-else", name: "Sam Else", email: "sam.else@example.gov" }),
    ).toEqual([]);
  });

  describe("each dataset owner is Myself or Someone else, as the initiative owner is", () => {
    const withOwners = (...owners: unknown[]) => [
      { name: "Case signals", domain: "individual-filing", datasetTag: "case_signals", owners },
    ];
    const ownerIssues = (value: unknown) =>
      validateStep(schema, "datasets", { datasets: value }).filter((issue) =>
        /:owner\d+:/.test(issue.key ?? ""),
      );

    it("asks an untouched owner row to choose", () => {
      expect(ownerIssues(withOwners({ name: "", email: "" }))).toEqual([
        {
          field: "datasets",
          key: "0:owner0:kind",
          message: "Dataset 1, owner 1: choose Myself or Someone else.",
        },
      ]);
    });

    it("needs a name and a valid email once Someone else is chosen", () => {
      expect(
        ownerIssues(withOwners({ self: false, name: "", email: "" })).map((issue) => issue.key),
      ).toEqual(["0:owner0:name", "0:owner0:email"]);
      expect(ownerIssues(withOwners({ self: false, name: "Olive", email: "o@example.gov" }))).toEqual(
        [],
      );
    });

    it("allows Myself once per dataset, and on more than one dataset", () => {
      const me = { self: true, name: "", email: "" };
      expect(ownerIssues(withOwners(me, { name: "Olive", email: "o@example.gov" }, me))).toEqual([
        {
          field: "datasets",
          key: "0:owner2:kind",
          message: "Dataset 1, owner 3: Myself is already owner 1 of this dataset.",
        },
      ]);
      const two = [
        ...withOwners(me),
        {
          name: "Other",
          sourceSystem: "BMF / Business Master File",
          domain: "individual-filing",
          ingestionMethod: "informatica",
          datasetTag: "other_tag",
          owners: [me],
        },
      ];
      expect(ownerIssues(two)).toEqual([]);
    });
  });

  it("takes a dataset owner picked as Myself without a name or email", () => {
    const dataset = {
      name: "Case signals",
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      ingestionMethod: "eftu",
      datasetTag: "case_signals",
      owners: [{ self: true, name: "", email: "" }],
    };
    expect(validateDatasets([dataset])).toEqual([]);
  });
});

describe("no accountable data steward (#103)", () => {
  it("doesn't ask for one: the initiative owner says who's accountable", () => {
    expect(getField(schema, "steward")).toBeUndefined();
    expect(schema.steps[0]?.layout?.flat()).not.toContain("steward");
    expect(
      validateStep(schema, "source", {
        dataName: "Set",
        initiativeOwner: { kind: "self" },
        domain: "individual-filing",
        sensitivity: "SBU (FTI)",
      }),
    ).toEqual([]);
  });
});

describe("minNumber messages", () => {
  const withRule = (rule: IntakeSchema["validation"][string][number]): IntakeSchema => ({
    ...schema,
    validation: { ...schema.validation, business: [rule] },
  });
  const messages = (rule: Parameters<typeof withRule>[0], annualBenefit: unknown) =>
    validateStep(withRule(rule), "business", { annualBenefit }).map((issue) => issue.message);

  it("says an empty number is required, and honours a nonzero minimum", () => {
    const rule = { type: "minNumber", field: "annualBenefit", min: 10 } as const;
    for (const empty of [undefined, null, "", Number.NaN]) {
      expect(messages(rule, empty)).toEqual(["Estimated annual benefit (USD) is required."]);
    }
    expect(messages(rule, 10)).toEqual(["Estimated annual benefit (USD) must be more than 10."]);
    expect(messages(rule, 11)).toEqual([]);
  });

  it("shows a rule's own message whether the number is empty or too small", () => {
    const rule = {
      type: "minNumber",
      field: "annualBenefit",
      min: 0,
      message: "Enter the expected benefit.",
    } as const;
    expect(messages(rule, undefined)).toEqual(["Enter the expected benefit."]);
    expect(messages(rule, 0)).toEqual(["Enter the expected benefit."]);
  });
});

describe("number fields typed as text", () => {
  it("reads numbers, ignoring thousands separators and a leading $", () => {
    expect(readNumber(1200)).toBe(1200);
    expect(readNumber("1,200")).toBe(1200);
    expect(readNumber(" 1 200 ")).toBe(1200);
    expect(readNumber("$750,000")).toBe(750000);
    expect(readNumber("1.5")).toBe(1.5);
    expect(readNumber("-5")).toBe(-5);
    for (const blank of [undefined, null, "", "  ", Number.NaN]) {
      expect(readNumber(blank)).toBeUndefined();
    }
    for (const junk of ["abc", "12abc", "1.2.3", "$", "-", "1e3", "Infinity"]) {
      expect(readNumber(junk)).toBeNaN();
    }
  });

  const businessMessages = (values: IntakeState) =>
    validateStep(schema, "business", {
      useCase: "Score preparer risk weekly instead of quarterly.",
      levers: ["fraud"],
      outcome: "fraud",
      priority: "Standard — valuable planned work",
      annualBenefit: 750000,
      ...values,
    }).map((issue) => issue.message);

  const BIG = "9".repeat(400);
  const NOT_A_NUMBER = "Estimated annual benefit (USD) must be a number.";
  const COMMA_DECIMAL =
    "Estimated annual benefit (USD) must be a number. Use a full stop for decimals, like 1.5.";
  const TOO_LARGE = "Estimated annual benefit (USD) is too large.";
  // typed into the currency field -> what readNumber reads, and the error shown
  it.each([
    ["1,200", 1200, null],
    ["750,000", 750000, null],
    ["1,200.50", 1200.5, null],
    ["$1,200.50", 1200.5, null],
    ["1 200", 1200, null],
    ["1\u00a0200", 1200, null],
    ["  1,200  ", 1200, null],
    ["\u22125", -5, "Estimated annual benefit (USD) must be more than 0."],
    ["1,23", Number.NaN, COMMA_DECIMAL],
    ["1,5", Number.NaN, COMMA_DECIMAL],
    [",200", Number.NaN, NOT_A_NUMBER],
    [",200.50", Number.NaN, NOT_A_NUMBER],
    ["1,2345", Number.NaN, NOT_A_NUMBER],
    ["1,200,", Number.NaN, NOT_A_NUMBER],
    ["12,00,000", Number.NaN, NOT_A_NUMBER],
    ["1,200 300", Number.NaN, NOT_A_NUMBER],
    ["1.2.3", Number.NaN, NOT_A_NUMBER],
    ["1e3", Number.NaN, NOT_A_NUMBER],
    [BIG, Number.NaN, TOO_LARGE],
    [String(Number.MAX_SAFE_INTEGER + 2), Number.NaN, TOO_LARGE],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER, null],
  ] as const)("reads %j as %s", (typed, expected, message) => {
    expect(readNumber(typed)).toBe(expected);
    expect(businessMessages({ annualBenefit: typed })).toEqual(message ? [message] : []);
  });

  it("says text that isn't a number must be a number, once per field", () => {
    expect(businessMessages({ annualBenefit: "12abc" })).toEqual([
      "Estimated annual benefit (USD) must be a number.",
    ]);
    expect(businessMessages({ hoursSaved: "abc" })).toEqual([
      "Staff hours saved per year must be a number.",
    ]);
    expect(canAdvance(schema, "business", { annualBenefit: "abc" })).toBe(false);
  });

  it("takes a $ only on currency fields and a fraction only where decimals are allowed", () => {
    expect(businessMessages({ annualBenefit: "$1,200.50", hoursSaved: "1,200" })).toEqual([]);
    expect(businessMessages({ hoursSaved: "$1,200" })).toEqual([
      "Staff hours saved per year must be a number.",
    ]);
    expect(businessMessages({ hoursSaved: "1.5" })).toEqual([
      "Staff hours saved per year must be a whole number.",
    ]);
    expect(validateStep(schema, "sizing", { sizeGb: "1.5", estimated: true })).toEqual([]);
  });

  it("checks minimums against the number the text holds", () => {
    expect(businessMessages({ annualBenefit: "0" })).toEqual([
      "Estimated annual benefit (USD) must be more than 0.",
    ]);
    expect(businessMessages({ annualBenefit: " " })).toEqual([
      "Estimated annual benefit (USD) is required.",
    ]);
  });
});
