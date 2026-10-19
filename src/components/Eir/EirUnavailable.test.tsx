import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_PRIVACY_NOTICE, createMemoryStore, StoreProvider } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import { createMemoryEirRepository } from "@/data/eir/repository";
import { createMemoryPrivacyAcknowledgmentRepository } from "@/data/privacy/repository";
import { EirScreen } from "./EirScreen";

// The edge: the bootstrap definition file, as shipped, is broken.
vi.mock("@/data/eir/definition/bootstrap-source.ts", () => ({
  readBootstrapEirSource: () => "validityDays: 365\nform: [unclosed\n",
}));

afterEach(cleanup);

describe("EIR with an invalid bootstrap definition", () => {
  it("invalid bootstrap definition shows an honest unavailable state and allows no draft save", async () => {
    const eir = createMemoryEirRepository();
    const identity = {
      principalId: "person-1",
      displayName: "Test Person",
      actorApp: "tenant" as const,
    };
    const store = createMemoryStore(makeSnapshot(), {
      eirRepository: eir,
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
              acknowledgedAt: "2026-10-01T12:00:00.000Z",
            },
          ],
        },
      }),
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Employee Identity Record (EIR)" }),
    ).toBeVisible();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "The EIR form is temporarily unavailable. Nothing has been saved.",
    );
    expect(alert).toHaveTextContent(
      "This is a problem on our side. Try again later, or contact EDP staff if it keeps happening.",
    );
    expect(alert).not.toHaveTextContent(/definition/i);
    // A way out: back to Home.
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "#home");
    // No form to fill in, nothing to save, sign or upload, and no guessed fields.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save|download|upload|submit/i })).toBeNull();

    await expect(eir.saveDraft("person-1", EIR_VALUES)).rejects.toMatchObject({ status: 503 });
    expect((await eir.get("person-1")).draftValues).toBeUndefined();
  });
});
