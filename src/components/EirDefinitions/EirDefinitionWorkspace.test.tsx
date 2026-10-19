import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryStore, StoreProvider, type DataStore } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import type { UserProfile } from "@/data/types";
import { EdpAdminScreen } from "@/components/EdpAdmin/EdpAdminScreen";
import { EirScreen } from "@/components/Eir/EirScreen";

afterEach(cleanup);
// jsdom has no layout: CodeMirror measures text ranges, so give it empty ones.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// A long journey of server round trips: give each wait room on a loaded machine.
configure({ asyncUtilTimeout: 5_000 });

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}
beforeEach(() => setGlobal("AppIcon", () => null));

const BOOTSTRAP = readBootstrapEirSource()!;
/**
 * A synthetic next definition from the bootstrap definition (`bootstrap`, its
 * mixed dispositions): one changed section title. The server numbers it (#224).
 */
const next = (n: number) =>
  readBootstrapEirSource("bootstrap")!.replace(
    "      title: User details\n",
    `      title: User details (v${n})\n`,
  );

const base = makeSnapshot().user;
const SAFEGUARDS: UserProfile = {
  ...base,
  principalId: "4001",
  name: "Sara Safeguards",
  isAdmin: false,
  isSafeguardsValidator: true,
};
const EDP_STAFF: UserProfile = { ...base, principalId: "3001", isAdmin: true };

function storeAs(user: UserProfile): DataStore {
  const store = createMemoryStore(makeSnapshot());
  store.catalog.getUser = async () => user;
  return store;
}

