import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SchemaForm, edpWidgets, type DynamicOption } from "./index";
import { loadSchema, type IntakeState } from "../../schema";
import { toOnboardingIntake } from "../../data/onboarding/intake";

// Number fields with real keystrokes in real Chrome: clearing, retyping and
// typing separators. A number field is a text box, so the box must show exactly
// what was typed, and nothing may be written back over it.

afterEach(cleanup);

const schema = loadSchema();

const DOMAINS: DynamicOption[] = [{ value: "individual-filing", label: "Individual Filing" }];

function renderForm() {
  const onSubmit = vi.fn();
  const props = {
    schema,
    widgets: edpWidgets,
    dynamicOptions: { domains: DOMAINS },
    onSubmit,
    onCancel: vi.fn(),
  };
  const { rerender } = render(<SchemaForm {...props} />);
  return { onSubmit, rerender: () => rerender(<SchemaForm {...props} />) };
}

function next(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
}

function formControl(label: string | RegExp): HTMLElement {
  return screen.getAllByLabelText(label).find((element) => element.tagName !== "BUTTON")!;
}

// Source step, then architecture and delivery on their defaults, to business.
function goToBusinessStep() {
  fireEvent.change(formControl(/initiative name/i), {
    target: { value: "Preparer e-file submissions (curated)" },
  });
  fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
  fireEvent.change(formControl(/data sensitivity/i), { target: { value: "SBU" } });
  fireEvent.click(next()); // -> architecture
  fireEvent.click(screen.getByRole("button", { name: /All within Databricks/i }));
  fireEvent.click(next()); // -> delivery
  fireEvent.click(screen.getByRole("button", { name: /We have our own resources/i }));
  fireEvent.click(next()); // -> business
  fireEvent.click(screen.getByRole("button", { name: /Reduce fraud and improper payments/i }));
  fireEvent.change(formControl(/primary mission outcome/i), { target: { value: "fraud" } });
  fireEvent.change(formControl(/estimated annual benefit/i), { target: { value: "100000" } });
  fireEvent.change(formControl(/estimated annual benefit/i), { target: { value: "750000" } });
}

function benefitBox(): HTMLInputElement {
  return formControl(/estimated annual benefit/i) as HTMLInputElement;
}

// Click into the box and select its contents, as a user replacing the number.
async function selectAll(input: HTMLInputElement) {
  await userEvent.click(input);
  await userEvent.keyboard(
    navigator.platform.startsWith("Mac") ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
  );
}

const REQUIRED = "Estimated annual benefit (USD) is required.";
const NOT_A_NUMBER = "Estimated annual benefit (USD) must be a number.";

