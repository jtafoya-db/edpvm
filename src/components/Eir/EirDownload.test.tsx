import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_PRIVACY_NOTICE, createMemoryStore, StoreProvider } from "@/data";
import { DeltaApiError } from "@/data/api-response";
import { queryKeys } from "@/data/queries";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import type { EirPdfPreparation, EirPreparedPdf, EirRepository } from "@/data/eir/repository";
import { createMemoryPrivacyAcknowledgmentRepository } from "@/data/privacy/repository";
import { EirScreen } from "./EirScreen";

/**
 * #235 at the employee screen: Download PDF to sign blocks at once in the
 * browser when the pinned definition's rules say so, sending nothing; and
 * when it does go to the server, the form stays as it is (mounted, visible,
 * editable) and an answer typed meanwhile never goes into the PDF.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function storeFor() {
  const identity = {
    principalId: "person-1",
    displayName: "Test Person",
    actorApp: "tenant" as const,
  };
  const store = createMemoryStore(makeSnapshot(), {
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
  store.catalog.getUser = async () => ({
    ...makeSnapshot().user,
    principalId: "person-1",
    name: "Test Person",
    email: "test.person@example.gov",
    isSafeguardsValidator: false,
  });
  return store;
}
type Store = ReturnType<typeof storeFor>;

/** Safeguards publishes and activates `yaml` as version 1. */
async function activatePublished(store: Store, yaml: string) {
  const getUser = store.catalog.getUser;
  store.catalog.getUser = async () => ({ ...(await getUser()), isSafeguardsValidator: true });
  await store.eirDefinitions.publish({ sourceYaml: yaml, expectedVersion: 0 });
  await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
  store.catalog.getUser = getUser;
}

function renderScreen(
  store: Store,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
}

const team = () => screen.getByRole("textbox", { name: /^Team or project/ });
const download = () => screen.getByRole("button", { name: "Download PDF to sign" });
const formControls = () =>
  Array.from(
    screen.getByRole("form", { name: "EIR form" }).querySelectorAll("input, select, textarea"),
  );

/** Every EIR repository call from now on. */
function watchRepository(eir: EirRepository) {
  const names = [
    "get",
    "start",
    "saveDraft",
    "evaluateDraft",
    "generatePdf",
    "preparePdf",
    "submitWithFile",
    "respond",
  ] as const;
  const spies = names.map((name) => vi.spyOn(eir, name));
  return () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

/** Answer every question on screen, as the person would. */
function fillIn(values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) {
    const radio = document.querySelector<HTMLInputElement>(
      `input[type="radio"][name="eir-field-${id}"][value="${value}"]`,
    );
    const input = document.getElementById(`eir-field-${id}`) as HTMLInputElement | null;
    if (radio) fireEvent.click(radio);
    else if (input?.type === "checkbox") {
      if (input.checked !== (value === "yes")) fireEvent.click(input);
    } else if (input) fireEvent.change(input, { target: { value } });
  }
}

async function loaded(values: Record<string, string>) {
  await waitFor(() => expect(team()).toHaveValue(values["team"]));
}