function renderWith(store: DataStore, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

/** My EIR opens only after the active privacy notice is acknowledged (#202). */
const acknowledgePrivacyNotice = (store: DataStore) =>
  store.privacyAcknowledgments.acknowledge({
    noticeVersion: store.privacyAcknowledgments.notice.version,
    contentHash: store.privacyAcknowledgments.notice.contentHash,
  });

const workspace = (store: DataStore) =>
  renderWith(
    store,
    <EdpAdminScreen ctx={{ go: () => undefined }} params={{ id: "eir-definitions" }} />,
  );

/** Press a button the keyboard way, once it's there and enabled: focus it, then Enter. */
async function press(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  button.focus();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
}

/** The editor, as everyone meets it: the labelled text box. */
const editorBox = () => screen.getByRole("textbox", { name: "Definition YAML" });
/** Replace the YAML the way an author would: select all, then paste. */
async function setYaml(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(editorBox());
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
  // The editor shows what was pasted (its lines, without the line breaks).
  await waitFor(() => expect(editorBox()).toHaveTextContent(text.split("\n")[0]!));
}

describe("Safeguards EIR definition workspace", () => {
  it(
    "Safeguards workspace: edit → validate → preview → publish → activate → rollback is keyboard-operable",
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      const store = storeAs(SAFEGUARDS);
      workspace(store);

      expect(await screen.findByRole("heading", { name: "EIR definitions" })).toBeVisible();
      const active = await screen.findByRole("region", { name: "Active definition" });
      expect(active).toHaveTextContent("The built-in definition bootstrap-2 (version 0)");
      // Staff wording: only a published version is ever "active"; the built-in is the fallback.
      expect(active).toHaveTextContent(
        "With no published version active, the built-in definition bootstrap-2 (version 0) that ships with the app is used.",
      );
      expect(
        screen.getByText(
          "No published version has been activated: the built-in definition bootstrap-2 (version 0) is in use.",
        ),
      ).toBeVisible();
      // The editor opens on the active definition's YAML: a labelled,
      // multi-line code editor with line numbers and YAML highlighting.
      const editor = await screen.findByRole("textbox", { name: "Definition YAML" });
      await waitFor(() => expect(editor).toHaveTextContent(BOOTSTRAP.split("\n")[0]!));
      expect(editor).toHaveAttribute("aria-multiline", "true");
      expect(editor).toHaveAccessibleDescription(/Tab moves to the next control/);
      // Tab never traps focus: it moves on to the next control.
      editor.focus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Validate" })).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Publish as a new version" })).toBeNull();

      // Invalid YAML: announced with a count, where, and nothing publishable.
      await setYaml(user, "a: 1\nform: [\n  title: x\n");
      await press(user, "Validate");
      const problems = await screen.findByRole("region", { name: "Problems" });
      await waitFor(() => expect(document.activeElement).toHaveTextContent(/^1 problem found$/));
      expect(problems).toHaveTextContent(/line \d+/i);
      expect(screen.queryByRole("button", { name: "Publish as a new version" })).toBeNull();
      const goTo = within(problems).getAllByRole("button", { name: /go to line/i })[0]!;
      const line = Number(/(\d+)/.exec(goTo.textContent ?? "")![1]);
      await user.click(goTo);
      expect(editor).toHaveFocus();
      expect(screen.getByText(`Line ${line}, column 1`)).toBeVisible();

      // A semantic error names what's wrong and where.
      await setYaml(user, next(2).replace("field: ndaSigned", "field: ndaSignedd"));
      await press(user, "Validate");
      expect(await screen.findByRole("region", { name: "Problems" })).toHaveTextContent(
        'Rule "nda-signed" checks "ndaSignedd", which isn\'t a field.',
      );
      expect(screen.getByRole("region", { name: "Problems" })).toHaveTextContent("rules.6.field");

      // Valid: announced, then preview the form and every scenario, then publish.
      await setYaml(user, next(2));
      await press(user, "Validate");
      await waitFor(() =>
        expect(screen.getByRole("status", { name: "Workspace message" })).toHaveFocus(),
      );
      expect(screen.getByRole("status", { name: "Workspace message" })).toHaveTextContent(
        /^Valid:/,
      );
      await press(user, "Preview");
      const preview = await screen.findByRole("region", { name: "Preview" });
      expect(within(preview).getByText("User details (v2)")).toBeInTheDocument();
      const scenarios = within(preview).getByRole("table", { name: "Synthetic scenarios" });
      expect(within(scenarios).getAllByRole("row")).toHaveLength(5);
      expect(scenarios).toHaveTextContent("manual-review-nda");
      expect(active).toHaveTextContent("The built-in definition bootstrap-2 (version 0)");
      await press(user, "Publish as a new version");
      expect(await screen.findByRole("status", { name: "Workspace message" })).toHaveTextContent(
        "Published as version 1. It isn't active: new EIR drafts still use the built-in definition bootstrap-2 (version 0).",
      );
      const versions = screen.getByRole("table", { name: "Published versions" });
      await waitFor(() => expect(within(versions).getAllByRole("row")).toHaveLength(2));
      // The full content hash is reachable by keyboard, not only on hover.
      const hash = within(versions).getByText("Show the full SHA-256 of version 1");
      expect(hash.tagName).toBe("SUMMARY");
      await user.click(hash);
      expect(within(versions).getByText(/^[0-9a-f]{64}$/)).toBeVisible();

      // Changing the YAML after a check needs a new check before publishing.
      await setYaml(user, next(3));
      expect(screen.queryByRole("button", { name: "Publish as a new version" })).toBeNull();

      // Activation asks first, naming both versions; Cancel changes nothing.
      await press(user, "Activate version 1");
      const confirm = await screen.findByRole("group", { name: "Confirm activation" });
      expect(confirm).toHaveTextContent(
        "Activate version 1? It replaces the built-in definition bootstrap-2 (version 0) for new EIR drafts.",
      );
      expect(within(confirm).getByRole("button", { name: "Activate version 1 now" })).toHaveFocus();
      await press(user, "Cancel");
      expect(screen.queryByRole("group", { name: "Confirm activation" })).toBeNull();
      expect(active).toHaveTextContent("The built-in definition bootstrap-2 (version 0)");
      await press(user, "Activate version 1");
      await press(user, "Activate version 1 now");
      await waitFor(() => expect(within(active).getByText("Version 1")).toBeInTheDocument());
      expect(screen.getByRole("status", { name: "Workspace message" })).toHaveTextContent(
        "Version 1 is active. New EIR drafts use it; drafts already started keep the version they started on.",
      );

      await press(user, "Preview");
      await press(user, "Publish as a new version");
      await screen.findByRole("button", { name: "Activate version 2" });
      await press(user, "Activate version 2");
      await press(user, "Activate version 2 now");
      await waitFor(() => expect(within(active).getByText("Version 2")).toBeInTheDocument());
      await press(user, "Roll back to version 1");
      expect(screen.getByRole("group", { name: "Confirm activation" })).toHaveTextContent(
        "Roll back to version 1? It replaces version 2 for new EIR drafts.",
      );
      await press(user, "Roll back to version 1 now");
      await waitFor(() => expect(within(active).getByText("Version 1")).toBeInTheDocument());
      const activations = screen.getByRole("table", { name: "Activation history" });
      const rows = within(activations).getAllByRole("row");
      expect(rows).toHaveLength(4);
      expect(rows[1]).toHaveTextContent("Version 1");
      expect(rows[1]).toHaveTextContent("Rollback");
      expect(rows[1]).toHaveTextContent("Sara Safeguards");
    },
  );

  it("shows EDP staff the history, with nothing to author, publish or activate", async () => {
    const author = storeAs(SAFEGUARDS);
    await author.eirDefinitions.publish({ sourceYaml: next(2), expectedVersion: 0 });
    const staff = createMemoryStore(makeSnapshot(), {
      eirDefinitions: author.eirDefinitions,
    });
    // The same definitions, seen by someone who isn't Safeguards.
    staff.catalog.getUser = async () => EDP_STAFF;
    workspace(staff);
    const versions = await screen.findByRole("table", { name: "Published versions" });
    expect(within(versions).getByRole("rowheader", { name: "1" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Definition YAML" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /validate|preview|publish|activate|roll back/i }),
    ).toBeNull();
    expect(screen.getByText(/Only Safeguards can author, publish or activate/)).toBeInTheDocument();
  });

  it("starts a new EIR on the activated form", async () => {
    const store = storeAs({ ...SAFEGUARDS, principalId: "4001" });
    await store.eirDefinitions.publish({ sourceYaml: next(2), expectedVersion: 0 });
    await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
    await acknowledgePrivacyNotice(store);
    renderWith(store, <EirScreen />);
    expect(await screen.findByText("User details (v2)")).toBeInTheDocument();
    expect(screen.getByText("version 1")).toBeInTheDocument();
  });

  it("shows a validator answers given on a published form with that form's labels", async () => {
    const store = storeAs(SAFEGUARDS);
    await store.eirDefinitions.publish({ sourceYaml: next(7), expectedVersion: 0 });
    await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
    // Saved and pre-checked first (#203): only an evaluated draft's PDF uploads.
    await store.eir.saveDraft("person-9", EIR_VALUES, undefined, "1");
    await store.eir.evaluateDraft("person-9");
    await store.eir.submitWithFile({
      principalId: "person-9",
      personName: "Test Person",
      file: new File(["%PDF-1.7 signed"], "signed.pdf", { type: "application/pdf" }),
      values: EIR_VALUES,
      formVersion: "1",
    });
    renderWith(store, <EdpAdminScreen ctx={{ go: () => undefined }} params={{ id: "eir" }} />);
    expect(await screen.findByText("User details (v7)")).toBeInTheDocument();
    expect(screen.queryByText(/Unknown form version/)).toBeNull();
  });

  it("still offers Send response on a sent-back EIR signed on the bootstrap form after another is activated", async () => {
    const person: UserProfile = { ...SAFEGUARDS, principalId: "person-5", name: "Test Person" };
    const store = storeAs(person);
    // Saved and pre-checked first (#203): only an evaluated draft's PDF uploads.
    await store.eir.saveDraft("person-5", EIR_VALUES, undefined, "bootstrap-2");
    await store.eir.evaluateDraft("person-5");
    await store.eir.submitWithFile({
      principalId: "person-5",
      personName: "Test Person",
      file: new File(["%PDF-1.7 signed"], "signed.pdf", { type: "application/pdf" }),
      values: EIR_VALUES,
      formVersion: "bootstrap-2",
    });
    await store.eir.decide("person-5", "questions", "4009", "Clarify your team", "Val Idator");
    await store.eirDefinitions.publish({ sourceYaml: next(8), expectedVersion: 0 });
    await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
    await acknowledgePrivacyNotice(store);
    renderWith(store, <EirScreen />);
    expect(await screen.findByRole("button", { name: "Send response" })).toBeEnabled();
    expect(screen.queryByText(/signed on an earlier form/)).toBeNull();
  });
});

