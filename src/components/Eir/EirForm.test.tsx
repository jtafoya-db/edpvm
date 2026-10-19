import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_PRIVACY_NOTICE, createMemoryStore, StoreProvider } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EIR_STUB_VALUES, EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import {
  BOOTSTRAP_EIR_DEFINITIONS,
  createMemoryEirRepository,
  type MemoryEirRepository,
} from "@/data/eir/repository";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import { loadDefinition } from "@/data/eir/definition/load";
import type { EirDefinition } from "@/data/eir/definition/types";
import { createMemoryPrivacyAcknowledgmentRepository } from "@/data/privacy/repository";
import { EirScreen } from "./EirScreen";
import { EirValidatorSection } from "./EirValidatorSection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = new Date("2026-10-01T12:00:00Z");

function createAcknowledgedMemoryStore(
  ...[seed, options = {}]: Parameters<typeof createMemoryStore>
) {
  const identity = {
    principalId: "acknowledged-test-person",
    displayName: "Acknowledged Test Person",
    actorApp: "tenant" as const,
  };
  return createMemoryStore(seed, {
    ...options,
    privacyAcknowledgmentRepository: createMemoryPrivacyAcknowledgmentRepository({
      identity,
      state: {
        acknowledgments: [
          {
            noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
            contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
            principalId: identity.principalId,
            actorDisplay: identity.displayName,
            actorApp: identity.actorApp,
            acknowledgedAt: NOW.toISOString(),
          },
        ],
      },
    }),
  });
}

function storeFor(
  user: { principalId: string; name: string; validator?: boolean } & Record<string, unknown>,
  eir?: MemoryEirRepository,
) {
  const store = createAcknowledgedMemoryStore(makeSnapshot(), {
    clock: () => NOW,
    ...(eir ? { eirRepository: eir } : {}),
  });
  const { validator, ...profile } = user;
  store.catalog.getUser = async () => ({
    ...makeSnapshot().user,
    email: "test.person@example.gov",
    isSafeguardsValidator: Boolean(validator),
    ...profile,
  });
  return store;
}

function renderScreen(store: ReturnType<typeof createAcknowledgedMemoryStore>) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <StoreProvider store={store}>
        {/* My EIR, and for a validator the EDP Admin EIR section beside it (#159). */}
        <EirScreen />
        <EirValidatorSection />
      </StoreProvider>
    </QueryClientProvider>,
  );
}

const field = (name: RegExp) => screen.getByRole("textbox", { name });

const BOOTSTRAP_1_YAML = readBootstrapEirSource("bootstrap")!;
const loaded = loadDefinition(BOOTSTRAP_1_YAML, "bootstrap");
if (!loaded.ok) throw new Error("The bootstrap definition must load.");
/** The bootstrap definition (`bootstrap`, form 1.3's rules): compliance answers flag for the validator, never block. */
const BOOTSTRAP_1: EirDefinition = loaded.definition;
const onBootstrap1 = {
  active: () => BOOTSTRAP_1,
  byId: (id: string) => (id === "bootstrap" ? BOOTSTRAP_1 : undefined),
};

/**
 * Safeguards publishes and activates the bootstrap definition's YAML, with its
 * warning and manual-review rules, as version 1 (#224 numbers it; #217: the
 * fallback built-in blocks on every rule, so warnings need a published one).
 */
async function activateSyntheticWarningDefinition(store: ReturnType<typeof storeFor>) {
  const getUser = store.catalog.getUser;
  store.catalog.getUser = async () => ({ ...(await getUser()), isSafeguardsValidator: true });
  await store.eirDefinitions.publish({
    sourceYaml: BOOTSTRAP_1_YAML,
    expectedVersion: 0,
  });
  await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
  store.catalog.getUser = getUser;
}

