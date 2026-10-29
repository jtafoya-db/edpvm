/**
 * The whole intake package (#229) as the business & ROI reviewer, the CCB and
 * the data provider read it, rendered through the store seam on both backends:
 * the memory adapter, and the Delta adapter end to end (its HTTP transport,
 * the server's API router and onboarding area over the SQLite fake warehouse
 * built from the real DDL). Both must show the same package.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMemoryStore,
  toOnboardingIntake,
  type DataStore,
  type OnboardingIntake,
  type OnboardingRequest,
  type UserProfile,
} from "@/data";
import { createDeltaStore, httpTransport } from "@/data/adapters/delta";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { StoreProvider } from "@/data/store-provider";
import { cloneSchema, loadSchema, type IntakeState } from "@/schema";
import { handleDeltaApiRequest, type DeltaApiDeps } from "@/server/delta/api";
import { createAppRegistry } from "@/server/delta/areas/index";
import { createStoreNames } from "@/server/delta/sql-builder";
import { createTransactionRunner } from "@/server/delta/transaction";
import { SNAPSHOT_TABLES } from "@/server/delta/snapshot-cache";
import {
  createSqliteWarehouse,
  type SqliteWarehouse,
} from "@/server/delta/__tests__/sqlite-warehouse";
import { IntakePackage } from "./IntakePackage";
import { MyOnboardingRequests, OnboardingInbox } from "./index";

afterEach(cleanup);

const SCHEMA = loadSchema();
const BASE_USER = makeSnapshot().user;
const profile = (over: Partial<UserProfile>): UserProfile => ({
  ...BASE_USER,
  isAdmin: false,
  onboardingReviewerRoles: [],
  ...over,
});
const PROVIDER = profile({ principalId: "scim-provider", name: "Pat Provider" });
const BUSINESS_OFFICE = profile({
  principalId: "scim-bo",
  name: "Bea Office",
  onboardingReviewerRoles: ["business-office"],
});
const CCB = profile({
  principalId: "scim-ccb",
  name: "Cal Board",
  onboardingReviewerRoles: ["ccb"],
});
const STRANGER = profile({ principalId: "scim-stranger", name: "Sam Else" });

/** Every wizard step filled in, with an architecture outside the approved patterns. */
const FILLED: IntakeState = {
  dataName: "Collections case signals",
  initiativeOwner: { kind: "someone-else", name: "Sam Else", email: "sam.else@example.gov" },
  sourceSystem: "BMF / Business Master File",
  domain: "individual-filing",
  sensitivity: "SBU",
  steward: "A. Reyes, RPO Analytics",
  access: "tableau",
  engModel: "full",
  deliverySupportDetails: "EDP should build the ingestion connector.",
  levers: ["taxgap", "cost"],
  useCase: "Prioritize balance-due cases across treatment streams.",
  outcome: "taxgap",
  annualBenefit: "1,250,000",
  hoursSaved: "2,400",
  datasets: [
    {
      name: "Case signals",
      sourceSystem: "BMF / Business Master File",
      domain: "individual-filing",
      ingestionMethod: "other",
      ingestionDetails: "Query a partner API each morning.",
      datasetTag: "case_signals",
      owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
    },
  ],
  isolation: "Yes — code, notebook or dashboard names or contents must be hidden",
  isolationReason: "Investigative methods must remain within the named team.",
  teamSize: "6",
  sizeGb: "2,500.5",
  freq: "Weekly",
  complexity: "Heavy",
  users: "55",
  estimated: true,
};

/**
 * How each schema field's answer reads in the package. A field the schema
 * gains without an entry here fails the coverage test until it's added.
 */
const SHOWN: Record<string, string> = {
  dataName: "Collections case signals",
  initiativeOwner: "Sam Else (sam.else@example.gov)",
  sourceSystem: "BMF / Business Master File",
  domain: "Individual Filing",
  sensitivity: "SBU",
  steward: "A. Reyes, RPO Analytics",
  access: "Tableau",
  accessConsultDetails: "Not answered",
  engModel: "We need data engineering support",
  deliverySupportDetails: "EDP should build the ingestion connector.",
  levers: "Reduce the tax gap; Reduce cost and contractor support",
  useCase: "Prioritize balance-due cases across treatment streams.",
  outcome: "Reduce the tax gap",
  annualBenefit: "$1.3M",
  hoursSaved: "2,400",
  datasets: "Case signals",
  isolation: "Yes — code, notebook or dashboard names or contents must be hidden",
  isolationReason: "Investigative methods must remain within the named team.",
  teamSize: "6",
  sizeGb: "2,500.5",
  freq: "Weekly",
  complexity: "Heavy",
  users: "55",
};

