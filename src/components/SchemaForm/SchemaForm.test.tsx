import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchemaForm, edpWidgets, type DynamicOption } from "./index";
import {
  DATASET_TAG_HINT,
  assembleRequest,
  estimateSizing,
  loadSchema,
  type IntakeState,
} from "../../schema";
import { BAD_TAGS, GOOD_TAGS } from "../../schema/dataset-tag.fixtures";
import { toOnboardingIntake } from "../../data/onboarding/intake";

afterEach(cleanup);

const schema = loadSchema();

// The runtime domain list the real screen feeds in (from window.AppData); a
// couple of entries is enough to exercise the dynamic <select>.
const DOMAINS: DynamicOption[] = [
  { value: "individual-filing", label: "Individual Filing" },
  { value: "enforcement-collections", label: "Enforcement & Collections" },
];

function renderForm(overrides: Partial<Parameters<typeof SchemaForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <SchemaForm
      schema={schema}
      widgets={edpWidgets}
      dynamicOptions={{ domains: DOMAINS }}
      onSubmit={onSubmit}
      onCancel={onCancel}
      initialValues={buildDefaults()}
      {...overrides}
    />,
  );
  return { onSubmit, onCancel };
}

// Continue button for the current step.
function next(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
}

function control(label: string | RegExp): HTMLElement {
  const match = screen.getAllByLabelText(label).find((element) => element.tagName !== "BUTTON");
  if (!match) throw new Error(`No form control found for ${String(label)}`);
  return match;
}

// Fill step 0 (source profile) so its gate opens, then advance.
function completeSourceStep() {
  fireEvent.change(control(/initiative name/i), {
    target: { value: "Preparer e-file submissions (curated)" },
  });
  fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
  fireEvent.click(next());
}

// Fill the #86 datasets step (one dataset, one owner) and the workspace-needs
// step so their gates open, advancing past both.
function completeDatasetsAndWorkspace() {
  fireEvent.change(control("Dataset 1 name"), { target: { value: "Case signals" } });
  fireEvent.change(control("Dataset 1 source system"), {
    target: { value: "IMF / Individual Master File" },
  });
  fireEvent.change(control("Dataset 1 domain"), {
    target: { value: "individual-filing" },
  });
  fireEvent.change(control("Dataset 1 tag"), { target: { value: "case_signals" } });
  fireEvent.change(control("Dataset 1 ingestion method"), { target: { value: "eftu" } });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByRole("radio", {
      name: /someone else/i,
    }),
  );
  fireEvent.change(
    within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByLabelText("Owner's name"),
    {
      target: { value: "Olive Owner" },
    },
  );
  fireEvent.change(
    within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByLabelText(
      "Owner's email",
    ),
    {
      target: { value: "olive.owner@example.gov" },
    },
  );
  fireEvent.click(next());
  fireEvent.change(control(/code or work products/i), {
    target: { value: "Not sure — ask EDP staff to assess" },
  });
  fireEvent.change(control(/how many people/i), { target: { value: "6" } });
  fireEvent.click(next());
}

const VALID_DATASET = {
  name: "Case signals",
  sourceSystem: "IMF / Individual Master File",
  domain: "individual-filing",
  ingestionMethod: "eftu",
  datasetTag: "case_signals",
  owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
};

// The full initial-values object (mirrors the schema defaults + domain seed) so
// a step's gate can be probed independently via the `initialValues` override.
function buildDefaults(overrides: IntakeState = {}): IntakeState {
  return {
    dataName: "",
    initiativeOwner: { kind: "self" },
    sourceSystem: "IMF / Individual Master File",
    domain: "individual-filing",
    sensitivity: "SBU (FTI)",
    pattern: "eftu",
    access: "dbx",
    engModel: "self",
    levers: ["fraud"],
    useCase: "",
    outcome: "fraud",
    annualBenefit: 750000,
    hoursSaved: 1200,
    sizeGb: 500,
    freq: "Daily",
    complexity: "Moderate",
    users: 40,
    datasets: [VALID_DATASET],
    isolation: "Not sure",
    teamSize: 6,
    estimated: false,
    ...overrides,
  };
}

describe("SchemaForm — field type rendering", () => {
  it("explains the initiative sensitivity choices", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Help for Data sensitivity" }));
    expect(screen.getByRole("dialog", { name: "About Data sensitivity" }).textContent).toMatch(
      /extra restrictions.*review/i,
    );
  });

  it("keeps the initiative page focused on name and owner", () => {
    renderForm();
    expect(control(/initiative name/i)).toBeTruthy();
    expect(screen.getByRole("group", { name: /initiative point of contact/i })).toBeTruthy();
    expect(screen.queryByLabelText(/source system/i)).toBeNull();
  });

  it("renders card-select (PatternCards) and a schema-driven note widget", () => {
    renderForm();
    completeSourceStep();
    // Access remains an initiative-level architecture choice.
    expect(screen.getByRole("button", { name: /All within Databricks/i })).toBeTruthy();
  });

  it("renders number + textarea + multi-card on the business step", () => {
    renderForm();
    completeSourceStep(); // -> architecture
    fireEvent.click(next()); // -> delivery (defaults valid)
    fireEvent.click(next()); // -> business
    expect(control(/business justification/i).tagName).toBe("TEXTAREA");
    const benefit = control(/estimated annual benefit/i) as HTMLInputElement;
    expect(benefit.type).toBe("text");
    expect(benefit.value).toBe("750000");
    // ROI levers render as multi-card toggles
    expect(
      screen.getByRole("button", { name: /Reduce fraud and improper payments/i }),
    ).toBeTruthy();
  });
});

// Source step, then architecture and delivery on their defaults, to business.
function goToBusinessStep() {
  completeSourceStep();
  fireEvent.click(next()); // -> delivery
  fireEvent.click(next()); // -> business
}

