import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryStore, StoreProvider, type DataStore } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import type { UserProfile } from "@/data/types";
import { EdpAdminScreen } from "@/components/EdpAdmin/EdpAdminScreen";

/**
 * The schema reference (#219) through the public UI: EDP Admin → EIR
 * definitions, as Safeguards (beside the editor) and as EDP staff (read
 * only). Expected text is written out from the ticket and the checker.
 */
afterEach(cleanup);
// jsdom has no layout: CodeMirror measures text ranges, so give it empty ones.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
configure({ asyncUtilTimeout: 5_000 });
beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>)["AppIcon"] = () => null;
});

const base = makeSnapshot().user;
const SAFEGUARDS: UserProfile = {
  ...base,
  principalId: "4001",
  name: "Sara Safeguards",
  isAdmin: false,
  isSafeguardsValidator: true,
};
const EDP_STAFF: UserProfile = { ...base, principalId: "3001", isAdmin: true };

function workspaceAs(user: UserProfile) {
  const store: DataStore = createMemoryStore(makeSnapshot());
  store.catalog.getUser = async () => user;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>
        <EdpAdminScreen ctx={{ go: () => undefined }} params={{ id: "eir-definitions" }} />
      </StoreProvider>
    </QueryClientProvider>,
  );
}

const reference = () => screen.findByRole("region", { name: "Schema reference" });
const entry = (name: string) =>
  screen.getByRole("heading", { level: 4, name }).closest("article") as HTMLElement;