// ---- Publish and activate feedback (#210 UAT: slow and silent) ----------------

/** A reply the test holds until it lets it go. */
function held<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

/** The connection dropped after the request left: nobody knows if it committed. */
const lostReply = () => new TypeError("Failed to fetch");

type PublishInput = Parameters<DataStore["eirDefinitions"]["publish"]>[0];
type ActivateInput = Parameters<DataStore["eirDefinitions"]["activate"]>[0];

/** Open the workspace with `next(2)` validated, ready to publish. */
async function readyToPublish(user: ReturnType<typeof userEvent.setup>, store: DataStore) {
  workspace(store);
  const editor = await screen.findByRole("textbox", { name: "Definition YAML" });
  await waitFor(() => expect(editor).toHaveTextContent(BOOTSTRAP.split("\n")[0]!));
  await setYaml(user, next(2));
  await press(user, "Validate");
  await screen.findByRole("button", { name: "Publish as a new version" });
  const check = await store.eirDefinitions.check(next(2));
  if (!check.ok) throw new Error("next(2) must load");
  return check.contentSha256;
}

const workspaceMessage = () => screen.getByRole("status", { name: "Workspace message" });

describe("Publish and activate feedback (#210 UAT)", () => {
  it("shows Publishing… and nothing published until the server confirms, then focuses a confirmation naming the version and its hash", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    const publish = store.eirDefinitions.publish;
    const reply = held();
    store.eirDefinitions.publish = async (input) => {
      await reply.promise;
      return publish(input);
    };
    const hash = await readyToPublish(user, store);

    await press(user, "Publish as a new version");
    const button = await screen.findByRole("button", { name: "Publishing…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    const status = screen.getByText("Publishing as a new version… This can take a few seconds.");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(editorBox()).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("button", { name: "Validate" })).toBeDisabled();
    // Not optimistic: a published version is permanent policy.
    expect(screen.queryByText(/Published as version/)).toBeNull();
    expect(screen.getByRole("region", { name: "Published versions" })).toHaveTextContent(
      "Nothing has been published yet.",
    );

    reply.release();
    await waitFor(() => expect(workspaceMessage()).toHaveTextContent("Published as version 1."));
    expect(workspaceMessage()).toHaveTextContent(`Content SHA-256: ${hash}.`);
    expect(workspaceMessage()).toHaveFocus();
    expect(screen.queryByText(/^Publishing as a new version/)).toBeNull();
    expect(editorBox()).not.toHaveAttribute("aria-readonly", "true");
    const versions = await screen.findByRole("table", { name: "Published versions" });
    expect(within(versions).getByRole("rowheader", { name: "1" })).toBeVisible();
  });

  it("a double click, or a click while it's publishing, publishes once", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    const publish = store.eirDefinitions.publish;
    const reply = held();
    const calls: PublishInput[] = [];
    store.eirDefinitions.publish = async (input) => {
      calls.push(input);
      await reply.promise;
      return publish(input);
    };
    await readyToPublish(user, store);

    await user.dblClick(screen.getByRole("button", { name: "Publish as a new version" }));
    await user.click(await screen.findByRole("button", { name: "Publishing…" }));
    reply.release();
    await waitFor(() => expect(workspaceMessage()).toHaveTextContent("Published as version 1."));
    expect(calls).toHaveLength(1);
    expect((await store.eirDefinitions.history()).versions).toHaveLength(1);
  });

  it("a refusal keeps the YAML, says why, and moves focus to the error", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    store.eirDefinitions.publish = async () => {
      throw Object.assign(
        new Error("This changed since you opened it. Reload to see the latest."),
        {
          status: 409,
          code: "version-conflict",
        },
      );
    };
    await readyToPublish(user, store);

    await press(user, "Publish as a new version");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "It wasn't published: This changed since you opened it. Reload to see the latest.",
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(editorBox()).toHaveTextContent("title: User details (v2)");
    expect(editorBox()).not.toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("button", { name: "Publish as a new version" })).toBeEnabled();
    expect(screen.queryByText(/Published as version/)).toBeNull();
    expect((await store.eirDefinitions.history()).versions).toEqual([]);
  });

  it("after a lost reply it checks whether the version landed, and says so instead of publishing again", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    const publish = store.eirDefinitions.publish;
    const calls: PublishInput[] = [];
    store.eirDefinitions.publish = async (input) => {
      calls.push(input);
      await publish(input);
      throw lostReply();
    };
    const hash = await readyToPublish(user, store);

    await press(user, "Publish as a new version");
    await waitFor(() => expect(workspaceMessage()).toHaveTextContent("Published as version 1."));
    expect(workspaceMessage()).toHaveTextContent(`Content SHA-256: ${hash}.`);
    expect(workspaceMessage()).toHaveFocus();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toHaveLength(1);
    expect((await store.eirDefinitions.history()).versions).toHaveLength(1);
  });

  it("after a lost reply that didn't land, the YAML stays and a retry reuses the same request key", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    const publish = store.eirDefinitions.publish;
    const calls: PublishInput[] = [];
    store.eirDefinitions.publish = async (input) => {
      calls.push(input);
      if (calls.length === 1) throw lostReply();
      return publish(input);
    };
    await readyToPublish(user, store);

    await press(user, "Publish as a new version");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "We couldn't confirm it was published: the connection dropped before the server answered.",
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(editorBox()).toHaveTextContent("title: User details (v2)");
    expect(screen.queryByText(/Published as version/)).toBeNull();

    await press(user, "Publish as a new version");
    await waitFor(() => expect(workspaceMessage()).toHaveTextContent("Published as version 1."));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBeTruthy();
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    expect((await store.eirDefinitions.history()).versions).toHaveLength(1);
  });

  it("confirms as soon as the server does, while the version list is still refreshing", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    const history = store.eirDefinitions.history;
    const publish = store.eirDefinitions.publish;
    let published = false;
    const refresh = held();
    store.eirDefinitions.publish = async (input) => {
      const result = await publish(input);
      published = true;
      return result;
    };
    store.eirDefinitions.history = async () => {
      if (published) await refresh.promise;
      return history();
    };
    await readyToPublish(user, store);

    await press(user, "Publish as a new version");
    await waitFor(() => expect(workspaceMessage()).toHaveTextContent("Published as version 1."));
    expect(workspaceMessage()).toHaveFocus();
    refresh.release();
    const versions = await screen.findByRole("table", { name: "Published versions" });
    expect(within(versions).getByRole("rowheader", { name: "1" })).toBeVisible();
  });

  it("Validate and Preview say they're checking until the server answers", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    const check = store.eirDefinitions.check;
    let reply = held();
    store.eirDefinitions.check = async (sourceYaml) => {
      await reply.promise;
      return check(sourceYaml);
    };
    workspace(store);
    const editor = await screen.findByRole("textbox", { name: "Definition YAML" });
    await waitFor(() => expect(editor).toHaveTextContent(BOOTSTRAP.split("\n")[0]!));
    await setYaml(user, next(2));

    for (const [name, label] of [
      ["Validate", "Validating…"],
      ["Preview", "Previewing…"],
    ] as const) {
      await press(user, name);
      const button = await screen.findByRole("button", { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
      reply.release();
      await waitFor(() => expect(workspaceMessage()).toHaveTextContent(/^Valid:/));
      expect(screen.getByRole("button", { name })).toBeEnabled();
      reply = held();
    }
  });

  it("after an activation's lost reply that didn't land, nothing is shown as active and a retry reuses the same request key", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    await store.eirDefinitions.publish({ sourceYaml: next(2), expectedVersion: 0 });
    const activate = store.eirDefinitions.activate;
    const calls: ActivateInput[] = [];
    store.eirDefinitions.activate = async (input) => {
      calls.push(input);
      // The first request fails before anything is written.
      if (calls.length === 1) throw lostReply();
      return activate(input);
    };
    workspace(store);
    const active = await screen.findByRole("region", { name: "Active definition" });

    await press(user, "Activate version 1");
    await press(user, "Activate version 1 now");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "We couldn't confirm version 1 was activated: the connection dropped before the server answered.",
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(active).toHaveTextContent("The built-in definition bootstrap-2 (version 0)");
    expect(screen.queryByText(/^Version 1 is active/)).toBeNull();
    expect((await store.eirDefinitions.history()).activations).toEqual([]);

    await press(user, "Activate version 1");
    await press(user, "Activate version 1 now");
    await waitFor(() => expect(workspaceMessage()).toHaveTextContent("Version 1 is active."));
    expect(workspaceMessage()).toHaveFocus();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBeTruthy();
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    expect((await store.eirDefinitions.history()).activations).toHaveLength(1);
  });

  it("activate and roll back show Activating… until the server confirms, and a lost reply is checked, not repeated", async () => {
    const user = userEvent.setup();
    const store = storeAs(SAFEGUARDS);
    await store.eirDefinitions.publish({ sourceYaml: next(2), expectedVersion: 0 });
    const activate = store.eirDefinitions.activate;
    const reply = held();
    const calls: ActivateInput[] = [];
    store.eirDefinitions.activate = async (input) => {
      calls.push(input);
      await reply.promise;
      await activate(input);
      throw lostReply();
    };
    workspace(store);
    const active = await screen.findByRole("region", { name: "Active definition" });

    await press(user, "Activate version 1");
    await press(user, "Activate version 1 now");
    const button = await screen.findByRole("button", { name: "Activating…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Activating version 1… This can take a few seconds.")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(active).toHaveTextContent("The built-in definition bootstrap-2 (version 0)");
    expect(screen.queryByText(/^Version 1 is active/)).toBeNull();

    reply.release();
    await waitFor(() =>
      expect(workspaceMessage()).toHaveTextContent(
        "Version 1 is active. New EIR drafts use it; drafts already started keep the version they started on.",
      ),
    );
    expect(workspaceMessage()).toHaveFocus();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(within(active).getByText("Version 1")).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect((await store.eirDefinitions.history()).activations).toHaveLength(1);
  });
});
