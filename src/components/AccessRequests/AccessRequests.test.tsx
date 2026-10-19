import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryStore } from "@/data/adapters/memory";
import { StoreProvider } from "@/data/store-provider";
import type { DataStore } from "@/data/store";
import type { UserProfile } from "@/data/types";
import {
  DATASET_ID,
  OWNER,
  STRANGER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "@/data/__tests__/dataset-fixture";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { DEFAULT_ACCESS_REQUEST_CONFIG } from "@/data/access-requests/config";
import { DatasetsScreen } from "@/components/DatasetAccess";
import { datasetQueryKeys } from "@/data/datasets/queries";
import { AccessInboxScreen, MyAccessRequestsScreen, RequestAccessScreen } from "./index";

afterEach(cleanup);

function makeStore(user: () => UserProfile, requestableRoles?: ("tester" | "developer")[]) {
  // Fixed IDs in order, so the screens' copy can be asserted; real ones are random codes.
  let next = 0;
  return createMemoryStore(makeSnapshot(), {
    newAccessRequestId: () => `AR-${String(++next).padStart(4, "0")}`,
    ...(requestableRoles
      ? { accessRequestConfig: { ...DEFAULT_ACCESS_REQUEST_CONFIG, requestableRoles } }
      : {}),
    currentUser: async () => user(),
    now: makeClock().now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  });
}

function wrap(ui: ReactNode, store: DataStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>{ui}</StoreProvider>
      </QueryClientProvider>,
    ),
  };
}