describe("SchemaForm — number fields", () => {
  const benefitBox = () => control(/estimated annual benefit/i) as HTMLInputElement;
  const hoursBox = () => control(/staff hours saved/i) as HTMLInputElement;

  it("renders a number field as a text box with a numeric keyboard, not a spinner", () => {
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();
    expect(benefit.type).toBe("text");
    // The currency field takes cents; the hours field takes whole numbers.
    expect(benefit.inputMode).toBe("decimal");
    expect(hoursBox().inputMode).toBe("numeric");
    expect(benefit.hasAttribute("min")).toBe(false);
    expect(benefit.hasAttribute("step")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Help for Staff hours saved per year" }));
    expect(
      screen.getByRole("dialog", { name: "About Staff hours saved per year" }).textContent,
    ).toMatch(/contractor.*operations and maintenance/i);
  });

  it("lets the user clear a number field and type a new value", async () => {
    const user = userEvent.setup();
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();
    expect(benefit.value).toBe("750000");
    await user.clear(benefit);
    expect(benefit.value).toBe("");
    await user.type(benefit, "425000");
    expect(benefit.value).toBe("425000");
    await user.clear(hoursBox());
    expect(hoursBox().value).toBe("");
    await user.tab();
    expect(hoursBox().value).toBe("");
  });

  it("keeps what the user typed, separators and all, and accepts it", async () => {
    const user = userEvent.setup();
    renderForm();
    goToBusinessStep();
    fireEvent.change(control(/business justification/i), {
      target: { value: "Score preparer risk weekly instead of quarterly." },
    });
    for (const [box, typed] of [
      [benefitBox(), "$750,000"],
      [hoursBox(), "1 200"],
    ] as const) {
      await user.clear(box);
      await user.type(box, typed);
      await user.tab();
      expect(box.value).toBe(typed);
      expect(box.getAttribute("aria-invalid")).toBeNull();
    }
    await user.clear(benefitBox());
    await user.type(benefitBox(), "1,200.50");
    await user.click(next());
    expect(control("Dataset 1 name")).toBeTruthy(); // advanced to datasets
  });

  it.each(["abc", "12abc", "1.2.3", "$"])("says '%s' must be a number", async (typed) => {
    const user = userEvent.setup();
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();
    await user.clear(benefit);
    await user.type(benefit, typed);
    expect(screen.queryByText(/must be a number/)).toBeNull(); // not while typing
    await user.tab();
    expect(benefit.value).toBe(typed);
    expect(benefit.getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(benefit.getAttribute("aria-describedby") ?? "");
    expect(error?.textContent).toBe("Estimated annual benefit (USD) must be a number.");
  });

  it("rejects a $ outside a currency field, and a fraction in a whole-number field", async () => {
    const user = userEvent.setup();
    renderForm();
    goToBusinessStep();
    const hours = hoursBox();
    await user.clear(hours);
    await user.type(hours, "$1,200");
    await user.tab();
    expect(screen.getByText("Staff hours saved per year must be a number.")).toBeTruthy();
    await user.clear(hours);
    await user.type(hours, "1.5");
    await user.tab();
    expect(screen.getByText("Staff hours saved per year must be a whole number.")).toBeTruthy();
  });

  it("blocks Continue on an optional number that isn't a number", async () => {
    const user = userEvent.setup();
    renderForm({
      initialValues: buildDefaults({
        useCase: "This justification is clearly longer than ten characters.",
      }),
    });
    goToBusinessStep();
    await user.clear(hoursBox());
    await user.type(hoursBox(), "lots");
    await user.click(next());
    const summary = screen.getByRole("alert", { name: /validation errors/i });
    expect(within(summary).getByText("Staff hours saved per year must be a number.")).toBeTruthy();
    expect(hoursBox()).toBeTruthy(); // still on the business step
  });

  it("requires a positive annual benefit", async () => {
    const user = userEvent.setup();
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();
    await user.clear(benefit);
    await user.click(next());
    expect(benefit.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getAllByText(/estimated annual benefit \(usd\) is required/i)).toHaveLength(2);
    expect(screen.queryByText(/must be more than 0/i)).toBeNull();

    await user.type(benefit, "0");
    expect(benefit.value).toBe("0");
    expect(screen.getAllByText("Estimated annual benefit (USD) must be more than 0.")).toHaveLength(
      2,
    );
    await user.clear(benefit);
    await user.type(benefit, "-5");
    expect(benefit.value).toBe("-5");
    expect(screen.getAllByText("Estimated annual benefit (USD) must be more than 0.")).toHaveLength(
      2,
    );
  });

  it("renders a number field with no default and no saved value empty, without an error", async () => {
    const user = userEvent.setup();
    renderForm({ initialValues: buildDefaults({ teamSize: undefined }) });
    goToBusinessStep();
    fireEvent.change(control(/business justification/i), {
      target: { value: "This justification is clearly longer than ten characters." },
    });
    fireEvent.click(next()); // -> datasets (valid)
    fireEvent.click(next()); // -> workspace
    const team = control(/how many people/i) as HTMLInputElement;
    expect(team.value).toBe("");
    expect(team.inputMode).toBe("numeric");
    expect(team.getAttribute("aria-invalid")).toBeNull();
    await user.click(next());
    expect(team.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getAllByText("Enter how many people will work on this initiative.").length,
    ).toBeGreaterThan(0);
    // The rule's own message also covers text that isn't a number.
    await user.type(team, "six");
    expect(
      screen.getAllByText("Enter how many people will work on this initiative.").length,
    ).toBeGreaterThan(0);
  });

  it("clears and reloads the workspace and sizing number fields too", async () => {
    const user = userEvent.setup();
    renderForm({
      initialValues: buildDefaults({
        useCase: "This justification is clearly longer than ten characters.",
        teamSize: 7,
        sizeGb: 321,
        users: 12,
      }),
    });
    goToBusinessStep();
    fireEvent.click(next()); // -> datasets
    fireEvent.click(next()); // -> workspace
    const team = control(/how many people/i) as HTMLInputElement;
    expect(team.value).toBe("7");
    await user.clear(team);
    expect(team.value).toBe("");
    await user.type(team, "7");
    fireEvent.click(next()); // -> sizing
    for (const [label, saved] of [
      [/data volume/i, "321"],
      [/business users needing to query/i, "12"],
    ] as const) {
      const input = control(label) as HTMLInputElement;
      expect(input.value).toBe(saved);
      await user.clear(input);
      expect(input.value).toBe("");
    }
    // Data volume takes decimals.
    const volume = control(/data volume/i) as HTMLInputElement;
    expect(volume.inputMode).toBe("decimal");
    await user.type(volume, "1.5");
    await user.tab();
    expect(volume.value).toBe("1.5");
    expect(volume.getAttribute("aria-invalid")).toBeNull();
  });

  it("shows a saved number value", () => {
    renderForm({ initialValues: buildDefaults({ annualBenefit: 425000, hoursSaved: 80 }) });
    goToBusinessStep();
    expect(benefitBox().value).toBe("425000");
    expect(hoursBox().value).toBe("80");
  });

  it("hands the intake numbers, and leaves an unanswered optional number out", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    goToBusinessStep();
    fireEvent.change(control(/business justification/i), {
      target: { value: "Score preparer risk weekly instead of quarterly." },
    });
    await user.clear(benefitBox());
    await user.type(benefitBox(), "$1,250,000");
    await user.clear(hoursBox());
    fireEvent.click(next()); // optional hours left empty: the step still advances
    completeDatasetsAndWorkspace();
    const volume = control(/data volume/i);
    await user.clear(volume);
    await user.type(volume, "2,500.5");
    // Fake timers only for the estimator's delay; user-event stalls under them.
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
      act(() => vi.advanceTimersByTime(900));
      fireEvent.click(next());
      fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));
    } finally {
      vi.useRealTimers();
    }
    const intake = toOnboardingIntake(onSubmit.mock.calls[0]?.[0] as IntakeState);
    expect(intake.annualBenefit).toBe(1250000);
    expect(intake.workspaceNeeds.teamSize).toBe(6);
    expect(intake.answers["annualBenefit"]).toBe(1250000);
    expect(intake.answers["sizeGb"]).toBe(2500.5);
    expect(intake.answers["users"]).toBe(40); // the schema default
    expect("hoursSaved" in intake.answers).toBe(false);
  });
});