let signedIn: UserProfile = PROVIDER;

function memoryStore(): DataStore {
  return createMemoryStore(makeSnapshot(), { currentUser: async () => signedIn });
}

function deltaStore(): DataStore {
  return deltaHarness().store;
}

/** The Delta backend end to end, with the warehouse and API behind it for reads past the browser. */
function deltaHarness() {
  const warehouse = createSqliteWarehouse({
    files: ["store-schema.sql", "store-admin.sql", "store-teams.sql", "store-onboarding.sql"],
  });
  const names = createStoreNames("edp_test", "");
  const deps: DeltaApiDeps = {
    registry: createAppRegistry(),
    runner: createTransactionRunner({ client: warehouse.client, names, sleep: async () => {} }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => ({
      principalId: signedIn.principalId,
      displayName: signedIn.name,
      email: signedIn.email ?? "",
      isAdmin: signedIn.isAdmin,
      onboardingReviewerRoles: signedIn.onboardingReviewerRoles ?? [],
    }),
    requirePrivacyAcknowledgment: async () => undefined,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) =>
    handleDeltaApiRequest(
      new Request(new URL(url, "http://edp.test"), init),
      deps,
    )) as typeof fetch;
  const store = createDeltaStore({
    transport: httpTransport(fetchImpl),
    domains: () => makeSnapshot().domains,
    accessStores: { currentUser: async () => signedIn },
  });
  return { store, warehouse, names, deps };
}

const BACKENDS = [
  { label: "memory", make: memoryStore },
  { label: "delta", make: deltaStore },
] as const;

