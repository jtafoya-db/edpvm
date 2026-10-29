import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_PRIVACY_NOTICE, createMemoryStore, StoreProvider } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import type { EirApprovalConfig } from "@/data/eir/approval-mode";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import { createMemoryPrivacyAcknowledgmentRepository } from "@/data/privacy/repository";
import { EirScreen } from "./EirScreen";
import { EirValidatorSection } from "./EirValidatorSection";

/**
 * #204 on the employee's My EIR screen and the validator's EIR validation
 * section, through the public hooks over the memory store. The store's
 * active definition is a synthetic published version 1 (the bootstrap
 * definition's rules, published), on a fixed clock.
 */

const CLOCK = () => new Date("2026-10-01T12:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function storeIn(approval: EirApprovalConfig) {
  const store = createMemoryStore(makeSnapshot(), {
    clock: CLOCK,
    eirApproval: approval,
    privacyAcknowledgmentRepository: createMemoryPrivacyAcknowledgmentRepository({
      identity: { principalId: "person-1", displayName: "Test Person", actorApp: "tenant" },
      state: {
        acknowledgments: [
          {
            noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
            contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
            principalId: "person-1",
            actorDisplay: "Test Person",
            actorApp: "tenant",
            acknowledgedAt: "2026-10-01T12:00:00.000Z",
          },
        ],
      },
    }),
  });
  const person = { ...makeSnapshot().user, principalId: "person-1", name: "Test Person" };
  // Safeguards publishes and activates a synthetic version 1.
  store.catalog.getUser = async () => ({ ...person, isSafeguardsValidator: true });
  await store.eirDefinitions.publish({
    sourceYaml: readBootstrapEirSource("bootstrap")!,
    expectedVersion: 0,
  });
  await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
  store.catalog.getUser = async () => ({ ...person, isSafeguardsValidator: false });
  await store.eir.saveDraft("person-1", EIR_VALUES, undefined, "1");
  return store;
}

async function signAndSubmit(store: Awaited<ReturnType<typeof storeIn>>) {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
  expect(await screen.findByText(/PDF generated/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
    target: { files: [new File(["%PDF-1.7 signed"], "signed.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Submit for validation" }));
}

describe("the approval mode on the EIR screens (#204)", () => {
  it("manual-validator: the upload waits for a safeguards validator, as before", async () => {
    const store = await storeIn({ mode: "manual-validator", automaticValidityOutcomes: ["pass"] });
    await signAndSubmit(store);
    expect(
      await screen.findByText("Submitted for validation. With a safeguards validator."),
    ).toBeInTheDocument();
    expect((await store.eir.get("person-1")).stage).toBe("submitted");
  });

  it("automatic: a passing upload is valid at once, and says the app recorded it", async () => {
    const store = await storeIn({ mode: "automatic", automaticValidityOutcomes: ["pass"] });
    await signAndSubmit(store);
    expect(
      await screen.findByText(
        "Valid. Your EIR met the rules for automatic validity, so the app recorded it as valid. A safeguards validator can still revoke it.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("10/1/2027")).toBeInTheDocument();
    // The screen claims nothing about the signature itself.
    expect(document.body).not.toHaveTextContent(/signature (was )?(verified|checked)/i);
  });

  it("the validator sees who recorded it valid, what it rested on, and that it isn't authorized for production", async () => {
    const store = await storeIn({ mode: "automatic", automaticValidityOutcomes: ["pass"] });
    await store.eir.preparePdf({
      principalId: "person-1",
      personName: "Test Person",
      values: EIR_VALUES,
      expectedDraftVersion: 1,
      formVersion: "1",
    });
    await store.eir.submitWithFile({
      principalId: "person-1",
      personName: "Test Person",
      file: new File(["%PDF-1.7 signed"], "signed.pdf", { type: "application/pdf" }),
      values: EIR_VALUES,
      formVersion: "1",
    });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirValidatorSection />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const note = await screen.findByRole("note", { name: "Automatic validity for Test Person" });
    expect(note).toHaveTextContent(
      "Recorded valid automatically by EDP Vending Machine on 10/1/2026: the pre-check at upload passed on EIR definition version 1.",
    );
    expect(note).toHaveTextContent(
      "Automatic validity isn't authorized for production use until Safeguards signs off. You can still revoke this EIR.",
    );
    expect(
      within(note.closest("article")!).getByRole("button", { name: /Revoke/ }),
    ).toBeInTheDocument();
  });
});