describe("SchemaForm — per-step Next gating (canAdvance parity)", () => {
  it("keeps Continue actionable while blocking an invalid source step", () => {
    renderForm();
    expect(next().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tell us about the initiative" })).toBeTruthy();
    fireEvent.change(control(/initiative name/i), {
      target: { value: "Curated dataset" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "How will your team access this data?" }),
    ).toBeTruthy();
  });

  it("keeps summary links in the wizard, retains values, and announces every failed attempt", () => {
    window.history.replaceState(null, "", "#onboarding");
    renderForm({ initialValues: buildDefaults({ initiativeOwner: null }) });
    expect(screen.queryByLabelText("Validation errors")).toBeNull();

    const name = control(/initiative name/i);
    expect(name.getAttribute("aria-invalid")).toBeNull();
    fireEvent.blur(name);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("intake-dataName-error");
    fireEvent.change(name, { target: { value: "Saved initiative" } });

    fireEvent.click(next());
    const summary = screen.getByRole("alert", { name: "Validation errors" });
    expect(document.activeElement).toBe(summary);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    const ownerLink = screen.getByRole("link", { name: "Choose who owns the initiative." });
    expect(ownerLink.getAttribute("href")).toBe("#intake-initiativeOwner-kind");

    const hash = window.location.hash;
    fireEvent.click(ownerLink);
    expect(window.location.hash).toBe(hash);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /myself/i }));
    expect((control(/initiative name/i) as HTMLInputElement).value).toBe("Saved initiative");

    fireEvent.click(next());
    expect(document.activeElement).toBe(summary);
  });

  it("keeps focus and every keystroke in a field fixed after a failed Continue (#179)", async () => {
    const user = userEvent.setup();
    renderForm({ initialValues: buildDefaults({ initiativeOwner: null }) });
    await user.click(next());
    const summary = screen.getByRole("alert", { name: "Validation errors" });
    expect(document.activeElement).toBe(summary);

    await user.click(within(summary).getByRole("link", { name: /initiative name/i }));
    const name = control(/initiative name/i);
    expect(document.activeElement).toBe(name);
    await user.keyboard("Preparer e-file");
    expect(document.activeElement).toBe(name);
    expect((name as HTMLInputElement).value).toBe("Preparer e-file");
    // Fixing an answer does not steal focus.
    await user.tab();
    expect(document.activeElement).not.toBe(summary);

    await user.click(next());
    expect(document.activeElement).toBe(screen.getByRole("alert", { name: "Validation errors" }));
  });

  it("gates the business step on justification length and lever count while benefit may be unknown", () => {
    renderForm();
    completeSourceStep();
    fireEvent.click(next()); // delivery
    fireEvent.click(next()); // business (levers default ['fraud'], benefit default 750000)
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What mission value does this data create?" }),
    ).toBeTruthy();
    fireEvent.change(control(/business justification/i), {
      target: { value: "This justification is clearly longer than ten characters." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Reduce fraud and improper payments/i }));
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(control(/business justification/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reduce fraud and improper payments/i }));
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "Which input datasets are you bringing into EDP?" }),
    ).toBeTruthy();
  });

  it("gates the architecture step on the initiative access method", () => {
    renderForm({
      initialValues: buildDefaults({ dataName: "X", access: "" }),
    });
    fireEvent.click(next()); // source -> architecture
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How will your team access this data?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /All within Databricks/i }));
    fireEvent.click(next());
    expect(screen.getByRole("heading", { name: "Who builds the pipelines?" })).toBeTruthy();
  });

  it("links card-group errors only to focusable targets that exist", () => {
    renderForm({
      initialValues: buildDefaults({ dataName: "X", access: "" }),
    });
    fireEvent.click(next());
    fireEvent.click(next());

    const summary = screen.getByRole("alert", { name: "Validation errors" });
    const links = within(summary).getAllByRole("link");
    expect(links).toHaveLength(1);
    for (const link of links) {
      const target = document.querySelector(link.getAttribute("href") ?? "missing");
      expect(target).not.toBeNull();
      expect(target?.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("gates the delivery-support step until a delivery model is chosen", () => {
    renderForm({ initialValues: buildDefaults({ dataName: "X", engModel: "" }) });
    fireEvent.click(next()); // source -> architecture (eftu/dbx defaults valid)
    fireEvent.click(next()); // architecture -> delivery
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Who builds the pipelines?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /We have our own resources/i }));
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "What mission value does this data create?" }),
    ).toBeTruthy();
  });

  it("leaves the review step ungated — Submit is always available", () => {
    renderForm({
      initialValues: buildDefaults({
        dataName: "X",
        useCase: "A sufficiently long business justification.",
        estimated: true,
      }),
    });
    fireEvent.click(next()); // architecture
    fireEvent.click(next()); // delivery
    fireEvent.click(next()); // business
    fireEvent.click(next()); // datasets (valid in initialValues)
    fireEvent.click(next()); // workspace (valid in initialValues)
    fireEvent.click(next()); // sizing (estimated already true)
    fireEvent.click(next()); // review
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
    const submit = screen.getByRole("button", {
      name: /submit data onboarding request/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("shows that a blank optional primary outcome was not chosen on review", () => {
    renderForm({
      initialValues: buildDefaults({
        dataName: "X",
        useCase: "A sufficiently long business justification.",
        outcome: "",
        estimated: true,
      }),
    });
    for (let step = 0; step < 7; step += 1) fireEvent.click(next());
    expect(screen.getByText("Mission value — Primary outcome: not chosen")).toBeTruthy();
    expect(screen.queryByText(/Mission value — Reduce fraud and improper payments/)).toBeNull();
  });

  it("gates the sizing step until the estimator has run (isTrue estimated)", () => {
    vi.useFakeTimers();
    try {
      renderForm();
      completeSourceStep(); // architecture
      fireEvent.click(next()); // delivery
      fireEvent.click(next()); // business
      fireEvent.change(control(/business justification/i), {
        target: { value: "A sufficiently long business justification." },
      });
      fireEvent.click(next()); // datasets
      completeDatasetsAndWorkspace(); // -> sizing
      fireEvent.click(next());
      expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Estimate initiative capacity" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
      act(() => vi.advanceTimersByTime(900));
      // changing a sizing input invalidates the estimate (resets `estimated`)
      fireEvent.change(control(/business users needing to query/i), {
        target: { value: "80" },
      });
      fireEvent.click(next());
      expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Estimate initiative capacity" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
      act(() => vi.advanceTimersByTime(900));
      fireEvent.click(next());
      expect(screen.getByRole("heading", { name: "Review the onboarding package" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SchemaForm — card-select / multi-card selection", () => {
  it("toggles ROI levers independently (multi-card is multi-choice)", () => {
    renderForm();
    completeSourceStep();
    fireEvent.click(next());
    fireEvent.click(next()); // business
    const fraud = screen.getByRole("button", { name: /Reduce fraud and improper payments/i });
    const taxgap = screen.getByRole("button", { name: /Reduce the tax gap/i });
    expect(fraud.getAttribute("aria-pressed")).toBe("true"); // default ['fraud']
    expect(taxgap.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(taxgap);
    expect(fraud.getAttribute("aria-pressed")).toBe("true");
    expect(taxgap.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("SchemaForm — sizing widget renders golden figures", () => {
  // Fixed expected numbers for the default sizing inputs (500 GB, Daily,
  // Moderate, 40 users). Hand-computed from the sizing heuristic, NOT read back
  // from estimateSizing, so a shared-helper regression is visible not mirrored.
  const GOLDEN = {
    tier: "Medium — dedicated pipeline",
    cluster: "4 × Standard_DS5",
    warehouse: "Small serverless",
    storageTb: 0.8,
    dbu: 740,
    monthlyCost: 4410,
    annualCost: 52920,
    confidence: 92,
  };

  it("the helper still computes the golden numbers", () => {
    expect(
      estimateSizing(schema, { sizeGb: 500, freq: "Daily", complexity: "Moderate", users: 40 }),
    ).toEqual({
      tier: GOLDEN.tier,
      cluster: GOLDEN.cluster,
      warehouse: GOLDEN.warehouse,
      storageTb: GOLDEN.storageTb,
      dbu: GOLDEN.dbu,
      monthlyCost: GOLDEN.monthlyCost,
      annualCost: GOLDEN.annualCost,
      confidence: GOLDEN.confidence,
    });
  });

  it("renders the golden figures in the estimator panel", () => {
    vi.useFakeTimers();
    try {
      renderForm();
      completeSourceStep();
      fireEvent.click(next()); // delivery
      fireEvent.click(next()); // business
      fireEvent.change(control(/business justification/i), {
        target: { value: "A sufficiently long business justification." },
      });
      fireEvent.click(next()); // datasets
      completeDatasetsAndWorkspace(); // -> sizing (defaults: 500 GB, Daily, Moderate, 40 users)
      fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
      act(() => vi.advanceTimersByTime(900));

      expect(screen.getByText(`Preliminary capacity estimate — ${GOLDEN.tier}`)).toBeTruthy();
      expect(screen.getAllByText(/EDP staff will revalidate/i).length).toBeGreaterThan(0);
      expect(screen.getByText(`${GOLDEN.storageTb} TB`)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cost, capacity, and ROI pending when any sizing basis is unknown", () => {
    vi.useFakeTimers();
    try {
      renderForm({
        initialValues: buildDefaults({
          dataName: "Known initiative",
          steward: "Known contact",
          useCase: "A sufficiently detailed business justification.",
          sizeGb: null,
          freq: "Not sure",
        }),
      });
      for (let i = 0; i < 6; i++) fireEvent.click(next());
      fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
      act(() => vi.advanceTimersByTime(900));
      expect(screen.getByText(/Estimate pending — EDP staff will refine/i)).toBeTruthy();
      expect(screen.queryByText(/Preliminary monthly cost/i)).toBeNull();
      fireEvent.click(next());
      expect(screen.getByText("Initiative sizing — Pending")).toBeTruthy();
      expect(screen.getAllByText("Pending").length).toBeGreaterThanOrEqual(3);
      expect(screen.getByText(/EDP business office reviews business value/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SchemaForm — completing the flow assembles the identical request", () => {
  it("collects values that produce the same object as assembleRequest", () => {
    vi.useFakeTimers();
    let submitted: IntakeState | null = null;
    try {
      render(
        <SchemaForm
          schema={schema}
          widgets={edpWidgets}
          dynamicOptions={{ domains: DOMAINS }}
          onSubmit={(v) => {
            submitted = v;
          }}
          onCancel={() => {}}
          initialValues={buildDefaults()}
        />,
      );

      // step 0: source
      fireEvent.change(control(/initiative name/i), {
        target: { value: "Preparer e-file submissions (curated)" },
      });
      fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
      fireEvent.click(next());
      // step 1: architecture (keep defaults eftu/dbx)
      fireEvent.click(next());
      // step 2: delivery (keep default self)
      fireEvent.click(next());
      // step 3: business
      fireEvent.change(control(/business justification/i), {
        target: { value: "Score preparer risk weekly instead of quarterly." },
      });
      fireEvent.click(next());
      // steps 4–5: datasets & owners, workspace needs (#86)
      completeDatasetsAndWorkspace();
      // step 6: sizing (keep defaults) -> run estimate
      fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
      act(() => vi.advanceTimersByTime(900));
      fireEvent.click(next());
      // step 7: review -> submit
      fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));
    } finally {
      vi.useRealTimers();
    }

    expect(submitted).not.toBeNull();
    const values = submitted as unknown as IntakeState;

    // The collected values carry the user edits on top of the schema defaults.
    const expectedValues: IntakeState = {
      dataName: "Preparer e-file submissions (curated)",
      initiativeOwner: { kind: "self" },
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      sensitivity: "SBU (FTI)",
      pattern: "eftu",
      access: "dbx",
      engModel: "self",
      levers: ["fraud"],
      useCase: "Score preparer risk weekly instead of quarterly.",
      outcome: "fraud",
      annualBenefit: 750000,
      hoursSaved: 1200,
      sizeGb: 500,
      freq: "Daily",
      complexity: "Moderate",
      users: 40,
      datasets: [VALID_DATASET],
      isolation: "Not sure — ask EDP staff to assess",
      teamSize: 6,
      estimated: true,
    };
    expect(values).toEqual(expectedValues);

    // ...and feeding the collected values through assembleRequest yields the
    // exact request for the all-defaults / all-approved path (complement to the
    // non-default golden in onboarding.parity.test.tsx). Asserted against a
    // literal object — the no-consult / no-platform branch drops the two
    // conditional subrequests and marks business review "active".
    const req = assembleRequest(schema, { values, domainName: "Individual Filing", num: 2085 });
    expect(req).toEqual({
      id: "REQ-2085",
      title: "EDP data onboarding: Preparer e-file submissions (curated)",
      submittedAt: "Jun 5, 2026",
      status: "In progress",
      overall: "Submitted — pending EDP business and ROI review",
      purpose:
        "Onboard Preparer e-file submissions (curated) from IMF / Individual Master File into the " +
        "Individual Filing domain via Enterprise File Transfer Utility (EFTU), consumed through All within " +
        "Databricks. Score preparer risk weekly instead of quarterly. Mission value: Reduce fraud " +
        "and improper payments (primary: Reduce fraud and improper payments). Sizing: Medium — " +
        "dedicated pipeline (500 GB, Daily loads, Moderate transforms, 40 query users) · est. " +
        "$53K/yr vs. $750K annual benefit (ROI 14.2x).",
      items: [
        {
          kind: "Onboarding",
          label: "Preparer e-file submissions (curated)",
          sub: "Target: the Individual Filing domain · Medium — dedicated pipeline",
        },
        {
          kind: "Onboarding",
          label: "Ingestion — Enterprise File Transfer Utility (EFTU)",
          sub: "Daily · Moderate transforms",
        },
        { kind: "Onboarding", label: "Consumption — All within Databricks", sub: "40 query users" },
        { kind: "Onboarding", label: "Platform capacity", sub: "740 DBU/mo · 0.8 TB" },
        {
          kind: "Onboarding",
          label: "Mission value — Reduce fraud and improper payments",
          sub: "Reduce fraud and improper payments",
        },
        {
          kind: "Onboarding",
          label: "Delivery — We have our own resources",
          sub: "Tenant-built with approved patterns",
        },
      ],
      subRequests: [
        {
          system: "EDP business and ROI review",
          status: "active",
          detail: "Reduce fraud and improper payments · $53K/yr est. cost · ROI 14.2x",
        },
        {
          system: "EDP intake CCB",
          status: "pending",
          detail: "Intake change control board for the Individual Filing domain",
        },
        {
          system: "BEARS entitlement creation",
          status: "pending",
          detail: "Access entitlements for 40 query users",
        },
        {
          system: "DBX users, Unity Catalog, and compute provisioning",
          status: "pending",
          detail: "Medallion layers + pipeline scaffold",
        },
      ],
      stageIndex: 0,
    });
  });
});

describe("SchemaForm — the extended intake (#86)", () => {
  // Start on the datasets step with every earlier step already valid.
  function renderAtDatasets(overrides: IntakeState = {}) {
    renderForm({
      initialValues: buildDefaults({
        dataName: "X",
        useCase: "A sufficiently long business justification.",
        ...overrides,
      }),
    });
    for (let i = 0; i < 4; i++) fireEvent.click(next()); // -> datasets
  }

  it("shows validation errors for a dataset missing its domain, tag and owner", () => {
    window.history.replaceState(null, "", "#onboarding");
    renderAtDatasets({
      datasets: [{ name: "Case signals", domain: "", datasetTag: "", owners: [] }],
    });
    fireEvent.click(next());
    const errors = screen.getByRole("alert", { name: /validation errors/i });
    expect(within(errors).getByText('Dataset 1: choose a domain, or "Other".')).toBeTruthy();
    expect(within(errors).getByText("Dataset 1: enter a dataset tag.")).toBeTruthy();
    expect(within(errors).getByText("Dataset 1: name at least one dataset owner.")).toBeTruthy();
    const hash = window.location.hash;
    fireEvent.click(within(errors).getByRole("link", { name: /choose a domain/i }));
    expect(window.location.hash).toBe(hash);
    expect(document.activeElement).toBe(control("Dataset 1 domain"));
    expect((control("Dataset 1 name") as HTMLInputElement).value).toBe("Case signals");
  });

  it("gives every dataset owner input a persistent visible label", () => {
    renderAtDatasets();
    expect(document.querySelector('label[for="dataset-1-owner-1-name"]')?.textContent).toMatch(
      /Owner's name/,
    );
    expect(document.querySelector('label[for="dataset-1-owner-1-email"]')?.textContent).toMatch(
      /Owner's email/,
    );
  });

  it("keeps focus in a dataset field typed into after a failed Continue (#179)", async () => {
    const user = userEvent.setup();
    renderAtDatasets({
      datasets: [{ name: "Case signals", domain: "", datasetTag: "", owners: [] }],
    });
    await user.click(next());
    const errors = screen.getByRole("alert", { name: /validation errors/i });
    expect(document.activeElement).toBe(errors);
    await user.click(within(errors).getByRole("link", { name: /enter a dataset tag/i }));
    const tag = control("Dataset 1 tag");
    expect(document.activeElement).toBe(tag);
    await user.keyboard("case_signals");
    expect(document.activeElement).toBe(tag);
    expect((tag as HTMLInputElement).value).toBe("case_signals");
    await user.click(next());
    expect(document.activeElement).toBe(screen.getByRole("alert", { name: /validation errors/i }));
  });

  it("marks a touched, empty dataset field invalid with its own error", () => {
    renderAtDatasets();
    const tag = control("Dataset 1 tag");
    fireEvent.change(tag, { target: { value: "" } });
    expect(tag.getAttribute("aria-invalid")).toBeNull(); // untouched: no inline error yet
    fireEvent.blur(tag);
    expect(tag.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a dataset tag.")).toBeTruthy();
    fireEvent.change(tag, { target: { value: "case_signals" } });
    expect(tag.getAttribute("aria-invalid")).toBeNull();
  });

  it("starts with one blank dataset and gates Continue until it is complete", () => {
    renderForm({
      initialValues: buildDefaults({
        datasets: [{ name: "", domain: "", datasetTag: "", owners: [{ name: "", email: "" }] }],
      }),
    });
    completeSourceStep();
    fireEvent.click(next()); // delivery
    fireEvent.click(next()); // business
    fireEvent.change(control(/business justification/i), {
      target: { value: "A sufficiently long business justification." },
    });
    fireEvent.click(next()); // datasets
    expect((control("Dataset 1 name") as HTMLInputElement).value).toBe("");
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Which input datasets are you bringing into EDP?" }),
    ).toBeTruthy();
    completeDatasetsAndWorkspace();
    expect(screen.getByRole("heading", { name: "Estimate initiative capacity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /run preliminary estimate/i })).toBeTruthy();
  });

  it("offers Other as a domain and collects several datasets and owners", () => {
    renderAtDatasets();
    const domain = control("Dataset 1 domain") as HTMLSelectElement;
    expect(within(domain).getByRole("option", { name: /No domain fits/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /add another dataset/i }));
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(control("Dataset 2 name")).toBeTruthy();
    fireEvent.change(control("Dataset 2 name"), { target: { value: "Misc" } });
    fireEvent.change(control("Dataset 2 source system"), { target: { value: "IDRS" } });
    fireEvent.change(control("Dataset 2 domain"), { target: { value: "other" } });
    fireEvent.change(control("Dataset 2 ingestion method"), { target: { value: "informatica" } });
    fireEvent.change(control("Dataset 2 tag"), { target: { value: "misc" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Dataset 2 owner 1" })).getByRole("radio", {
        name: /someone else/i,
      }),
    );
    fireEvent.change(
      within(screen.getByRole("group", { name: "Dataset 2 owner 1" })).getByLabelText(
        "Owner's name",
      ),
      { target: { value: "Al" } },
    );
    fireEvent.change(
      within(screen.getByRole("group", { name: "Dataset 2 owner 1" })).getByLabelText(
        "Owner's email",
      ),
      {
        target: { value: "al@example.gov" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /add an owner to dataset 2/i }));
    fireEvent.click(next());
    expect(screen.getByRole("alert", { name: "Validation errors" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Dataset 2 owner 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /remove owner 2/i }));
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "What does your team need to work in?" }),
    ).toBeTruthy();
  });

  it("asks the workspace-needs questions, labels their criteria a stub and shows the compute policy", () => {
    renderAtDatasets();
    fireEvent.click(next()); // -> workspace
    expect(control(/code or work products/i)).toBeTruthy();
    expect(control(/how many people/i)).toBeTruthy();
    expect(
      screen.getByRole("region", { name: /dedicated-workspace decision: not yet implemented/i }),
    ).toBeTruthy();

    const policy = screen.getByRole("region", { name: "Standard compute policy" });
    expect(within(policy).getByText("Overview only")).toBeTruthy();
    expect(
      within(policy).getByText(/change your compute policy after your initiative/i),
    ).toBeTruthy();
    expect(
      within(policy).getByRole("region", {
        name: /compute policy change requests: not yet implemented/i,
      }),
    ).toBeTruthy();
  });
});

describe("SchemaForm — dataset tag rule (#131 UAT)", () => {
  /** Render straight to the datasets step with a valid intake and `tag` on dataset 1. */
  function toDatasets(datasets = [{ ...VALID_DATASET, datasetTag: "" }]) {
    renderForm({
      initialValues: buildDefaults({
        dataName: "X",
        useCase: "A sufficiently long business justification.",
        datasets,
      }),
    });
    fireEvent.click(next()); // architecture
    fireEvent.click(next()); // delivery
    fireEvent.click(next()); // business
    fireEvent.click(next()); // datasets
    return control("Dataset 1 tag") as HTMLInputElement;
  }

  it("shows the rule under the field", () => {
    const tag = toDatasets();
    const label = screen.getByText("Dataset tag", { selector: "label" }) as HTMLLabelElement;
    expect(label.htmlFor).toBe("dataset-1-tag");
    expect(document.getElementById(label.htmlFor)).toBe(tag);
    const hint = screen.getByText(DATASET_TAG_HINT);
    expect(tag.getAttribute("aria-describedby")).toContain(hint.id);
  });

  it("waits for blur to show the error, keeps focus while typing, then suggests the fix", () => {
    const tag = toDatasets();
    tag.focus();
    fireEvent.change(tag, { target: { value: "Refund Anomaly Scores" } });
    expect(document.activeElement).toBe(tag);
    expect(screen.queryByText(/Use refund_anomaly_scores instead/)).toBeNull();
    expect(tag.getAttribute("aria-invalid")).toBeNull();

    fireEvent.blur(tag);
    const error = screen.getByText(
      "A dataset tag can only use lowercase letters, numbers and underscores. Use refund_anomaly_scores instead.",
    );
    expect(tag.getAttribute("aria-invalid")).toBe("true");
    expect(tag.getAttribute("aria-describedby")).toContain(error.closest("[id]")!.id);
  });

  it.each(BAD_TAGS)("won't continue past a tag with %s", (_label, value, message) => {
    const tag = toDatasets();
    fireEvent.change(tag, { target: { value } });
    fireEvent.click(next());
    expect(control("Dataset 1 tag")).toBeTruthy(); // still on the datasets step
    const errors = screen.getByRole("alert", { name: "Validation errors" });
    expect(errors.textContent).toMatch(message);
  });

  it.each(GOOD_TAGS)("continues with the tag %s", (value) => {
    const tag = toDatasets();
    fireEvent.change(tag, { target: { value } });
    fireEvent.click(next());
    expect(screen.queryByLabelText("Dataset 1 tag")).toBeNull();
    expect(control(/code or work products/i)).toBeTruthy();
  });

  it("won't continue when two datasets share a tag", () => {
    toDatasets([VALID_DATASET, { ...VALID_DATASET, name: "Second" }]);
    fireEvent.click(next());
    expect(screen.getByText("Dataset 1 already uses this tag. Use a different tag.")).toBeTruthy();
    expect(control("Dataset 2 tag").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("SchemaForm — a second wizard on the page (#222 resubmit)", () => {
  const FILLED = buildDefaults({
    dataName: "Collections case signals",
    useCase: "Prioritize balance-due cases.",
    estimated: true,
  });
  const LAST = schema.steps.length - 1;

  it("prefixes every element id, the dataset fields' included, and links its summary to them", () => {
    const { container } = render(
      <SchemaForm
        schema={schema}
        widgets={edpWidgets}
        dynamicOptions={{ domains: DOMAINS }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        idPrefix="onb-1-resubmit"
        initialValues={{ ...FILLED, datasets: [{ ...VALID_DATASET, datasetTag: "" }] }}
        initialStep={schema.steps.findIndex((s) => s.id === "datasets")}
      />,
    );
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("onb-1-resubmit-"))).toBe(true);
    fireEvent.click(next());
    const link = within(screen.getByRole("alert")).getByRole("link", {
      name: "Dataset 1: enter a dataset tag.",
    });
    expect(link.getAttribute("href")).toBe("#onb-1-resubmit-dataset-1-tag");
  });

  it("refuses the final submit for the host's own problems, in the summary, only once tried", () => {
    const onSubmit = vi.fn();
    const onInvalidSubmit = vi.fn();
    const props = {
      schema,
      widgets: edpWidgets,
      dynamicOptions: { domains: DOMAINS },
      onSubmit,
      onCancel: vi.fn(),
      onInvalidSubmit,
      initialValues: FILLED,
      initialStep: LAST,
      submitLabel: "Answer and resubmit",
    };
    const { rerender } = render(
      <>
        <textarea id="answer" aria-label="Your answer" />
        <SchemaForm
          {...props}
          submitIssues={[{ targetId: "answer", message: "Enter an answer for the reviewer." }]}
        />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Answer and resubmit/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onInvalidSubmit).toHaveBeenCalledTimes(1);
    const summary = screen.getByRole("alert");
    expect(document.activeElement).toBe(summary);
    fireEvent.click(
      within(summary).getByRole("link", { name: "Enter an answer for the reviewer." }),
    );
    expect(document.activeElement).toBe(control("Your answer"));

    rerender(
      <>
        <textarea id="answer" aria-label="Your answer" />
        <SchemaForm {...props} submitIssues={[]} />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Answer and resubmit/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps the first submit's button text by default", () => {
    renderForm({ initialValues: FILLED, initialStep: LAST });
    expect(screen.getByRole("button", { name: /Submit data onboarding request/ })).toBeTruthy();
  });
});

describe("SchemaForm — no accountable data steward (#103)", () => {
  it("asks for no steward, and the first step continues without one", () => {
    renderForm({ signedIn: { name: "Pat Provider", email: "pat.provider@example.gov" } });
    expect(screen.queryByLabelText(/accountable data steward/i)).toBeNull();
    fireEvent.change(control(/initiative name/i), { target: { value: "Set" } });
    fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "How will your team access this data?" }),
    ).toBeTruthy();
  });
});

describe("SchemaForm — the initiative point of contact (#103)", () => {
  const ME = { name: "Pat Provider", email: "pat.provider@example.gov" };

  function fillSourceExceptOwner() {
    fireEvent.change(control(/initiative name/i), {
      target: { value: "Curated dataset" },
    });
  }

  it("asks for the owner first, and links the summary to the choice", () => {
    renderForm({ signedIn: ME, initialValues: buildDefaults({ initiativeOwner: null }) });
    fillSourceExceptOwner();
    fireEvent.click(next());

    const link = screen.getByRole("link", { name: "Choose who owns the initiative." });
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /myself/i }));
    expect(screen.getByRole("heading", { name: "Tell us about the initiative" })).toBeTruthy();
  });

  it("shows the signed-in person for Myself, with nothing to type, as verified", () => {
    renderForm({ signedIn: ME });
    const group = screen.getByRole("group", { name: /initiative point of contact/i });
    fireEvent.click(within(group).getByRole("radio", { name: /myself/i }));

    expect(group.textContent).toMatch("Pat Provider (pat.provider@example.gov)");
    expect(group.textContent).toMatch(/Verified: it's the account you're signed in with/);
    expect(within(group).queryByRole("textbox")).toBeNull();
    fillSourceExceptOwner();
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "How will your team access this data?" }),
    ).toBeTruthy();
  });

  it("takes a name and a valid email for Someone else, and says they're not verified", () => {
    renderForm({ signedIn: ME });
    const group = screen.getByRole("group", { name: /initiative point of contact/i });
    const someoneElse = within(group).getByRole("radio", { name: /someone else/i });
    fireEvent.click(someoneElse);
    expect(group.textContent).toMatch(
      /Not verified: the app only checks that the email looks right/,
    );
    // Leaving the choice for the name box flags nothing: nothing's been typed yet.
    fireEvent.blur(someoneElse);
    expect(within(group).queryByText("Enter the initiative point of contact's name.")).toBeNull();
    expect(
      within(group).queryByText("Enter a valid email address for the initiative point of contact."),
    ).toBeNull();

    fireEvent.change(within(group).getByLabelText("Owner's name"), {
      target: { value: "Sam Else" },
    });
    const email = within(group).getByLabelText("Owner's email");
    fireEvent.change(email, { target: { value: "sam" } });
    fillSourceExceptOwner();
    fireEvent.click(next());

    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getAllByText("Enter a valid email address for the initiative point of contact."),
    ).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("link", {
        name: "Enter a valid email address for the initiative point of contact.",
      }),
    );
    expect(document.activeElement).toBe(email);

    fireEvent.change(email, { target: { value: "sam.else@example.gov" } });
    fireEvent.click(next());
    expect(
      screen.getByRole("heading", { name: "How will your team access this data?" }),
    ).toBeTruthy();
  });

  /** The form open on the datasets step, with one dataset whose owners are `owners`. */
  function onDatasetsStep(owners: unknown[] = [{ name: "", email: "" }]) {
    return renderForm({
      signedIn: ME,
      initialValues: {
        ...buildDefaults({
          dataName: "X",
          useCase: "long enough text",
          estimated: true,
        }),
        datasets: [
          {
            name: "Case signals",
            sourceSystem: "IMF / Individual Master File",
            domain: "individual-filing",
            ingestionMethod: "eftu",
            datasetTag: "case_signals",
            owners,
          },
        ],
      },
      initialStep: schema.steps.findIndex((step) => step.id === "datasets"),
    });
  }
  const ownerRow = (dataset: number, owner: number) =>
    screen.getByRole("group", { name: `Dataset ${dataset} owner ${owner}` });

  it("offers Myself or Someone else on a dataset owner, worded as for the initiative owner", () => {
    onDatasetsStep();
    expect(screen.queryByRole("button", { name: /add myself/i })).toBeNull();
    const row = ownerRow(1, 1);
    expect(within(row).queryByRole("textbox")).toBeNull();

    fireEvent.click(within(row).getByRole("radio", { name: /myself/i }));
    expect(row.textContent).toMatch("Pat Provider (pat.provider@example.gov)");
    expect(row.textContent).toMatch("Verified: it's the account you're signed in with.");
    expect(within(row).queryByRole("textbox")).toBeNull();

    fireEvent.click(within(row).getByRole("radio", { name: /someone else/i }));
    expect(within(row).getByLabelText("Owner's name")).toBeTruthy();
    expect(within(row).getByLabelText("Owner's email")).toBeTruthy();
    expect(row.textContent).toMatch(
      "Not verified: the app only checks that the email looks right. It can't confirm who this person is yet.",
    );
  });

  it("asks an untouched owner row to choose, and links the summary to the choice", () => {
    onDatasetsStep();
    fireEvent.click(next());

    const message = "Dataset 1, owner 1: choose Myself or Someone else.";
    fireEvent.click(screen.getByRole("link", { name: message }));
    expect(document.activeElement).toBe(
      within(ownerRow(1, 1)).getByRole("radio", { name: /myself/i }),
    );
    expect(ownerRow(1, 1).textContent).toMatch("Choose Myself or Someone else.");
  });

  it("checks Someone else's name and email inline, as for the initiative owner", () => {
    onDatasetsStep();
    const row = ownerRow(1, 1);
    fireEvent.click(within(row).getByRole("radio", { name: /someone else/i }));
    const email = within(row).getByLabelText("Owner's email");
    fireEvent.change(within(row).getByLabelText("Owner's name"), { target: { value: "Olive" } });
    fireEvent.change(email, { target: { value: "olive" } });
    fireEvent.click(next());

    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(row.textContent).toMatch("Enter a valid email address.");
    fireEvent.change(email, { target: { value: "olive.owner@example.gov" } });
    fireEvent.click(next());
    expect(screen.queryByRole("group", { name: "Dataset 1 owner 1" })).toBeNull();
  });

  it("refuses a second Myself on one dataset with an inline error", () => {
    onDatasetsStep([
      { self: true, name: "", email: "" },
      { name: "", email: "" },
    ]);
    fireEvent.click(within(ownerRow(1, 2)).getByRole("radio", { name: /myself/i }));
    fireEvent.click(next());

    const row = ownerRow(1, 2);
    expect(row.textContent).toMatch("Myself is already owner 1 of this dataset.");
    expect(row.textContent).not.toMatch("Verified");
    expect(
      screen.getByRole("link", {
        name: "Dataset 1, owner 2: Myself is already owner 1 of this dataset.",
      }),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole("radio", { name: /someone else/i }));
    fireEvent.change(within(row).getByLabelText("Owner's name"), { target: { value: "Olive" } });
    fireEvent.change(within(row).getByLabelText("Owner's email"), {
      target: { value: "olive.owner@example.gov" },
    });
    fireEvent.click(next());
    expect(screen.queryByRole("group", { name: "Dataset 1 owner 2" })).toBeNull();
  });

  it("sends Myself with no identity of its own, and Someone else as typed", () => {
    const { onSubmit } = onDatasetsStep([
      { name: "", email: "" },
      { name: "", email: "" },
    ]);
    fireEvent.click(within(ownerRow(1, 1)).getByRole("radio", { name: /myself/i }));
    const other = ownerRow(1, 2);
    fireEvent.click(within(other).getByRole("radio", { name: /someone else/i }));
    fireEvent.change(within(other).getByLabelText("Owner's name"), { target: { value: "Olive" } });
    fireEvent.change(within(other).getByLabelText("Owner's email"), {
      target: { value: "olive.owner@example.gov" },
    });
    for (let i = 0; i < 3; i++) fireEvent.click(next());
    fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));

    const intake = toOnboardingIntake(onSubmit.mock.calls[0]![0] as IntakeState);
    expect(intake.datasets[0]?.owners).toEqual([
      { self: true, name: "", email: "" },
      { name: "Olive", email: "olive.owner@example.gov" },
    ]);
  });

  it("never moves one dataset's typed owner details to another when a dataset is removed", () => {
    renderForm({
      signedIn: ME,
      initialValues: {
        ...buildDefaults({ dataName: "X", useCase: "long enough text" }),
        datasets: [
          {
            name: "First",
            domain: "individual-filing",
            datasetTag: "first",
            owners: [{ name: "", email: "" }],
          },
          {
            name: "Second",
            domain: "individual-filing",
            datasetTag: "second",
            owners: [{ name: "", email: "" }],
          },
        ],
      },
      initialStep: schema.steps.findIndex((step) => step.id === "datasets"),
    });
    // Dataset 1's owner: typed as Someone else, then switched to Myself, so the details are hidden.
    const first = ownerRow(1, 1);
    fireEvent.click(within(first).getByRole("radio", { name: /someone else/i }));
    fireEvent.change(within(first).getByLabelText("Owner's name"), {
      target: { value: "Hidden Person" },
    });
    fireEvent.change(within(first).getByLabelText("Owner's email"), {
      target: { value: "hidden@example.gov" },
    });
    fireEvent.click(within(first).getByRole("radio", { name: /myself/i }));

    fireEvent.click(screen.getByRole("button", { name: "Remove dataset 1" }));
    expect(control("Dataset 1 name")).toHaveProperty("value", "Second");

    // The dataset that was second starts its own Someone else blank.
    const second = ownerRow(1, 1);
    fireEvent.click(within(second).getByRole("radio", { name: /someone else/i }));
    expect(within(second).getByLabelText("Owner's name")).toHaveProperty("value", "");
    expect(within(second).getByLabelText("Owner's email")).toHaveProperty("value", "");
  });

  it("shows a stored owner on a resubmission as Someone else with their details", () => {
    onDatasetsStep([{ id: "ow-1", name: "Olive Owner", email: "olive.owner@example.gov" }]);
    const row = ownerRow(1, 1);
    expect(
      (within(row).getByRole("radio", { name: /someone else/i }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((within(row).getByLabelText("Owner's email") as HTMLInputElement).value).toBe(
      "olive.owner@example.gov",
    );
  });
});

describe("SchemaForm — a stored dataset with an unknown ingestion method (#335)", () => {
  const UNKNOWN = { ...VALID_DATASET, ingestionMethod: "zzz" };

  it.each([
    ["Datasets", 4],
    ["Review & submit", 7],
  ])("draws the %s diagram lane as not chosen and needing consultation", (_step, initialStep) => {
    renderForm({
      initialStep,
      initialValues: buildDefaults({
        dataName: "X",
        useCase: "A sufficiently long business justification.",
        estimated: true,
        datasets: [VALID_DATASET, UNKNOWN],
      }),
    });
    const lanes = screen.getAllByText("Ingestion pattern");
    expect(lanes).toHaveLength(2);
    expect(screen.getByText("Not chosen — needs consultation")).toBeTruthy();
    expect(screen.getAllByText(/architecture consultation/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/uses approved patterns only/i)).toBeNull();
  });
});