function renderAs(store: DataStore, user: UserProfile, ui: ReactNode) {
  signedIn = user;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

function as(store: DataStore, user: UserProfile) {
  signedIn = user;
  return store.onboarding;
}

/** Once the catalog has named the domains: the package's domain answers read as names. */
async function domainsNamed(scope: HTMLElement = document.body) {
  await within(scope).findAllByText(/Individual Filing/);
}

/** The package section in `scope`, and each step's content by step label. */
function packageIn(scope: HTMLElement) {
  const section = within(scope).getByRole("region", { name: "Intake package" });
  const step = (label: string) => {
    const button = within(section).getByRole("button", { name: new RegExp(`^${label} ·`) });
    const content = document.getElementById(button.getAttribute("aria-controls")!)!;
    return { button, content };
  };
  return { section, step };
}

/** The answer row for `label` within a step's content. */
function row(content: HTMLElement, label: string): HTMLElement {
  const term = within(content).getAllByText(label, { selector: "dt" })[0]!;
  return term.parentElement as HTMLElement;
}

function stepLabel(stepId: string): string {
  return SCHEMA.steps.find((s) => s.id === stepId)!.label;
}

describe("the full intake package: schema coverage", () => {
  it("shows every field in the intake schema under its wizard step and label", async () => {
    const intake = toOnboardingIntake(FILLED);
    renderAs(memoryStore(), BUSINESS_OFFICE, <IntakePackage request={{ id: "ONB-1", intake }} />);
    await domainsNamed();
    const pkg = packageIn(document.body);

    for (const field of SCHEMA.fields) {
      expect(SHOWN, `no expected answer for schema field '${field.id}'`).toHaveProperty(field.id);
      const { content } = pkg.step(stepLabel(field.step));
      if (field.type === "dataset-list") {
        expect(
          within(content).getByText(new RegExp(`^${field.label}: 1 of 1`)),
        ).toBeInTheDocument();
        expect(row(content, "Dataset name")).toHaveTextContent(SHOWN[field.id]!);
        continue;
      }
      expect(row(content, field.label), field.id).toHaveTextContent(SHOWN[field.id]!);
    }
  });

  it("shows an older request's steward read-only, marked as from older requests", async () => {
    const intake = toOnboardingIntake(FILLED);
    intake.answers["steward"] = "A. Reyes, RPO Analytics";
    renderAs(memoryStore(), BUSINESS_OFFICE, <IntakePackage request={{ id: "ONB-1", intake }} />);
    await domainsNamed();
    const { content } = packageIn(document.body).step(stepLabel("source"));
    expect(row(content, "Accountable data steward (older requests)")).toHaveTextContent(
      "A. Reyes, RPO Analytics",
    );
  });

  it("shows no steward on a request that has none", async () => {
    const { steward: _none, ...answers } = FILLED;
    const intake = toOnboardingIntake(answers);
    renderAs(memoryStore(), BUSINESS_OFFICE, <IntakePackage request={{ id: "ONB-1", intake }} />);
    await domainsNamed();
    const { content } = packageIn(document.body).step(stepLabel("source"));
    expect(within(content).queryByText(/steward/i)).toBeNull();
  });

  it("shows a field the wizard gains without any change to the package", async () => {
    const schema = cloneSchema(SCHEMA);
    schema.fields.push({
      id: "retention",
      step: "architecture",
      type: "select",
      label: "Retention period",
      required: false,
      default: null,
      options: ["1 year", "7 years"],
    });
    const intake = toOnboardingIntake({ ...FILLED, retention: "7 years" }, schema);
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage request={{ id: "ONB-1", intake }} schema={schema} />,
    );
    await domainsNamed();
    const { content } = packageIn(document.body).step("Architecture");
    expect(row(content, "Retention period")).toHaveTextContent("7 years");
  });

  it("shows a blank answer as Not answered rather than leaving it out", async () => {
    const intake = toOnboardingIntake({
      ...FILLED,
      sourceSystem: "",
      hoursSaved: "",
      datasets: [
        {
          ...(FILLED["datasets"] as OnboardingIntake["datasets"])[0]!,
          sourceSystem: "",
        },
      ],
    });
    renderAs(memoryStore(), BUSINESS_OFFICE, <IntakePackage request={{ id: "ONB-1", intake }} />);
    await domainsNamed();
    const pkg = packageIn(document.body);
    expect(row(pkg.step("Business case").content, "Staff hours saved per year")).toHaveTextContent(
      "Not answered",
    );
    expect(pkg.step("Datasets").content).toHaveTextContent("Source systemNot answered");
    // A request stored before the raw answers were kept still shows every question.
    cleanup();
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage request={{ id: "ONB-2", intake: { ...intake, answers: {} } }} />,
    );
    await domainsNamed();
    const old = packageIn(document.body);
    expect(
      row(old.step("Architecture").content, "How will your team access this data?"),
    ).toHaveTextContent("Not answered");
    expect(old.step("Architecture").button).toHaveTextContent("0 of 2 answered");
  });

  it("counts each step's answers in its heading", async () => {
    const intake = toOnboardingIntake({ ...FILLED, hoursSaved: "" });
    renderAs(memoryStore(), BUSINESS_OFFICE, <IntakePackage request={{ id: "ONB-1", intake }} />);
    await domainsNamed();
    expect(packageIn(document.body).step("Business case").button).toHaveTextContent(
      "4 of 5 answered",
    );
  });
});