describe("EIR definition schema reference (#219)", () => {
  it("sits beside the editor for Safeguards, with headed groups and every operator", async () => {
    workspaceAs(SAFEGUARDS);
    const panel = await reference();
    expect(await screen.findByRole("textbox", { name: "Definition YAML" })).toBeInTheDocument();
    expect(
      within(panel).getByRole("heading", { level: 2, name: "Schema reference" }),
    ).toBeVisible();
    expect(
      within(panel)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "Rules for the whole definition",
      "How versions work",
      "Keys",
      "Rule operators",
      "Dispositions",
      "Codes",
      "Minimal valid example",
    ]);

    const operator = entry("rules[].operator");
    expect(operator).toHaveTextContent("Required");
    for (const name of [
      "irs-id",
      "equals",
      "within-timeline",
      "not-future",
      "not-past",
      "on-or-after",
    ]) {
      expect(within(operator).getByRole("link", { name })).toHaveAttribute(
        "href",
        `#eir-ref-operator-${name}`,
      );
    }
    const notPast = entry("not-past");
    expect(notPast).toHaveTextContent("something expiring today is still in date");
    expect(notPast).toHaveTextContent("Checked 10/20/2026: 10/19/2026 fails");
    expect(notPast).toHaveTextContent("Checked 10/20/2026: 10/20/2026 meets it");

    const blocking = entry("blocking");
    expect(blocking).toHaveTextContent("PDFCan't be generated");
    expect(blocking).toHaveTextContent("UploadRefused");
    expect(blocking).toHaveTextContent("Automatic validityNever");
    // #204: a warning qualifies only when the deploy names it, which by default it doesn't.
    expect(entry("warning")).toHaveTextContent(
      "Automatic validityOnly if the deploy names it (not by default)",
    );
    expect(entry("manual-review")).toHaveTextContent("Automatic validityNever");
    // Automatic validity is built but not authorized: the reference says so.
    expect(document.body).toHaveTextContent(
      "Automatic validity isn't authorized for production use until Safeguards signs off.",
    );

    expect(entry("validityDays")).toHaveTextContent(
      "Non-production MVP default (#148): the bootstrap uses 365 days",
    );
    const anchor = entry("timelines[].anchor");
    expect(anchor).toHaveTextContent(
      "Optional. If left out: form-started: max counts back from the day the employee started the form.",
    );
    expect(anchor).toHaveTextContent("Only max follows the anchor");
    expect(entry("within-timeline")).toHaveTextContent(
      "Stored aswithin-timeline:<anchor>:<unit>:<min>:<max>",
    );
    expect(entry("missing-guidance")).toHaveTextContent("Shown by Validate");
    expect(entry("already-published")).toHaveTextContent("Refuses a publish or activate");
  });

  it("explains how versions work, and lists no version key (#224)", async () => {
    workspaceAs(SAFEGUARDS);
    const panel = await reference();
    for (const name of ["definitionVersion", "form.version", "version-taken"]) {
      expect(within(panel).queryByRole("heading", { level: 4, name })).toBeNull();
    }
    expect(entry("Each publish is numbered automatically")).toHaveTextContent("1, 2, 3 and so on");
    expect(entry("A draft keeps the version it started on")).toHaveTextContent(
      "even after another version is activated",
    );
    expect(entry("Built-in definitions have reserved names")).toHaveTextContent(
      "shown as bootstrap (version 0) and bootstrap-2 (version 0)",
    );
    expect(entry("There is only one version number")).toHaveTextContent("That distinction is gone");
    expect(entry("server-assigned-version")).toHaveTextContent("The server assigns the version");
  });

  it("is readable by EDP staff who can't author definitions", async () => {
    workspaceAs(EDP_STAFF);
    const panel = await reference();
    expect(screen.queryByRole("textbox", { name: "Definition YAML" })).toBeNull();
    expect(
      within(panel).getByRole("heading", { level: 4, name: "rules[].guidance" }),
    ).toBeVisible();
  });

  it("filters by key or word, announces how many match, and says when none do", async () => {
    const user = userEvent.setup();
    workspaceAs(EDP_STAFF);
    const panel = await reference();
    const search = within(panel).getByRole("searchbox", { name: "Search the reference" });
    await user.type(search, "otherField");
    expect(
      within(panel).getByRole("heading", { level: 4, name: "rules[].otherField" }),
    ).toBeVisible();
    expect(within(panel).getByRole("heading", { level: 4, name: "on-or-after" })).toBeVisible();
    expect(within(panel).queryByRole("heading", { level: 4, name: "validityDays" })).toBeNull();
    expect(within(panel).getByRole("status")).toHaveTextContent(/^\d+ entr(y|ies) match$/);
    await user.clear(search);
    await user.type(search, "zzzz-nothing");
    expect(within(panel).getByRole("status")).toHaveTextContent("Nothing matches zzzz-nothing.");
    await user.clear(search);
    expect(within(panel).getByRole("heading", { level: 4, name: "validityDays" })).toBeVisible();
  });

  it(
    "links each editor diagnostic to its code and key, even when a search hides them",
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      workspaceAs(SAFEGUARDS);
      const panel = await reference();
      await user.type(
        within(panel).getByRole("searchbox", { name: "Search the reference" }),
        "validityDays",
      );

      const editor = await screen.findByRole("textbox", { name: "Definition YAML" });
      const yaml = readBootstrapEirSource()!.replace(
        "    operator: not-past\n",
        "    operator: not-pastt\n",
      );
      await waitFor(() => expect(editor).toHaveTextContent("validityDays"));
      await user.click(editor);
      await user.keyboard("{Control>}a{/Control}");
      await user.paste(yaml);
      const validate = screen.getByRole("button", { name: "Validate" });
      await waitFor(() => expect(validate).toBeEnabled());
      validate.focus();
      await user.keyboard("{Enter}");

      const problems = await screen.findByRole("region", { name: "Problems" });
      const codeLink = within(problems).getByRole("link", { name: "What invalid-value means" });
      expect(codeLink).toHaveAttribute("href", "#eir-ref-code-invalid-value");
      const keyLink = within(problems).getByRole("link", { name: "About rules[].operator" });
      expect(keyLink).toHaveAttribute("href", "#eir-ref-key-rules-operator");

      keyLink.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(entry("rules[].operator")).toHaveFocus());
      expect(within(panel).getByRole("searchbox", { name: "Search the reference" })).toHaveValue(
        "",
      );

      codeLink.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(entry("invalid-value")).toHaveFocus());
    },
  );

  it("is keyboard reachable: its scrolling area takes focus after the search box", async () => {
    const user = userEvent.setup();
    workspaceAs(EDP_STAFF);
    const panel = await reference();
    const search = within(panel).getByRole("searchbox", { name: "Search the reference" });
    search.focus();
    await user.tab();
    expect(within(panel).getByRole("region", { name: "Schema reference entries" })).toHaveFocus();
  });
});