describe("Download PDF to sign: the instant pre-check (#235)", () => {
  it("a blocking answer shows its guidance at once, focuses the summary, and sends nothing", async () => {
    const store = storeFor();
    const values = { ...EIR_VALUES, ndaSigned: "no" };
    await store.eir.saveDraft("person-1", values);
    renderScreen(store);
    await loaded(values);
    const calls = watchRepository(store.eir);

    fireEvent.click(download());

    // At once: no await, no progress shown.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Correct the highlighted fields.");
    expect(alert).toHaveTextContent("[Placeholder wording] Sign the IRS NDA, then answer Yes.");
    expect(document.getElementById("eir-field-ndaSigned-error")).toHaveTextContent(
      "Sign the IRS NDA",
    );
    expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
    const summary = screen.getByRole("region", { name: "Check 1 answer" });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(calls()).toBe(0);
  });

  it("blocks at once on a published definition too, from the rules the forms read sent", async () => {
    const store = storeFor();
    // bootstrap-2's YAML published as version 1: every rule blocks.
    await activatePublished(store, readBootstrapEirSource("bootstrap-2")!);
    const values = { ...EIR_VALUES, ndaSigned: "no" };
    await store.eir.saveDraft("person-1", values, undefined, "1");
    renderScreen(store);
    await loaded(values);
    const calls = watchRepository(store.eir);

    fireEvent.click(download());

    expect(screen.getByRole("alert")).toHaveTextContent("Sign the IRS NDA, then answer Yes.");
    expect(calls()).toBe(0);
  });

  it("without the definition's rules, the server decides: its block shows the same guidance and focus", async () => {
    const store = storeFor();
    await activatePublished(store, readBootstrapEirSource("bootstrap-2")!);
    const forms = store.eirForms.forms.bind(store.eirForms);
    // A forms answer without rules (an older server, or an entry the browser dropped).
    store.eirForms.forms = async (versions) => ({ ...(await forms(versions)), rules: {} });
    const values = { ...EIR_VALUES, ndaSigned: "no" };
    await store.eir.saveDraft("person-1", values, undefined, "1");
    renderScreen(store);
    await loaded(values);
    const prepare = vi.spyOn(store.eir, "preparePdf");

    fireEvent.click(download());

    expect(
      await screen.findByText("[Placeholder wording] Sign the IRS NDA, then answer Yes.", {
        selector: "#eir-field-ndaSigned-error, #eir-field-ndaSigned-error *",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Check 1 answer" })).toHaveFocus(),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/PDF generated/)).toBeNull();
  });
});

describe("Download PDF to sign: the form stays as it is (#235)", () => {
  function holdPreparePdf(store: Store) {
    const real = store.eir.preparePdf.bind(store.eir);
    const gate = deferred<void>();
    const sent: EirPdfPreparation[] = [];
    store.eir.preparePdf = vi.fn(async (input: EirPdfPreparation): Promise<EirPreparedPdf> => {
      sent.push(structuredClone(input));
      await gate.promise;
      return real(input);
    });
    return { gate, sent };
  }

  it("keeps every field mounted and editable, says what's happening, and never puts an edit typed meanwhile into the PDF", async () => {
    const store = storeFor();
    await store.eir.saveDraft("person-1", EIR_VALUES);
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:eir");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { gate, sent } = holdPreparePdf(store);
    renderScreen(store);
    await loaded(EIR_VALUES);
    const field = team();

    fireEvent.click(download());

    expect(
      await screen.findByText(/Preparing your PDF\. You can keep editing/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    for (const control of formControls()) expect(control).toBeEnabled();
    fireEvent.change(field, { target: { value: "Typed while it prepared" } });

    await act(async () => gate.resolve());

    expect(
      await screen.findByText(/You changed your answers while the PDF was being prepared/),
    ).toBeInTheDocument();
    expect(team()).toBe(field);
    expect(field).toHaveValue("Typed while it prepared");
    expect(objectUrl).not.toHaveBeenCalled();
    // What was sent is the answers at the click.
    expect(sent[0]).toMatchObject({ values: EIR_VALUES, expectedDraftVersion: 1 });

    // Another Download sends what's on screen now, on the version the first one saved.
    fireEvent.click(download());
    expect(
      await screen.findByText(/PDF generated after the saved draft passed/),
    ).toBeInTheDocument();
    expect(objectUrl).toHaveBeenCalledTimes(1);
    expect(sent[1]).toMatchObject({
      values: { ...EIR_VALUES, team: "Typed while it prepared" },
      expectedDraftVersion: 2,
    });
    expect(field).toHaveValue("Typed while it prepared");
  });

  it("keeps focus and every keystroke in the field being typed in when the PDF is ready, whether it's stale or downloaded (UX-1)", async () => {
    const store = storeFor();
    await store.eir.saveDraft("person-1", EIR_VALUES);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:eir");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderScreen(store);
    await loaded(EIR_VALUES);
    const field = team();

    // Stale: typing while it prepares, and still typing when it finishes.
    let { gate } = holdPreparePdf(store);
    fireEvent.click(download());
    field.focus();
    await user.keyboard(" A");
    await act(async () => gate.resolve());
    expect(
      await screen.findByText(/You changed your answers while the PDF was being prepared/),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(field);
    await user.keyboard("B");
    expect(field).toHaveValue(`${EIR_VALUES["team"]} AB`);

    // Downloaded: the person is in a field, and stays there.
    ({ gate } = holdPreparePdf(store));
    fireEvent.click(download());
    field.focus();
    await act(async () => gate.resolve());
    expect(
      await screen.findByText(/PDF generated after the saved draft passed/),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(field);
    await user.keyboard("C");
    expect(field).toHaveValue(`${EIR_VALUES["team"]} ABC`);
  });

  it("on a published definition, the form never unmounts or locks while its forms are read again", async () => {
    const store = storeFor();
    await activatePublished(store, readBootstrapEirSource("bootstrap")!);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:eir");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    // The read for the draft's own version (after the first save pins it) waits.
    const forms = store.eirForms.forms.bind(store.eirForms);
    const formsGate = deferred<void>();
    store.eirForms.forms = async (versions) => {
      if (versions.includes("1")) await formsGate.promise;
      return forms(versions);
    };
    renderScreen(store);
    await waitFor(() => expect(team()).toBeEnabled());
    fillIn(EIR_VALUES);
    const field = team();

    fireEvent.click(download());
    expect(await screen.findByText(/PDF generated/)).toBeInTheDocument();

    expect(screen.queryByText(/Loading EIR/)).toBeNull();
    expect(team()).toBe(field);
    for (const control of formControls()) expect(control).toBeEnabled();
    await act(async () => formsGate.resolve());
    expect(team()).toBe(field);
  });
});

describe("Download PDF to sign: refused because the EIR changed elsewhere", () => {
  const STALE_BANNER = /pre-check is out of date because you edited/;
  const RELOAD =
    "This changed since you opened it. Reload to see the latest. Reloading discards any changes on this screen that aren't saved.";

  async function downloadedThenMovedOn() {
    const store = storeFor();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await store.eir.saveDraft("person-1", EIR_VALUES);
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:eir");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderScreen(store, client);
    await loaded(EIR_VALUES);
    await user.click(download());
    expect(
      await screen.findByText(/PDF generated after the saved draft passed/),
    ).toBeInTheDocument();
    // Another tab saves this person's draft: this screen's version is now behind.
    await store.eir.saveDraft("person-1", { ...EIR_VALUES, team: "Saved in another tab" });
    await user.click(team());
    await user.keyboard(" Edited");
    expect(await screen.findByText(STALE_BANNER)).toBeInTheDocument();
    return { store, user, objectUrl, client };
  }

  /** The EIR is read again in place (a refetch on focus, say): no remount. */
  async function refetchedInPlace(client: QueryClient) {
    await act(() => client.refetchQueries({ queryKey: queryKeys.eir("person-1") }));
    await loaded({ team: "Saved in another tab" });
  }

  it("says only to reload, warning that unsaved edits go, and never that Download checks again", async () => {
    const { store, user, objectUrl } = await downloadedThenMovedOn();
    const prepare = vi.spyOn(store.eir, "preparePdf");

    await user.click(download());

    expect(await screen.findByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
    expect(objectUrl).toHaveBeenCalledTimes(1);
    expect(team()).toHaveValue(`${EIR_VALUES["team"]} Edited`);
    // Download again is refused the same way: still only the reload instruction.
    await user.click(download());
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
    expect(objectUrl).toHaveBeenCalledTimes(1);
    // Nothing from this screen was saved.
    expect(await store.eir.get("person-1")).toMatchObject({
      draftValues: { team: "Saved in another tab" },
    });
  });

  it("keeps focus and every keystroke in the field when that refusal lands while typing (UX-1)", async () => {
    const { store, user } = await downloadedThenMovedOn();
    const real = store.eir.preparePdf.bind(store.eir);
    const gate = deferred<void>();
    store.eir.preparePdf = vi.fn(async (input: EirPdfPreparation) => {
      await gate.promise;
      return real(input);
    });
    const field = team();

    fireEvent.click(download());
    field.focus();
    await user.keyboard("A");
    await act(async () => gate.resolve());

    expect(await screen.findByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
    expect(document.activeElement).toBe(field);
    await user.keyboard("B");
    expect(field).toHaveValue(`${EIR_VALUES["team"]} EditedAB`);
  });

  it("Save draft refused the same way says only to reload too", async () => {
    const { store, user } = await downloadedThenMovedOn();
    store.eir.saveDraft = vi.fn(async () => {
      throw new DeltaApiError(
        409,
        "version-conflict",
        "This changed since you opened it. Reload to see the latest.",
      );
    });

    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
    expect(team()).toHaveValue(`${EIR_VALUES["team"]} Edited`);
  });

  it("after a reload, an edit shows the out-of-date pre-check again", async () => {
    const { store, user } = await downloadedThenMovedOn();
    await user.click(download());
    expect(await screen.findByText(RELOAD)).toBeInTheDocument();

    cleanup();
    renderScreen(store);
    await loaded({ team: "Saved in another tab" });
    expect(screen.queryByText(RELOAD)).not.toBeInTheDocument();
    await user.click(team());
    await user.keyboard(" Again");
    expect(await screen.findByText(STALE_BANNER)).toBeInTheDocument();
  });

  it("after Save draft's refusal, an in-place read of the EIR brings the out-of-date pre-check back on the next edit", async () => {
    const { store, user, client } = await downloadedThenMovedOn();
    const realSaveDraft = store.eir.saveDraft.bind(store.eir);
    store.eir.saveDraft = vi.fn(async () => {
      throw new DeltaApiError(
        409,
        "version-conflict",
        "This changed since you opened it. Reload to see the latest.",
      );
    });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
    store.eir.saveDraft = realSaveDraft;

    await refetchedInPlace(client);
    // The read superseded the refusal: its notice is gone, so it can't contradict the banner.
    expect(screen.queryByText(RELOAD)).not.toBeInTheDocument();
    await user.click(team());
    await user.keyboard(" Again");

    expect(await screen.findByText(STALE_BANNER)).toBeInTheDocument();
    expect(screen.queryByText(RELOAD)).not.toBeInTheDocument();
  });

  it("after Download's refusal, an in-place read of the EIR brings the out-of-date pre-check back on the next edit", async () => {
    const { user, client } = await downloadedThenMovedOn();
    await user.click(download());
    expect(await screen.findByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();

    await refetchedInPlace(client);
    expect(screen.queryByText(RELOAD)).not.toBeInTheDocument();
    await user.click(team());
    await user.keyboard(" Again");

    expect(await screen.findByText(STALE_BANNER)).toBeInTheDocument();
    expect(screen.queryByText(RELOAD)).not.toBeInTheDocument();
  });

  /** The person's details are read again, and the EIR isn't. */
  async function userReadAgain(store: Store, client: QueryClient) {
    const getUser = store.catalog.getUser;
    store.catalog.getUser = async () => ({ ...(await getUser()), title: "Analyst" });
    await act(() => client.refetchQueries({ queryKey: queryKeys.user() }));
  }

  it("a new read of the person, not the EIR, leaves Save draft's refusal standing", async () => {
    const { store, user, client } = await downloadedThenMovedOn();
    store.eir.saveDraft = vi.fn(async () => {
      throw new DeltaApiError(
        409,
        "version-conflict",
        "This changed since you opened it. Reload to see the latest.",
      );
    });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(RELOAD)).toBeInTheDocument();

    await userReadAgain(store, client);
    await user.click(team());
    await user.keyboard(" Again");

    expect(screen.getByText(RELOAD)).toBeInTheDocument();
    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
  });

  it("a new read of the person, not the EIR, leaves Download's refusal standing", async () => {
    const { store, user, client } = await downloadedThenMovedOn();
    await user.click(download());
    expect(await screen.findByText(RELOAD)).toBeInTheDocument();

    await userReadAgain(store, client);
    await user.click(team());
    await user.keyboard(" Again");

    expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
  });

  describe("ordering: a read supersedes a refusal only if it began after it", () => {
    const refuseSaveDraft = (store: Store) => {
      store.eir.saveDraft = vi.fn(async () => {
        throw new DeltaApiError(
          409,
          "version-conflict",
          "This changed since you opened it. Reload to see the latest.",
        );
      });
    };
    const saveDraft = () => screen.getByRole("button", { name: "Save draft" });

    /**
     * Refused while an EIR read is in flight, in the same millisecond it began:
     * the action is held, the read starts, then the refusal settles.
     */
    async function refusedWhileReadInFlight(
      store: Store,
      client: QueryClient,
      kind: "Save draft" | "Download",
    ) {
      const refusal = deferred<void>();
      if (kind === "Save draft") {
        store.eir.saveDraft = vi.fn(async () => {
          await refusal.promise;
          throw new DeltaApiError(
            409,
            "version-conflict",
            "This changed since you opened it. Reload to see the latest.",
          );
        });
      } else {
        const realPrepare = store.eir.preparePdf.bind(store.eir);
        store.eir.preparePdf = vi.fn(async (input: EirPdfPreparation) => {
          await refusal.promise;
          return realPrepare(input);
        });
      }
      fireEvent.click(kind === "Save draft" ? saveDraft() : download());
      await act(async () => undefined);

      // Only the read's own call is held; the repository's later reads aren't.
      const realGet = store.eir.get.bind(store.eir);
      const readGate = deferred<void>();
      store.eir.get = vi.fn(async (id: string) => {
        store.eir.get = realGet;
        await readGate.promise;
        return realGet(id);
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const read = client.refetchQueries({ queryKey: queryKeys.eir("person-1") });
      refusal.resolve();
      // The clock stays still until the refusal is on screen (testing-library's waits need it moving).
      for (let tries = 0; tries < 100 && !screen.queryByText(RELOAD); tries++) {
        await act(() => new Promise((done) => setTimeout(done, 10)));
      }
      clock.mockRestore();
      expect(screen.getByText(RELOAD)).toBeInTheDocument();
      readGate.resolve();
      await act(() => read);
    }

    /** Start an EIR read the moment a refusal settles, before the screen renders it. */
    function readOnRefusal(client: QueryClient) {
      let read: Promise<void> | undefined;
      const off = client.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error" || read) return;
        read = client.refetchQueries({ queryKey: queryKeys.eir("person-1") });
      });
      return async () => {
        await waitFor(() => expect(read).toBeDefined());
        await act(() => read!);
        off();
      };
    }

    it.each(["Save draft", "Download"] as const)(
      "a read already in flight when %s is refused doesn't supersede it, even in the same millisecond",
      async (kind) => {
        const { store, user, client } = await downloadedThenMovedOn();

        await refusedWhileReadInFlight(store, client, kind);
        await loaded({ team: "Saved in another tab" });
        await user.click(team());
        await user.keyboard(" Again");

        expect(screen.getByText(RELOAD)).toBeInTheDocument();
        expect(screen.queryByText(STALE_BANNER)).not.toBeInTheDocument();
      },
    );

    it.each([
      ["Save draft", refuseSaveDraft, saveDraft],
      ["Download", () => undefined, download],
    ] as const)(
      "a read that starts and ends after %s is refused, before the screen renders it, supersedes it",
      async (_name, refuse, button) => {
        const { store, user, client } = await downloadedThenMovedOn();
        refuse(store);
        const readDone = readOnRefusal(client);

        await user.click(button());
        await readDone();
        await loaded({ team: "Saved in another tab" });
        await user.click(team());
        await user.keyboard(" Again");

        expect(await screen.findByText(STALE_BANNER)).toBeInTheDocument();
        expect(screen.queryByText(RELOAD)).not.toBeInTheDocument();
      },
    );
  });
});