const ctx = () => ({ go: vi.fn() });
const ASK = { datasetId: DATASET_ID, role: "developer", reason: "Build the scoring job" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RequestAccessScreen", () => {
  it("shows the owners, the role cards with their grants, and sends a request with a reason", async () => {
    const store = makeStore(() => STRANGER);
    wrap(<RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    expect(await screen.findByText("Its owners decide: Olive Owner")).toBeInTheDocument();
    const roles = screen.getByRole("radiogroup", { name: "Dataset role" });
    // Manager isn't requestable: an owner grants it directly.
    expect(
      within(roles)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Tester", "Dev (test)"]);
    expect(
      screen.getByText(/manager role .*granted directly by a dataset owner/i),
    ).toBeInTheDocument();
    fireEvent.click(within(roles).getByRole("radio", { name: "Dev (test)" }));

    // A reason is required.
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    const reason = screen.getByLabelText(/Reason/);
    expect(screen.getByRole("alert")).toHaveTextContent("Say why you need this role.");
    expect(reason).toHaveFocus();
    expect(reason).toBeRequired();

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Build the job" } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    const confirm = screen.getByRole("region", { name: "Confirm the request" });
    expect(screen.getByRole("heading", { name: "Review your request" })).toHaveFocus();
    expect(within(confirm).getByText("Test grant: read/write")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: /Send request/ }));

    expect(await screen.findByText("Sent AR-0001 to Olive Owner.")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Your request to the owners" }).parentElement,
    ).toHaveFocus();
    expect(await store.accessRequests.listMine()).toMatchObject([
      { role: "developer", reason: "Build the job", status: "requested" },
    ]);
  });

  it("keeps focus and every keystroke in the reason after a failed review (#179)", async () => {
    const user = userEvent.setup();
    wrap(
      <RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => STRANGER),
    );
    await user.click(await screen.findByRole("button", { name: /Review request/ }));
    const reason = screen.getByLabelText(/Reason/);
    expect(reason).toHaveFocus();

    await user.keyboard("Build the job");
    expect(reason).toHaveFocus();
    expect(reason).toHaveValue("Build the job");
    expect(screen.queryByText("Say why you need this role.")).toBeNull();
    await user.clear(reason);
    expect(reason).toHaveFocus();
    await user.tab();
    expect(reason).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: /Review request/ }));
    expect(reason).toHaveFocus();
  });

  it("moves through role cards with arrow keys and keeps one tab stop", async () => {
    wrap(
      <RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => STRANGER),
    );
    const group = await screen.findByRole("radiogroup", { name: "Dataset role" });
    const tester = within(group).getByRole("radio", { name: "Tester" });
    const developer = within(group).getByRole("radio", { name: "Dev (test)" });

    tester.focus();
    fireEvent.keyDown(tester, { key: "ArrowRight" });

    expect(developer).toHaveFocus();
    expect(developer).toHaveAttribute("aria-checked", "true");
    expect(developer).toHaveAttribute("tabindex", "0");
    expect(tester).toHaveAttribute("tabindex", "-1");
  });

  it("shows the store's refusal, such as a duplicate open request", async () => {
    const store = makeStore(() => STRANGER);
    await store.accessRequests.submit({ ...ASK, role: "tester" });
    wrap(<RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: "Again" } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /That request was refused.*Ask for Tester on .*You already asked for tester/,
    );
    // The person's input is back, to change or try again.
    expect(screen.getByLabelText(/Reason/)).toHaveValue("Again");
  });

  it("shows the request at once as saving, ignores a double click, and says sent only once saved", async () => {
    const store = makeStore(() => STRANGER);
    const gate = deferred<Awaited<ReturnType<typeof store.accessRequests.submit>>>();
    const real = store.accessRequests.submit.bind(store.accessRequests);
    let captured!: Parameters<typeof real>[0];
    const submit = vi.fn((input: Parameters<typeof real>[0]) => {
      captured = input;
      return gate.promise;
    });
    store.accessRequests.submit = submit;
    wrap(<RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: "Build" } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    const send = screen.getByRole("button", { name: /Send request/ });
    fireEvent.click(send);
    fireEvent.click(send);

    const notices = screen.getByRole("region", { name: "Your request to the owners" });
    expect(notices).toHaveTextContent("Saving… Ask for Tester");
    expect(notices).not.toHaveTextContent("Sent");
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledTimes(1);

    gate.resolve(await real(captured));
    expect(await screen.findByText(/Sent AR-0001 to Olive Owner/)).toBeInTheDocument();
  });

  it("offers only the configured requestable roles, and labels the SLA target provisional", async () => {
    wrap(
      <RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => STRANGER, ["tester", "developer"]),
    );
    const roles = await screen.findByRole("radiogroup", { name: "Dataset role" });
    expect(
      within(roles)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Tester", "Dev (test)"]);

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "QA" } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    expect(screen.getByLabelText("Service-level agreement target")).toHaveTextContent(
      /Provisional service-level agreement \(SLA\) target: owners decide within 3 business days\..*holidays/,
    );
  });

  it("tells an owner to use the team page instead", async () => {
    wrap(
      <RequestAccessScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => OWNER),
    );
    expect(await screen.findByText("You own this dataset")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("MyAccessRequestsScreen", () => {
  it("lists every dataset with the owners to ask, and the session-only notice", async () => {
    const nav = ctx();
    wrap(
      <MyAccessRequestsScreen ctx={nav} />,
      makeStore(() => STRANGER),
    );

    const table = await screen.findByRole("table", { name: "Datasets to request" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Olive Owner");
    const notice = screen.getByRole("note", { name: "Session-only state" });
    expect(notice).toHaveTextContent(/reloading the page discards them/i);
    expect(notice).toHaveTextContent(
      /sample requests .* are recreated, open, every time the app loads/,
    );
    expect(screen.getByLabelText("Service-level agreement target")).toHaveTextContent(
      "Provisional service-level agreement (SLA) target",
    );

    fireEvent.click(within(rows[0]!).getByRole("link", { name: /Request a role/ }));
    expect(nav.go).toHaveBeenCalledWith("request-access", { id: DATASET_ID });
  });

  it("confirms before withdrawing an open request", async () => {
    const store = makeStore(() => STRANGER);
    await store.accessRequests.submit(ASK);
    wrap(<MyAccessRequestsScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Your requests" });
    expect(table).toHaveTextContent("Requested");
    expect(table).toHaveTextContent(/On track · due/);

    fireEvent.click(within(table).getByRole("button", { name: "Withdraw AR-0001" }));
    const confirmation = screen.getByRole("region", { name: "Confirm withdrawing AR-0001" });
    expect(confirmation).toHaveTextContent("owners can no longer approve or reject it");
    expect(table).toHaveTextContent("Requested");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Withdraw request" }));
    expect(await within(table).findByText("Withdrawn")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /Withdraw/ })).toBeNull();
  });

  it("shows a withdrawal at once as saving and ignores a double click", async () => {
    const store = makeStore(() => STRANGER);
    await store.accessRequests.submit(ASK);
    const gate = deferred<Awaited<ReturnType<typeof store.accessRequests.withdraw>>>();
    const real = store.accessRequests.withdraw.bind(store.accessRequests);
    let captured!: string;
    const withdraw = vi.fn((id: string) => {
      captured = id;
      return gate.promise;
    });
    store.accessRequests.withdraw = withdraw;
    wrap(<MyAccessRequestsScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Your requests" });
    fireEvent.click(within(table).getByRole("button", { name: "Withdraw AR-0001" }));
    const button = screen.getByRole("button", { name: "Withdraw request" });
    fireEvent.click(button);
    fireEvent.click(button);

    // In place at once, never as done: the row says Saving… and its button is gone.
    expect(await within(table).findByText("Saving…")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(table).queryByRole("button", { name: /Withdraw/ })).toBeNull(),
    );
    expect(within(table).queryByText("Withdrawn")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Your request changes" }).parentElement,
    ).toHaveFocus();
    await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1));

    gate.resolve(await real(captured));
    expect(await within(table).findByText("Withdrawn")).toBeInTheDocument();
    expect(await screen.findByText(/You withdrew AR-0001/)).toBeInTheDocument();
  });

  it("treats Escape from withdrawal confirmation as Keep it", async () => {
    const store = makeStore(() => STRANGER);
    await store.accessRequests.submit(ASK);
    wrap(<MyAccessRequestsScreen ctx={ctx()} />, store);
    const table = await screen.findByRole("table", { name: "Your requests" });
    const withdraw = within(table).getByRole("button", { name: "Withdraw AR-0001" });

    fireEvent.click(withdraw);
    fireEvent.keyDown(screen.getByRole("region", { name: "Confirm withdrawing AR-0001" }), {
      key: "Escape",
    });

    expect(screen.queryByRole("region", { name: "Confirm withdrawing AR-0001" })).toBeNull();
    await waitFor(() => expect(withdraw).toHaveFocus());
  });
});

describe("AccessInboxScreen", () => {
  it("an owner approves: the person is added and the change-list entry is named", async () => {
    let me = STRANGER;
    const store = makeStore(() => me);
    await store.accessRequests.submit(ASK);
    me = OWNER;
    wrap(<AccessInboxScreen ctx={ctx()} />, store);

    const card = await screen.findByRole("article", { name: /AR-0001 from Sam Stranger/ });
    expect(card).toHaveTextContent("Sam Stranger asks for Dev (test) on Refund anomaly scores");
    expect(card).toHaveTextContent("Build the scoring job");
    expect(card).toHaveTextContent(/On track · due/);

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(within(card).getByRole("heading", { name: "Review approval" })).toHaveFocus();
    expect(within(card).getByText("Test grant: read/write")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Confirm approval/ }));

    expect(
      await screen.findByText(
        /Approved AR-0001: Sam Stranger is now Dev \(test\)\. CL-0001 is pending/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your decisions" }).parentElement).toHaveFocus();
    expect(await store.datasetRoles.listMembers(DATASET_ID)).toEqual(
      expect.arrayContaining([
        {
          person: expect.objectContaining({ email: STRANGER.email }),
          role: "developer",
          addedBy: OWNER.principalId,
          datasetId: DATASET_ID,
          addedAt: expect.any(String),
        },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: /Decided/ }));
    const decided = await screen.findByRole("table", { name: "Decided requests" });
    expect(decided).toHaveTextContent("Active");
    expect(decided).toHaveTextContent("Olive Owner");
    expect(decided).toHaveTextContent("CL-0001");
  });

  it("an approval refreshes the Datasets summary count", async () => {
    let me = STRANGER;
    const store = makeStore(() => me);
    await store.accessRequests.submit(ASK);
    me = OWNER;
    wrap(
      <>
        <DatasetsScreen ctx={ctx()} />
        <AccessInboxScreen ctx={ctx()} />
      </>,
      store,
    );

    const datasets = await screen.findByRole("table", { name: "Datasets" });
    const firstDataset = within(datasets).getAllByRole("row")[1]!;
    expect(within(firstDataset).getAllByRole("cell")[4]).toHaveTextContent(/^1$/);
    const card = await screen.findByRole("article", { name: /AR-0001 from Sam Stranger/ });

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(card).getByRole("button", { name: /Confirm approval/ }));

    await waitFor(() =>
      expect(within(firstDataset).getAllByRole("cell")[4]).toHaveTextContent(/^2$/),
    );
  });

  it("an approval invalidates every dataset query family", async () => {
    let me = STRANGER;
    const store = makeStore(() => me);
    await store.accessRequests.submit(ASK);
    me = OWNER;
    const { client } = wrap(<AccessInboxScreen ctx={ctx()} />, store);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    const card = await screen.findByRole("article", { name: /AR-0001 from Sam Stranger/ });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(card).getByRole("button", { name: /Confirm approval/ }));

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: datasetQueryKeys.datasets }),
    );
  });

  it("moves a decision out of Open at once, marked saving, and ignores a double click", async () => {
    let me = STRANGER;
    const store = makeStore(() => me);
    await store.accessRequests.submit(ASK);
    me = OWNER;
    const gate = deferred<Awaited<ReturnType<typeof store.accessRequests.approve>>>();
    const real = store.accessRequests.approve.bind(store.accessRequests);
    let captured!: string;
    const approve = vi.fn((id: string) => {
      captured = id;
      return gate.promise;
    });
    store.accessRequests.approve = approve;
    wrap(<AccessInboxScreen ctx={ctx()} />, store);

    const card = await screen.findByRole("article", { name: /AR-0001/ });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const confirm = within(card).getByRole("button", { name: /Confirm approval/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("article", { name: /AR-0001/ })).toBeNull());
    const notices = screen.getByRole("region", { name: "Your decisions" });
    expect(notices).toHaveTextContent("Saving… Approve AR-0001 for Sam Stranger");
    expect(notices).not.toHaveTextContent("Approved");
    fireEvent.click(screen.getByRole("button", { name: /Decided/ }));
    const decided = await screen.findByRole("table", { name: "Decided requests" });
    expect(decided).toHaveTextContent("Saving…");
    expect(decided).not.toHaveTextContent("Active");
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    // One key for this confirmation, passed through to the direct add.
    expect(approve).toHaveBeenCalledWith(captured, { idempotencyKey: expect.any(String) });

    gate.resolve(await real(captured));
    expect(await screen.findByText(/Approved AR-0001/)).toBeInTheDocument();
    expect(decided).toHaveTextContent("Active");
  });

  it("an owner rejects with a note, and nothing goes on the change list", async () => {
    let me = STRANGER;
    const store = makeStore(() => me);
    await store.accessRequests.submit(ASK);
    me = OWNER;
    wrap(<AccessInboxScreen ctx={ctx()} />, store);

    const card = await screen.findByRole("article", { name: /AR-0001/ });
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    expect(within(card).getByRole("heading", { name: "Review rejection" })).toHaveFocus();
    fireEvent.change(within(card).getByLabelText(/Note to Sam Stranger/), {
      target: { value: "Tester is enough" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Confirm rejection/ }));

    expect(await screen.findByText("Rejected AR-0001.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your decisions" }).parentElement).toHaveFocus();
    expect(await store.changeList.listEntries()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Decided/ }));
    expect(await screen.findByRole("table", { name: "Decided requests" })).toHaveTextContent(
      "“Tester is enough”",
    );
  });

  it("says so when the viewer owns no datasets", async () => {
    wrap(
      <AccessInboxScreen ctx={ctx()} />,
      makeStore(() => STRANGER),
    );
    expect(await screen.findByText("You don't own any datasets")).toBeInTheDocument();
  });
});