describe("the full intake package: architecture", () => {
  it("shows initiative access while dataset ingestion stays with the dataset", async () => {
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage request={{ id: "ONB-1", intake: toOnboardingIntake(FILLED) }} />,
    );
    await domainsNamed();
    const pkg = packageIn(document.body);
    const architecture = pkg.step("Datasets").content;
    expect(within(architecture).getByText("Architecture diagram")).toBeInTheDocument();
    expect(within(architecture).getAllByText("BMF / Business Master File")).toHaveLength(2);
    expect(within(architecture).getByText("Custom path")).toBeInTheDocument();
    expect(architecture).toHaveTextContent("Requires an EDP architecture consultation");
    expect(architecture).toHaveTextContent("Tableau");
    expect(pkg.step("Datasets").content).toHaveTextContent(
      "I don’t know or need something else — consultation required",
    );
    expect(pkg.step("Datasets").content).toHaveTextContent("Query a partner API each morning.");
  });

  it("shows an approved ingestion method on its dataset", async () => {
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage
        request={{
          id: "ONB-1",
          intake: toOnboardingIntake({
            ...FILLED,
            datasets: [
              {
                ...(FILLED["datasets"] as OnboardingIntake["datasets"])[0]!,
                ingestionMethod: "eftu",
              },
            ],
          }),
        }}
      />,
    );
    await domainsNamed();
    const { content } = packageIn(document.body).step("Datasets");
    expect(content).toHaveTextContent("Enterprise File Transfer Utility (EFTU)");
  });

  it("withholds the architecture diagram and verdict until every dataset is complete", async () => {
    const dataset = (FILLED["datasets"] as OnboardingIntake["datasets"])[0]!;
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage
        request={{
          id: "ONB-1",
          intake: toOnboardingIntake({
            ...FILLED,
            datasets: [{ ...dataset, sourceSystem: "", ingestionMethod: "" }],
          }),
        }}
      />,
    );
    await domainsNamed();
    const architecture = packageIn(document.body).step("Datasets").content;
    expect(architecture).toHaveTextContent(
      "The architecture diagram appears once each dataset has a source system and ingestion method.",
    );
    expect(within(architecture).queryByText("Architecture diagram")).not.toBeInTheDocument();
    expect(architecture).not.toHaveTextContent("no architecture consultation");
    expect(architecture).not.toHaveTextContent("Requires an EDP architecture consultation");
    expect(architecture).not.toHaveTextContent("EFTU");
  });

  it("shows the delivery and sizing notes the wizard derives", async () => {
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage request={{ id: "ONB-1", intake: toOnboardingIntake(FILLED) }} />,
    );
    await domainsNamed();
    const pkg = packageIn(document.body);
    expect(pkg.step("Delivery support").content).toHaveTextContent(
      "EDP platform engineering requested",
    );
    expect(row(pkg.step("Sizing").content, "Sizing estimate")).toHaveTextContent(/ROI \d/);
  });

  it("has a labelled attachments section that says none can be added yet", async () => {
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage request={{ id: "ONB-1", intake: toOnboardingIntake(FILLED) }} />,
    );
    await domainsNamed();
    const attachments = screen.getByRole("region", { name: "Attachments" });
    expect(attachments).toHaveTextContent(
      /STUB: Attachments can't be added to an intake package yet/,
    );
    expect(within(attachments).queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("the full intake package: sections", () => {
  it("opens and closes each step from the keyboard-reachable step button", async () => {
    renderAs(
      memoryStore(),
      BUSINESS_OFFICE,
      <IntakePackage request={{ id: "ONB-1", intake: toOnboardingIntake(FILLED) }} />,
    );
    await domainsNamed();
    const pkg = packageIn(document.body);
    const { button, content } = pkg.step("Architecture");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(content).not.toBeVisible();
    fireEvent.click(button);
    expect(pkg.step("Architecture").button).toHaveAttribute("aria-expanded", "true");
    expect(pkg.step("Architecture").content).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open all steps" }));
    for (const step of SCHEMA.steps.filter((s) => s.id !== "review")) {
      expect(pkg.step(step.label).button).toHaveAttribute("aria-expanded", "true");
    }
    fireEvent.click(screen.getByRole("button", { name: "Close all steps" }));
    expect(pkg.step("Initiative").button).toHaveAttribute("aria-expanded", "false");
  });
});

describe.each(BACKENDS)("who sees the full package ($label backend)", ({ make }) => {
  async function submitted() {
    const store = make();
    const created = await as(store, PROVIDER).submit(toOnboardingIntake(FILLED));
    return { store, created };
  }

  /** Every answer in the package, as the reviewer or provider reads it. */
  async function expectFullPackage(scope: HTMLElement) {
    await domainsNamed(scope);
    const pkg = packageIn(scope);
    for (const field of SCHEMA.fields) {
      const { content } = pkg.step(stepLabel(field.step));
      if (field.type === "dataset-list") {
        expect(row(content, "Dataset owner 1")).toHaveTextContent(
          "Olive Owner (olive.owner@example.gov)",
        );
        continue;
      }
      expect(row(content, field.label), field.id).toHaveTextContent(SHOWN[field.id]!);
    }
    expect(pkg.step("Datasets").content).toHaveTextContent("Query a partner API each morning.");
  }

  it("the business & ROI reviewer sees every answer", async () => {
    const { store, created } = await submitted();
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    await expectFullPackage(await screen.findByRole("article", { name: new RegExp(created.id) }));
  });

  it("the CCB sees every answer", async () => {
    const { store, created } = await submitted();
    await as(store, BUSINESS_OFFICE).decide(created.id, { type: "approve" });
    renderAs(store, CCB, <OnboardingInbox role="ccb" />);
    await expectFullPackage(await screen.findByRole("article", { name: new RegExp(created.id) }));
  });

  it("the data provider sees the same package on their own request", async () => {
    const { store, created } = await submitted();
    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    await expectFullPackage(
      await screen.findByRole("article", { name: new RegExp(created.title) }),
    );
  });

  it("someone unrelated sees nothing of it", async () => {
    const { store, created } = await submitted();
    expect((await as(store, STRANGER).get(created.id)) ?? null).toBeNull();
    expect(await as(store, STRANGER).listMine()).toEqual([]);
    renderAs(store, STRANGER, <MyOnboardingRequests />);
    await screen.findByText(/haven't submitted an onboarding request/i);
    expect(screen.queryByText("Collections case signals")).not.toBeInTheDocument();
  });

  it("marks what the resubmission changed in place, beside #227's new-response panel", async () => {
    const { store, created } = await resubmitted(make());

    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    await domainsNamed(item);
    expect(
      within(item).getByRole("region", { name: /new response from the data provider/ }),
    ).toHaveTextContent("Nine, the ROI is restated, the ledger is added and Otto has left.");

    const pkg = packageIn(item);
    const business = pkg.step("Business case");
    expect(business.button).toHaveAttribute("aria-expanded", "true");
    expect(row(business.content, "Estimated annual benefit (USD)")).toHaveTextContent(
      "$2MChanged in the resubmission, was “$1,250,000”",
    );
    expect(row(business.content, "Business justification")).not.toHaveTextContent("Changed");
    const datasets = pkg.step("Datasets");
    expect(datasets.button).toHaveAttribute("aria-expanded", "true");
    expect(datasets.button).toHaveTextContent("changed in the resubmission");
    expect(row(datasets.content, "Dataset tag")).toHaveTextContent(
      "case_signals_v2Changed in the resubmission, was “case_signals”",
    );
    expect(within(datasets.content).getAllByText("Dataset name")).toHaveLength(2);
    expect(datasets.content).toHaveTextContent("Datasets: 2 of 2Added in the resubmission");
    expect(row(datasets.content, "Removed owner")).toHaveTextContent(
      "Otto Second (otto.second@example.gov)Removed in the resubmission",
    );
    expect(row(datasets.content, "Dataset owner 1")).not.toHaveTextContent("Changed");
    const workspace = pkg.step("Workspace");
    expect(
      row(workspace.content, "How many people will work on this initiative?"),
    ).toHaveTextContent("9Changed in the resubmission, was “6”");
    expect(
      row(
        workspace.content,
        "Must your team's code or work products be hidden from other EDP teams?",
      ),
    ).not.toHaveTextContent("Changed");
    expect(row(workspace.content, "Workspace separation reason or constraint")).toHaveTextContent(
      "Investigative methods must remain within the named team.",
    );
    expect(pkg.step("Architecture").button).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a dataset the resubmission removed where the datasets are", async () => {
    const store = make();
    const created = await as(store, PROVIDER).submit(
      toOnboardingIntake({ ...FILLED, datasets: [...FILLED_DATASETS, LEDGER] }),
    );
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Is the ledger needed?",
    });
    await as(store, PROVIDER).resubmit(created.id, {
      answer: "No, dropped it.",
      intake: { ...created.intake, datasets: [created.intake.datasets[0]!] },
    });

    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    await domainsNamed(item);
    const { content } = packageIn(item).step("Datasets");
    expect(content).toHaveTextContent(
      "Removed in the resubmissionCollections ledger (collections_ledger); owners: Lee Ledger (lee.ledger@example.gov)",
    );
    expect(item).toHaveTextContent("Removed dataset: Collections ledger (collections_ledger).");
  });
});

/** The first dataset of FILLED with a second owner, so one can be removed. */
const FILLED_DATASETS = [
  {
    ...(FILLED["datasets"] as OnboardingIntake["datasets"])[0]!,
    owners: [
      { name: "Olive Owner", email: "olive.owner@example.gov" },
      { name: "Otto Second", email: "otto.second@example.gov" },
    ],
  },
];
const LEDGER = {
  name: "Collections ledger",
  sourceSystem: "IMF / Individual Master File",
  domain: "individual-filing",
  ingestionMethod: "eftu",
  datasetTag: "collections_ledger",
  owners: [{ name: "Lee Ledger", email: "lee.ledger@example.gov" }],
};

/**
 * A request the business office sent back and the provider resubmitted with
 * an edited ROI answer, team size and dataset tag, an added dataset and a
 * removed owner (#222).
 */
async function resubmitted(store: DataStore) {
  const created = await as(store, PROVIDER).submit(
    toOnboardingIntake({ ...FILLED, datasets: FILLED_DATASETS }),
  );
  await as(store, BUSINESS_OFFICE).decide(created.id, {
    type: "send-back",
    to: "submitted",
    note: "Is the team really six people?",
  });
  const [dataset] = created.intake.datasets;
  await as(store, PROVIDER).resubmit(created.id, {
    answer: "Nine, the ROI is restated, the ledger is added and Otto has left.",
    intake: {
      ...created.intake,
      annualBenefit: 2_000_000,
      datasets: [
        { ...dataset!, datasetTag: "case_signals_v2", owners: [dataset!.owners[0]!] },
        LEDGER,
      ],
      workspaceNeeds: { isolation: FILLED["isolation"] as string, teamSize: 9 },
    },
  });
  return { store, created };
}

/**
 * The server's in-memory copy of the onboarding tables (#193), loaded the way
 * the snapshot cache loads them: every row of each table, in its order.
 */
async function snapshotOf(warehouse: SqliteWarehouse, names: ReturnType<typeof createStoreNames>) {
  const tables = new Map<string, Record<string, unknown>[]>();
  for (const table of SNAPSHOT_TABLES.filter((t) => t.area === "onboarding")) {
    const { rows } = await warehouse.client.execute<Record<string, unknown>>(
      {
        statement:
          `SELECT * FROM ${names.table(table.schema, table.table)}` +
          (table.orderBy ? ` ORDER BY ${table.orderBy}` : ""),
      },
      { readId: "snapshot" },
    );
    tables.set(`${table.schema}.${table.table}`, rows);
  }
  return {
    table: (schema: string, table: string) => tables.get(`${schema}.${table}`) ?? [],
    stats: () => ({}) as never,
  };
}

describe("the in-memory copy shows the same package as Delta (#193, #231 follow-up)", () => {
  it("renders identical full-package text for a resubmitted request from both reads", async () => {
    const { store, warehouse, names } = deltaHarness();
    const { created } = await resubmitted(store);
    const read = createAppRegistry().findRead("onboarding", "request")!;
    const user = {
      principalId: BUSINESS_OFFICE.principalId,
      displayName: BUSINESS_OFFICE.name,
      email: BUSINESS_OFFICE.email ?? "",
      isAdmin: false,
      onboardingReviewerRoles: ["business-office" as const],
    };
    const viaSql = (await read.run({
      query: { id: created.id },
      user,
      names,
      read: async (statement) =>
        (await warehouse.client.execute(statement, { readId: "sql" })).rows as never,
    })) as OnboardingRequest;
    const viaSnapshot = read.snapshot!({
      query: { id: created.id },
      user,
      names,
      snapshot: (await snapshotOf(warehouse, names)) as never,
    }) as OnboardingRequest;
    // The snapshot holds the added dataset and not the removed owner.
    expect(viaSnapshot.intake.datasets.map((d) => d.name)).toEqual([
      "Case signals",
      "Collections ledger",
    ]);
    expect(viaSnapshot.intake.datasets[0]!.owners.map((o) => o.name)).toEqual(["Olive Owner"]);

    const text: string[] = [];
    for (const request of [viaSql, viaSnapshot]) {
      const changes = request.decisions.at(-1)?.resubmission?.changes;
      renderAs(
        memoryStore(),
        BUSINESS_OFFICE,
        <IntakePackage request={request} changes={changes} />,
      );
      await domainsNamed();
      fireEvent.click(screen.getByRole("button", { name: "Open all steps" }));
      text.push(packageIn(document.body).section.textContent ?? "");
      cleanup();
    }
    expect(text[0]).toContain("Added in the resubmission");
    expect(text[0]).toContain("Removed in the resubmission");
    expect(text[1]).toBe(text[0]);
    expect(viaSnapshot).toEqual(viaSql);
  });
});

describe("both backends show the same package", () => {
  it("renders identical text for the same intake", async () => {
    const text: string[] = [];
    for (const { make } of BACKENDS) {
      const store = make();
      const created = await as(store, PROVIDER).submit(toOnboardingIntake(FILLED));
      renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
      const item = await screen.findByRole("article", { name: new RegExp(created.id) });
      await domainsNamed(item);
      text.push(packageIn(item).section.textContent ?? "");
      cleanup();
    }
    expect(text[0]).toContain("I don’t know or need something else — consultation required");
    expect(text[1]).toBe(text[0]);
  });
});
