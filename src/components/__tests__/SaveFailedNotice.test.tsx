import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeltaApiError, createDeltaStore, httpTransport } from "@/data/adapters/delta";
import { makeNewRequest } from "@/data/__tests__/fixture";
import { useSubmitRequest } from "@/data/queries";
import { StoreProvider } from "@/data/store-provider";
import { SaveFailedNotice } from "../SaveFailedNotice";

const UNKNOWN = "We couldn't confirm this was saved. Reload to check before trying again.";

describe("SaveFailedNotice", () => {
  afterEach(cleanup);

  it("tells the person to reload and check before retrying when the outcome is unknown", () => {
    const onReload = vi.fn();
    render(
      <SaveFailedNotice
        error={new DeltaApiError(503, "outcome-unknown", UNKNOWN)}
        onReload={onReload}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "We couldn't confirm your request was saved",
    );
    expect(screen.getByRole("alert").textContent).toContain("Reload to check before trying again.");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("says plainly that it wasn't saved for any other failure, with no reload prompt", () => {
    render(
      <SaveFailedNotice
        error={new DeltaApiError(409, "already-exists", "Request REQ-1 already exists.")}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Your request wasn't saved");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("says the sign-in expired, never 'wasn't saved', when the proxy's sign-in page answered (#189)", async () => {
    const store = createDeltaStore({
      transport: httpTransport(
        vi.fn(
          async () =>
            new Response("<!DOCTYPE html><html>Sign in</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        ) as unknown as typeof fetch,
      ),
    });
    const error = await store.requests.createRequest(makeNewRequest()).catch((e: Error) => e);
    render(<SaveFailedNotice error={error as DeltaApiError} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Your sign-in has expired");
    expect(alert.textContent).toContain("nothing was saved");
    expect(alert.textContent).not.toMatch(/wasn't saved|Unexpected token|DOCTYPE/);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("shows the server's reload-first message after a legacy submit whose outcome is unknown", async () => {
    const transport = {
      read: vi.fn(),
      command: vi.fn(),
      legacyWrite: vi.fn(async () => {
        throw new DeltaApiError(503, "outcome-unknown", UNKNOWN);
      }),
    };
    const store = createDeltaStore({ transport });
    function Harness() {
      const submit = useSubmitRequest();
      return (
        <>
          <button type="button" onClick={() => submit.mutate(makeNewRequest())}>
            Submit
          </button>
          {submit.isError && submit.error && <SaveFailedNotice error={submit.error} />}
        </>
      );
    }
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <Harness />
        </StoreProvider>
      </QueryClientProvider>,
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(UNKNOWN));
    expect(transport.legacyWrite).toHaveBeenCalledTimes(1);
  });
});