/** Download PDF to sign on a saved bootstrap-2 draft that fails one rule (#217). */
async function downloadBlocked(changed: Record<string, string>) {
  const store = storeFor({ principalId: "person-1", name: "Test Person" });
  await store.eir.saveDraft("person-1", { ...EIR_VALUES, ...changed });
  renderScreen(store);
  // The saved draft has loaded once its answers show.
  await waitFor(() => expect(field(/^Team or project/)).toHaveValue(EIR_VALUES["team"]));
  fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
  return { store, alert: await screen.findByRole("alert") };
}

describe("EIR form 1.3 on screen", () => {
  it.each([
    [
      "out-of-date Privacy training",
      { privacyTrainingDate: "2025-09-01" },
      "[Placeholder wording] Complete your Privacy training, then enter its completion date.",
    ],
    [
      "an unsigned IRS NDA",
      { ndaSigned: "no" },
      "[Placeholder wording] Sign the IRS NDA, then answer Yes.",
    ],
    [
      "an expired MBI",
      { mbiExpirationDate: "2026-09-30" },
      "[Placeholder wording] Your MBI or staff-like access has expired. Renew it, then enter the new expiration date.",
    ],
  ])(
    "blocks the PDF for %s and says what to do, by the field and in the summary (#217)",
    async (_label, changed, guidance) => {
      const { store, alert } = await downloadBlocked(changed);
      const [id] = Object.keys(changed);

      expect(alert).toHaveTextContent("Correct the highlighted fields.");
      expect(alert).toHaveTextContent(guidance);
      expect(document.getElementById(`eir-field-${id}-error`)).toHaveTextContent(guidance);
      // The field is marked invalid and points at its error (a date input, or a yes/no group).
      const control = document.querySelector(`[aria-describedby~="eir-field-${id}-error"]`);
      expect(control).not.toBeNull();
      expect(control).toHaveAttribute("aria-invalid", "true");
      // The date input itself, or the yes/no group that holds the field's first option.
      expect(
        control === document.getElementById(`eir-field-${id}`) ||
          control?.contains(document.getElementById(`eir-field-${id}`)),
      ).toBe(true);
      // The summary takes focus and links to the field.
      const summary = screen.getByRole("region", { name: "Check 1 answer" });
      await waitFor(() => expect(summary).toHaveFocus());
      expect(within(summary).getByRole("link", { name: guidance })).toHaveAttribute(
        "href",
        `#eir-field-${id}`,
      );
      expect(screen.queryByText(/PDF generated/)).not.toBeInTheDocument();
      expect(await store.eir.get("person-1")).toMatchObject({
        evaluation: { outcome: "blocking", definitionVersion: "bootstrap-2" },
      });
    },
  );

  it("shows warnings as non-blocking and marks the evaluation stale after an edit", async () => {
    const store = storeFor({ principalId: "person-1", name: "Test Person" });
    await activateSyntheticWarningDefinition(store);
    await store.eir.saveDraft(
      "person-1",
      { ...EIR_VALUES, mbiExpirationDate: "2024-01-15" },
      undefined,
      "1",
    );
    renderScreen(store);

    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    expect(await screen.findByText("Warnings do not prevent PDF generation.")).toBeInTheDocument();
    expect(screen.getByText("Before the MBI or staff-like access start date")).toBeInTheDocument();
    expect(await screen.findByText(/PDF generated with pre-check warnings/)).toBeInTheDocument();
    expect(screen.queryByText(/passed the EIR pre-check/)).not.toBeInTheDocument();

    fireEvent.change(field(/^Team or project/), { target: { value: "Changed after evaluation" } });
    const staleCopy = await screen.findByText(/pre-check is out of date because you edited/);
    expect(staleCopy).toHaveTextContent("Download PDF to sign checks the current draft again");
    expect(staleCopy.closest('[role="status"]')).toHaveStyle({
      color: "var(--color-gray-cool-80)",
      background: "var(--theme-warning-lighter)",
    });
  });

  it("a draft pinned to the bootstrap definition keeps its rules after bootstrap-2 ships: its header names it, and an NDA No isn't blocked (#217, #224)", async () => {
    // A store on the bootstrap definition, then on the fallback built-in, as a deploy of #217 does.
    let active: EirDefinition | undefined = BOOTSTRAP_1;
    const eir = createMemoryEirRepository({
      clock: () => NOW,
      definitions: { active: () => active, byId: (id) => BOOTSTRAP_EIR_DEFINITIONS.byId(id) },
    });
    const store = storeFor({ principalId: "person-1", name: "Test Person" }, eir);
    await store.eir.saveDraft(
      "person-1",
      { ...EIR_VALUES, ndaSigned: "no" },
      undefined,
      "bootstrap",
    );
    active = BOOTSTRAP_EIR_DEFINITIONS.active();
    expect(active?.form.version).toBe("bootstrap-2");
    renderScreen(store);

    expect(await screen.findByText("bootstrap (version 0)")).toBeInTheDocument();
    expect(screen.queryByText("bootstrap-2 (version 0)")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    expect(
      await screen.findByText(/PDF generated for manual Safeguards handling/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();
    expect(await store.eir.get("person-1")).toMatchObject({
      draftFormVersion: "bootstrap",
      evaluation: { outcome: "manual-review", definitionVersion: "bootstrap" },
    });
  });

  it("EIR screen renders the definition-driven form identically to today", async () => {
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }));
    await screen.findByRole("textbox", { name: /^User ID/ });
    // Form 1.3 as it rendered before #200, written out: sections in order, then
    // each control by its accessible name, in order.
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.querySelector("legend")?.textContent)
        .filter((legend) =>
          ["User details", "Your manager", "Compliance", "Declaration"].includes(legend ?? ""),
        ),
    ).toEqual(["User details", "Your manager", "Compliance", "Declaration"]);
    const labelled = [
      ["textbox", /^User ID/],
      ["textbox", /^First name/],
      ["textbox", /^Last name/],
      ["textbox", /^Work email/],
      ["textbox", /^Team or project/],
      ["textbox", /^Sub-team or sub-project/],
      ["textbox", /^Contracting company/],
      ["textbox", /^Manager's first name/],
      ["textbox", /^Manager's last name/],
      ["textbox", /^Manager's user ID/],
      ["textbox", /^Manager's work email/],
      ["radiogroup", /IRM 10\.5\.8 manual transmittal/],
      ["radiogroup", /IRS non-disclosure agreement \(NDA\)/],
      ["radiogroup", /preliminary or incomplete background investigation/],
    ] as const;
    for (const [role, name] of labelled) {
      expect(screen.getByRole(role, { name }), String(name)).toBeInTheDocument();
    }
    for (const name of [
      /^Unauthorized Access training date/,
      /^Privacy training date/,
      /^Cyber Awareness training date/,
      /^MBI or staff-like access start date/,
      /^MBI or staff-like access expiration date/,
    ]) {
      expect(screen.getByLabelText(name)).toHaveAttribute("type", "date");
    }
    expect(screen.getByRole("checkbox", { name: "I agree" })).not.toBeChecked();
    // The fallback built-in (#217, #224): the bootstrap's questions, every rule blocking.
    expect(screen.getByText("bootstrap-2 (version 0)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Training is yearly: each date should be within the year before the day the form is checked, and not in the future.",
      ),
    ).toBeInTheDocument();
  });

  it("pre-fills the work email and name from the session, never the manager", async () => {
    renderScreen(
      storeFor({
        principalId: "person-1",
        name: "Display Name",
        givenName: "Test",
        familyName: "Person",
      }),
    );
    expect(await screen.findByRole("textbox", { name: /^Work email/ })).toHaveValue(
      "test.person@example.gov",
    );
    expect(field(/^First name/)).toHaveValue("Test");
    expect(field(/^Last name/)).toHaveValue("Person");
    expect(field(/^Manager's user ID/)).toHaveValue("");
    expect(field(/^Manager's work email/)).toHaveValue("");
    expect(
      screen.getByText(/Your current manager: an IRS full-time employee who can confirm/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/alternative manager/i)).toBeNull();
    expect(screen.queryByText(/live-data waiver/i)).toBeNull();
  });

  it("announces what's missing, focuses the summary, links each answer, and saves nothing", async () => {
    const store = storeFor({ principalId: "person-1", name: "Test Person" });
    renderScreen(store);
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));

    const summary = await screen.findByRole("region", { name: /Check \d+ answers/ });
    await waitFor(() => expect(summary).toHaveFocus());
    const userId = field(/^User ID/);
    expect(userId).toHaveAttribute("aria-invalid", "true");
    expect(userId.getAttribute("aria-describedby")).toContain("eir-field-userId-error");
    expect(document.getElementById("eir-field-userId-error")).toHaveTextContent("Enter user ID.");
    expect(screen.getByRole("checkbox", { name: /I agree/ })).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    fireEvent.click(within(summary).getByRole("link", { name: "Enter user ID." }));
    expect(userId).toHaveFocus();
    // Nothing was started or saved.
    expect(await store.eir.get("person-1")).toMatchObject({ stage: "not-started", actions: [] });
    expect((await store.eir.get("person-1")).recordId).toBeUndefined();
  });

  it("keeps focus and every keystroke in a field fixed after a failed download, and refocuses the summary on each failed attempt (#179)", async () => {
    const user = userEvent.setup();
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }));
    await user.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    const summary = await screen.findByRole("region", { name: /Check \d+ answers/ });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(summary).toHaveAttribute("aria-live", "polite");
    const before = within(summary).getAllByRole("link").length;

    await user.click(within(summary).getByRole("link", { name: "Enter user ID." }));
    const userId = field(/^User ID/);
    expect(userId).toHaveFocus();
    await user.keyboard("A1B2C");
    expect(userId).toHaveFocus();
    expect(userId).toHaveValue("A1B2C");
    // The summary keeps up as answers are fixed, without taking focus.
    expect(within(summary).queryByRole("link", { name: "Enter user ID." })).toBeNull();
    expect(within(summary).getAllByRole("link")).toHaveLength(before - 1);
    await user.tab();
    expect(userId).not.toHaveFocus();
    expect(summary).not.toHaveFocus();

    // Another failed attempt moves focus to the summary again.
    await user.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /Check \d+ answers/ })).toHaveFocus(),
    );
  });
  it("keeps focus in the manager's email, a date and a Yes/No answer edited after a failed download (#179)", async () => {
    const user = userEvent.setup();
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }));
    const email = await screen.findByRole("textbox", { name: /^Manager's work email/ });
    await user.type(email, "test.managerexample.gov");
    await user.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    const summary = await screen.findByRole("region", { name: /Check \d+ answers/ });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(email).toHaveAttribute("aria-invalid", "true");

    // Each edit keeps focus and its keystrokes in the field.
    const edit = async (keys: string, value: string) => {
      await user.keyboard(keys);
      expect(email).toHaveFocus();
      expect(email).toHaveValue(value);
    };
    await user.click(email);
    await edit("{Backspace}{Backspace}{Backspace}", "test.managerexample.");
    await edit("gov", "test.managerexample.gov");
    await edit("{Home}{ArrowRight>12/}@", "test.manager@example.gov");
    await edit("{Delete}{Delete}", "test.manager@ample.gov");
    await user.keyboard("{Control>}a{/Control}");
    await edit("test.manager@example.gov", "test.manager@example.gov");
    expect(email).not.toHaveAttribute("aria-invalid");

    const date = screen.getByLabelText(/^Privacy training date/);
    await user.click(within(summary).getByRole("link", { name: /privacy training/i }));
    expect(date).toHaveFocus();
    await user.type(date, "2026-06-02");
    expect(date).toHaveFocus();
    expect(date).toHaveValue("2026-06-02");

    const nda = screen.getByRole("radiogroup", { name: /IRS non-disclosure/ });
    const yes = within(nda).getByRole("radio", { name: "Yes" });
    await user.click(yes);
    expect(yes).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(within(nda).getByRole("radio", { name: "No" })).toHaveFocus();
    expect(within(nda).getByRole("radio", { name: "No" })).toBeChecked();
    expect(summary).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /Check \d+ answers/ })).toHaveFocus(),
    );
  });

  it("clears an answer's error as it's fixed", async () => {
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    await waitFor(() => expect(document.getElementById("eir-field-userId-error")).not.toBeNull());
    fireEvent.change(field(/^User ID/), { target: { value: "A1B2C" } });
    expect(document.getElementById("eir-field-userId-error")).toBeNull();
    expect(screen.queryByRole("link", { name: "Enter user ID." })).toBeNull();
    expect(field(/^User ID/)).not.toHaveAttribute("aria-invalid");
  });

  it("keeps every answer of a saved draft across a reload, and Cancel request discards unsaved edits", async () => {
    const store = storeFor({ principalId: "person-1", name: "Test Person" });
    renderScreen(store);
    fireEvent.change(await screen.findByRole("textbox", { name: /^User ID/ }), {
      target: { value: "A1B2C" },
    });
    fireEvent.change(field(/^Manager's work email/), {
      target: { value: "test.manager@example.gov" },
    });
    fireEvent.change(screen.getByLabelText(/^Privacy training date/), {
      target: { value: "2026-06-02" },
    });
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: /IRS non-disclosure/ })).getByRole("radio", {
        name: "No",
      }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/Draft saved/)).toBeInTheDocument();

    cleanup();
    renderScreen(store);
    expect(await screen.findByRole("textbox", { name: /^User ID/ })).toHaveValue("A1B2C");
    expect(field(/^Manager's work email/)).toHaveValue("test.manager@example.gov");
    expect(screen.getByLabelText(/^Privacy training date/)).toHaveValue("2026-06-02");
    const nda = screen.getByRole("radiogroup", { name: /IRS non-disclosure/ });
    expect(within(nda).getByRole("radio", { name: "No" })).toBeChecked();
    expect(within(nda).getByRole("radio", { name: "Yes" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I agree/ })).toBeChecked();

    fireEvent.change(field(/^User ID/), { target: { value: "Z9Z9Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(field(/^User ID/)).toHaveValue("A1B2C");
    expect(await screen.findByText("Changes discarded. Nothing was saved.")).toBeInTheDocument();
    expect((await store.eir.get("person-1")).draftValues?.["userId"]).toBe("A1B2C");
  });

  it("shows the validator every answer, with each flag highlighted, and never blocks the submission", async () => {
    // Form 1.3's rules flag compliance answers for the validator (bootstrap-1).
    const eir = createMemoryEirRepository({ clock: () => NOW, definitions: onBootstrap1 });
    const store = storeFor(
      { principalId: "validator-1", name: "Val Idator", validator: true },
      eir,
    );
    await eir.submit("person-1", "Test Person", "/Volumes/edp/docs/eir/person-1/one.pdf", {
      ...EIR_VALUES,
      ndaSigned: "no",
      mbiPreliminary: "yes",
      privacyTrainingDate: "2024-01-01",
    });
    renderScreen(store);

    const flags = await screen.findByRole("note", { name: "Flags for Test Person" });
    expect(within(flags).getByText(/3 flags for your decision/)).toBeInTheDocument();
    for (const text of [
      /\(NDA\)\?: IRS NDA not signed/,
      /background investigation\?: Preliminary or incomplete background investigation/,
      /Privacy training date: More than a year before the form was started/,
    ]) {
      expect(within(flags).getByText(text)).toBeInTheDocument();
    }
    const answers = screen
      .getByText(/^Answers · EIR-[0-9A-HJKMNP-TV-Z]{6} · bootstrap \(version 0\)$/)
      .closest("details")!;
    expect(answers).toHaveAttribute("open");
    const flagged = answers.querySelectorAll("[data-flagged]");
    expect(flagged).toHaveLength(3);
    expect(within(answers).getByText("A1B2C")).toBeInTheDocument();
    expect(within(answers).getByText("test.manager@example.gov")).toBeInTheDocument();
    expect(within(answers).getByRole("region", { name: "Declaration" })).toHaveTextContent(
      "I agreeYes",
    );
  });

  it("legacy-form records render read-only to the person and validator", async () => {
    const legacy = {
      principalId: "person-1",
      personName: "Test Person",
      recordId: "EIR-1001",
      stage: "valid" as const,
      expiresAt: "2027-01-01T00:00:00.000Z",
      formValues: EIR_STUB_VALUES,
      formVersion: "0.1",
      submissions: [
        {
          volumePath: "/Volumes/edp/docs/eir/person-1/old.pdf",
          submittedAt: "2026-09-01T12:00:00.000Z",
          formValues: EIR_STUB_VALUES,
          formVersion: "0.1",
          kind: "first" as const,
        },
      ],
      actions: [],
    };
    const eir = createMemoryEirRepository({ clock: () => NOW, initialRecords: [legacy] });
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }, eir));
    expect((await screen.findByText(/Legacy answers:/)).closest("p")).toHaveTextContent(
      "Interim checklist (before EIR form 1.2), form 0.1",
    );
    expect(screen.getByText("Synthetic test record")).toBeInTheDocument();
    // The renewal starts on the current form, not from the legacy answers.
    expect(screen.getByRole("textbox", { name: /^Team or project/ })).toHaveValue("");

    cleanup();
    const validatorEir = createMemoryEirRepository({ clock: () => NOW, initialRecords: [legacy] });
    renderScreen(
      storeFor({ principalId: "validator-1", name: "Val Idator", validator: true }, validatorEir),
    );
    const answers = (await screen.findByText("Answers · EIR-1001 · form 0.1")).closest("details")!;
    expect(within(answers).getByText(/Legacy answers:/)).toBeInTheDocument();
    expect(within(answers).getByText("Full legal name")).toBeInTheDocument();
    expect(screen.queryByText(/flags for your decision/)).toBeNull();
  });

  it("marks Contracting company optional and every compliance item required", async () => {
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }));
    const company = await screen.findByRole("textbox", { name: /^Contracting company/ });
    expect(company).not.toHaveAttribute("aria-required");
    expect(screen.getByText("Contracting company").closest("label")).toHaveTextContent(
      "(optional)",
    );
    for (const name of [
      /^Unauthorized Access training date/,
      /^Privacy training date/,
      /^Cyber Awareness training date/,
      /^MBI or staff-like access start date/,
      /^MBI or staff-like access expiration date/,
    ]) {
      const date = screen.getByLabelText(name);
      expect(date).toHaveAttribute("aria-required", "true");
      expect(date.closest("div")!.querySelector("label")).not.toHaveTextContent("(optional)");
    }
    for (const name of [/IRM 10\.5\.8/, /IRS non-disclosure/, /preliminary or incomplete/]) {
      const group = screen.getByRole("radiogroup", { name });
      expect(group).toHaveAttribute("aria-required", "true");
      // Unanswered is neither Yes nor No.
      const [yes, no] = within(group).getAllByRole("radio");
      expect(yes).toHaveAccessibleName("Yes");
      expect(no).toHaveAccessibleName("No");
      expect(yes).not.toBeChecked();
      expect(no).not.toBeChecked();
    }
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/not always listed/i)).toBeNull();
  });

  it("refuses an unanswered yes/no on screen: announced, linked, focused, URL unchanged", async () => {
    const store = storeFor({ principalId: "person-1", name: "Test Person" });
    renderScreen(store);
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    const summary = await screen.findByRole("region", { name: /Check \d+ answers/ });
    const nda = screen.getByRole("radiogroup", { name: /IRS non-disclosure/ });
    expect(nda).toHaveAttribute("aria-invalid", "true");
    expect(nda).toHaveAccessibleDescription(/^Choose Yes or No: Have you agreed/);
    for (const name of [/^Choose Yes or No: Have you read/, /^Choose Yes or No: Does your MBI/]) {
      expect(within(summary).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(summary).getByRole("link", { name: /^Enter cyber awareness training date/ }));
    expect(within(summary).queryByRole("link", { name: /contracting company/i })).toBeNull();
    const before = window.location.href;
    fireEvent.click(
      within(summary).getByRole("link", { name: /^Choose Yes or No: Have you agreed/ }),
    );
    expect(within(nda).getByRole("radio", { name: "Yes" })).toHaveFocus();
    expect(window.location.href).toBe(before);

    // A No is an answer: its error goes, and it doesn't come back.
    fireEvent.click(within(nda).getByRole("radio", { name: "No" }));
    expect(nda).not.toHaveAttribute("aria-invalid");
    expect(within(summary).queryByRole("link", { name: /Have you agreed/ })).toBeNull();
    expect(await store.eir.get("person-1")).toMatchObject({ stage: "not-started", actions: [] });
  });

  it("opens a form 1.2 draft in form 1.3, and shows a submitted 1.2 EIR with its own labels", async () => {
    const draft12 = { ...EIR_VALUES, mbiExpirationDate: "", team: "Drafted Team" };
    const eir = createMemoryEirRepository({
      clock: () => NOW,
      initialRecords: [
        {
          principalId: "person-1",
          personName: "Test Person",
          recordId: "EIR-1001",
          stage: "not-started",
          draftValues: draft12,
          draftFormVersion: "1.2",
          submissions: [],
          actions: [],
        },
        {
          principalId: "person-2",
          personName: "Sample Applicant",
          recordId: "EIR-1002",
          stage: "submitted",
          formValues: { ...EIR_VALUES, mbiExpirationDate: "" },
          formVersion: "1.2",
          submissions: [
            {
              volumePath: "/Volumes/edp/docs/eir/person-2/one.pdf",
              submittedAt: "2026-09-30T12:00:00.000Z",
              formVersion: "1.2",
              kind: "first" as const,
            },
          ],
          actions: [],
        },
      ],
    });
    renderScreen(storeFor({ principalId: "person-1", name: "Test Person" }, eir));
    const team = await screen.findByRole("textbox", { name: /^Team or project/ });
    await waitFor(() => expect(team).toHaveValue("Drafted Team"));
    // Nothing is filled in for what the 1.2 draft left blank: it's now required.
    expect(screen.getByLabelText(/^MBI or staff-like access expiration date/)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    expect(
      await screen.findByRole("link", { name: "Enter MBI or staff-like access expiration date." }),
    ).toBeInTheDocument();

    cleanup();
    renderScreen(storeFor({ principalId: "person-2", name: "Sample Applicant" }, eir));
    expect(await screen.findByRole("heading", { name: "Submitted EIR form" })).toBeInTheDocument();
    expect(screen.getByText("form 1.2")).toBeInTheDocument();
    const row = screen
      .getByText("Your contractor MBI / staff-like access expiration date (not always listed)")
      .closest("div")!;
    expect(row).toHaveTextContent("Not answered");
  });

  it("shows an EIR submitted on form 1.3 with its own label and labels, after the bootstrap became version 0 (#224)", async () => {
    const eir = createMemoryEirRepository({
      clock: () => NOW,
      initialRecords: [
        {
          principalId: "person-2",
          personName: "Sample Applicant",
          recordId: "EIR-1002",
          stage: "submitted",
          formValues: EIR_VALUES,
          formVersion: "1.3",
          submissions: [
            {
              volumePath: "/Volumes/edp/docs/eir/person-2/one.pdf",
              submittedAt: "2026-09-30T12:00:00.000Z",
              formVersion: "1.3",
              kind: "first" as const,
            },
          ],
          actions: [],
        },
      ],
    });
    renderScreen(storeFor({ principalId: "person-2", name: "Sample Applicant" }, eir));
    expect(await screen.findByRole("heading", { name: "Submitted EIR form" })).toBeInTheDocument();
    expect(screen.getByText("form 1.3")).toBeInTheDocument();
    expect(screen.getByText("Team or project").closest("div")).toHaveTextContent("Test Team");
    expect(
      screen.getByText("Have you agreed to and signed the IRS non-disclosure agreement (NDA)?"),
    ).toBeInTheDocument();
  });
});