describe("SchemaForm — number fields in a real browser", () => {
  it("is a text box with a numeric keyboard", () => {
    renderForm();
    goToBusinessStep();
    expect(benefitBox().type).toBe("text");
    expect(benefitBox().inputMode).toBe("decimal");
  });

  it("stays empty once cleared, through blur and a re-render", async () => {
    const { rerender } = renderForm();
    goToBusinessStep();
    const benefit = benefitBox();
    expect(benefit.value).toBe("750000");

    await selectAll(benefit);
    await userEvent.keyboard("{Backspace}");
    expect(benefit.value).toBe("");
    await userEvent.tab();
    expect((await screen.findAllByText(REQUIRED)).length).toBeGreaterThan(0);
    expect(benefit.getAttribute("aria-invalid")).toBe("true");
    expect(benefit.value).toBe("");

    rerender();
    expect(benefitBox().value).toBe("");
  });

  it("deletes the last digit with Backspace instead of putting a 0 back", async () => {
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();

    await userEvent.click(benefit);
    await userEvent.keyboard("{End}");
    for (let i = 0; i < "750000".length; i++) await userEvent.keyboard("{Backspace}");
    expect(benefit.value).toBe("");
    await userEvent.keyboard("{Backspace}");
    expect(benefit.value).toBe("");
  });

  it("clears, then takes a retyped value with separators exactly as typed", async () => {
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();

    await selectAll(benefit);
    await userEvent.keyboard("{Backspace}");
    await userEvent.tab();
    await userEvent.click(benefit);
    await userEvent.keyboard("$1,200.50");
    expect(benefit.value).toBe("$1,200.50");
    await userEvent.tab();
    expect(benefit.value).toBe("$1,200.50");
    expect(screen.queryByText(REQUIRED)).toBeNull();
    expect(benefit.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps a partial '-' as typed, then takes the number", async () => {
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();

    await selectAll(benefit);
    await userEvent.keyboard("-");
    expect(benefit.value).toBe("-");
    await userEvent.tab();
    expect((await screen.findAllByText(NOT_A_NUMBER)).length).toBeGreaterThan(0);
    await userEvent.click(benefit);
    await userEvent.keyboard("{End}5");
    expect(benefit.value).toBe("-5");
  });

  it("keeps letters as typed and says the field must be a number", async () => {
    renderForm();
    goToBusinessStep();
    const benefit = benefitBox();

    await selectAll(benefit);
    await userEvent.keyboard("12abc");
    await userEvent.tab();
    expect(benefit.value).toBe("12abc");
    expect((await screen.findAllByText(NOT_A_NUMBER)).length).toBeGreaterThan(0);
  });

  it("chooses a dataset owner with the keyboard: arrow keys move between Myself and Someone else", async () => {
    render(
      <SchemaForm
        schema={schema}
        widgets={edpWidgets}
        dynamicOptions={{ domains: DOMAINS }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        initialStep={schema.steps.findIndex((step) => step.id === "datasets")}
        initialValues={{
          dataName: "X",
          initiativeOwner: { kind: "self" },
          datasets: [
            {
              name: "Case signals",
              sourceSystem: "IMF / Individual Master File",
              domain: "individual-filing",
              ingestionMethod: "eftu",
              datasetTag: "case_signals",
              owners: [{ name: "", email: "" }],
            },
          ],
        }}
      />,
    );
    const row = screen.getByRole("group", { name: "Dataset 1 owner 1" });
    const myself = within(row).getByRole("radio", { name: /myself/i }) as HTMLInputElement;
    const someoneElse = within(row).getByRole("radio", {
      name: /someone else/i,
    }) as HTMLInputElement;
    myself.focus();
    await userEvent.keyboard(" ");
    expect(myself.checked).toBe(true);
    await userEvent.keyboard("{ArrowDown}");
    expect(someoneElse.checked).toBe(true);
    await userEvent.tab();
    expect(document.activeElement).toBe(within(row).getByLabelText("Owner's name"));
    await userEvent.keyboard("Olive Owner");
    await userEvent.tab();
    await userEvent.keyboard("olive.owner@example.gov");
    expect((within(row).getByLabelText("Owner's email") as HTMLInputElement).value).toBe(
      "olive.owner@example.gov",
    );
  });

  it("submits the typed text, which the intake reads as a number", async () => {
    const { onSubmit } = renderForm();
    goToBusinessStep();
    fireEvent.change(formControl(/business justification/i), {
      target: { value: "Score preparer risk weekly instead of quarterly." },
    });
    await selectAll(benefitBox());
    await userEvent.keyboard("$1,250,000");
    fireEvent.click(next()); // -> datasets
    fireEvent.change(formControl("Dataset 1 name"), {
      target: { value: "Case signals" },
    });
    fireEvent.change(formControl("Dataset 1 source system"), {
      target: { value: "IMF / Individual Master File" },
    });
    fireEvent.change(formControl("Dataset 1 domain"), {
      target: { value: "individual-filing" },
    });
    fireEvent.change(formControl("Dataset 1 ingestion method"), {
      target: { value: "eftu" },
    });
    fireEvent.change(formControl("Dataset 1 tag"), { target: { value: "case_signals" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByRole("radio", {
        name: /someone else/i,
      }),
    );
    fireEvent.change(
      within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByLabelText(
        "Owner's name",
      ),
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
    fireEvent.click(next()); // -> workspace
    fireEvent.change(formControl(/code or work products/i), {
      target: { value: "Not sure — ask EDP staff to assess" },
    });
    fireEvent.change(formControl(/how many people/i), { target: { value: "6" } });
    fireEvent.click(next()); // -> sizing
    fireEvent.change(formControl(/data volume/i), { target: { value: "500" } });
    fireEvent.change(formControl(/load frequency/i), { target: { value: "Daily" } });
    fireEvent.change(formControl(/transformation complexity/i), {
      target: { value: "Moderate — joins and recurring business rules" },
    });
    fireEvent.change(formControl(/business users needing to query/i), {
      target: { value: "40" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
    await screen.findByRole("button", { name: /re-run preliminary estimate/i });
    fireEvent.click(next()); // -> review
    fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values: IntakeState = onSubmit.mock.calls[0]?.[0];
    expect(values["annualBenefit"]).toBe("$1,250,000");
    expect(toOnboardingIntake(values).annualBenefit).toBe(1250000);
  });
});
