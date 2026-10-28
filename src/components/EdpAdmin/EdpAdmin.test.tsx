import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryStore, StoreProvider } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EIR_READ_RETRY_DELAY_MS } from "@/data/queries";
import { EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import type { MemoryEirRepository } from "@/data/eir/repository";
import type { UserProfile } from "@/data/types";
import { setData } from "@/legacy/appDataBridge.js";
// Registers window.TopNav as a side effect.
import "@/legacy/chrome.jsx";
import { resetSessionIdentityCacheForTests, resolveSessionProfile } from "@/server/session";
import { redirectToEdpAdmin } from "./access";
import { EdpAdminScreen } from "./EdpAdminScreen";

afterEach(cleanup);

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}

beforeEach(() => {
  setGlobal("AppIcon", () => null);
});

const base = makeSnapshot().user;
const NOBODY: UserProfile = { ...base, principalId: "person-1", isAdmin: false };
const STAFF: Record<string, UserProfile> = {
  "EDP staff": { ...NOBODY, isAdmin: true },
  "business office": { ...NOBODY, onboardingReviewerRoles: ["business-office"] },
  CCB: { ...NOBODY, onboardingReviewerRoles: ["ccb"] },
  "safeguards validator": { ...NOBODY, isSafeguardsValidator: true },
};

const TopNav = (window as unknown as { TopNav: React.ComponentType<Record<string, unknown>> })
  .TopNav;

describe("top nav: one EDP Admin link, for EDP staff only", () => {
  it.each(Object.entries(STAFF))(
    "shows %s one EDP Admin link and no per-function links",
    (_, user) => {
      setData({ user });
      const go = vi.fn();
      render(<TopNav route={{ section: "home" }} go={go} />);
      const nav = screen.getByRole("navigation", { name: "Primary" });
      for (const old of ["Business & ROI review", "CCB inbox", "Change list", "Admin"]) {
        expect(within(nav).queryByRole("link", { name: old })).not.toBeInTheDocument();
      }
      fireEvent.click(within(nav).getByRole("link", { name: "EDP Admin" }));
      expect(go).toHaveBeenCalledWith("edp-admin", undefined);
    },
  );

  it("never shows the link to someone who isn't staff", () => {
    setData({ user: NOBODY });
    render(<TopNav route={{ section: "home" }} go={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "My EIR" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "EDP Admin" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Change list" })).not.toBeInTheDocument();
  });
});

describe("old staff hash routes redirect to their EDP Admin section", () => {
  it("moves both review inboxes, for anyone", () => {
    expect(redirectToEdpAdmin({ name: "review", params: { id: "ccb" } }, NOBODY)).toEqual({
      name: "edp-admin",
      params: { id: "ccb" },
    });
    expect(
      redirectToEdpAdmin({ name: "review", params: { id: "business-office" } }, NOBODY),
    ).toEqual({ name: "edp-admin", params: { id: "business-office" } });
    expect(redirectToEdpAdmin({ name: "review" }, NOBODY)?.params.id).toBe("business-office");
  });

  it("moves the change list for EDP staff, and leaves an owner's read-only link alone", () => {
    expect(redirectToEdpAdmin({ name: "change-list" }, STAFF["EDP staff"])).toEqual({
      name: "edp-admin",
      params: { id: "change-list" },
    });
    expect(redirectToEdpAdmin({ name: "change-list" }, NOBODY)).toBeNull();
    expect(redirectToEdpAdmin({ name: "eir" }, STAFF["EDP staff"])).toBeNull();
  });
});

function renderAdmin(user: UserProfile, id?: string) {
  const store = createMemoryStore(makeSnapshot());
  store.catalog.getUser = async () => user;
  const go = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <StoreProvider store={store}>
        <EdpAdminScreen ctx={{ go }} params={id ? { id } : {}} />
      </StoreProvider>
    </QueryClientProvider>,
  );
  return { store, go };
}

const sectionNav = () => screen.getByRole("navigation", { name: "EDP Admin sections" });
const sectionLinks = () =>
  within(sectionNav())
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("EDP Admin page: sections by role, through the session", () => {
  it("shows someone who isn't staff a plain not-available page", async () => {
    renderAdmin(NOBODY);
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "EDP Admin sections" })).toBeNull();
    expect(screen.queryByText(/inbox/i)).toBeNull();
  });

  it("gives the business office only its review inbox", async () => {
    renderAdmin(STAFF["business office"]!);
    expect(
      await screen.findByRole("heading", { level: 1, name: /Business & ROI review/ }),
    ).toBeVisible();
    expect(sectionLinks()).toEqual(["Business & ROI review"]);
  });

  it("gives the CCB only its inbox", async () => {
    renderAdmin(STAFF["CCB"]!);
    expect(await screen.findByRole("heading", { level: 1, name: /CCB/ })).toBeVisible();
    expect(sectionLinks()).toEqual(["CCB inbox"]);
    expect(
      within(sectionNav()).getByRole("link", { name: "CCB inbox (Change Control Board)" }),
    ).toHaveTextContent("CCB inbox");
  });

  it("gives EDP staff the change list, owner reassignment and the intake form editor, nothing they can't act on", async () => {
    const { go } = renderAdmin(STAFF["EDP staff"]!);
    expect(await screen.findByRole("heading", { level: 1, name: "Change list" })).toBeVisible();
    expect(sectionLinks()).toEqual([
      "Change list",
      "Owner reassignment",
      "Intake form editor",
      "EIR definitions",
    ]);
    expect(within(sectionNav()).getByRole("link", { name: "Change list" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(within(sectionNav()).getByRole("link", { name: "Intake form editor" }));
    expect(go).toHaveBeenCalledWith("edp-admin", { id: "intake-editor" });
  });

  it("links EDP staff to the existing intake form editor", async () => {
    const { go } = renderAdmin(STAFF["EDP staff"]!, "intake-editor");
    fireEvent.click(await screen.findByRole("button", { name: "Open the intake form editor" }));
    expect(go).toHaveBeenCalledWith("admin");
  });

  it("gives a safeguards validator the EIR inbox and the valid-EIR list", async () => {
    const user = STAFF["safeguards validator"]!;
    const store = createMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => user;
    await (store.eir as MemoryEirRepository).submit(
      "person-2",
      "Other Person",
      "/Volumes/edp/docs/eir/person-2/one.pdf",
      EIR_VALUES,
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EdpAdminScreen ctx={{ go: vi.fn() }} params={{ id: "eir" }} />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    expect(await within(inbox).findByText("Other Person")).toBeInTheDocument();
    expect(within(inbox).getByText("1 awaiting action")).toBeInTheDocument();
    expect(sectionLinks()).toEqual(["EIR validation", "EIR definitions"]);
  });

  function renderEirSection(listValidatorInbox: () => Promise<never>) {
    const store = createMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => STAFF["safeguards validator"]!;
    store.eir.listValidatorInbox = listValidatorInbox;
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <EdpAdminScreen ctx={{ go: vi.fn() }} params={{ id: "eir" }} />
        </StoreProvider>
      </QueryClientProvider>,
    );
  }

  it("shows the inbox loading, not an empty inbox or a count, while the first read is pending", async () => {
    renderEirSection(() => new Promise<never>(() => undefined));
    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    expect(within(inbox).getByRole("status")).toHaveTextContent("Loading the EIR inbox…");
    expect(within(inbox).queryByText("No EIRs are awaiting action.")).toBeNull();
    expect(within(inbox).queryByText("0 awaiting action")).toBeNull();
  });

  it("says plainly when the EIR inbox can't be read, without server text or stealing focus", async () => {
    renderEirSection(async () => {
      throw Object.assign(new Error("TABLE_OR_VIEW_NOT_FOUND secret_catalog.eir__eirs"), {
        status: 500,
      });
    });
    const sectionLink = await screen.findByRole("link", { name: "EIR validation" });
    sectionLink.focus();
    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    const alert = await within(inbox).findByRole(
      "alert",
      {},
      { timeout: EIR_READ_RETRY_DELAY_MS * 4 },
    );
    expect(alert).toHaveTextContent("We couldn't load the EIR inbox right now.");
    expect(alert).toHaveTextContent("This is a problem on our side, not your connection.");
    expect(inbox).not.toHaveTextContent("TABLE_OR_VIEW_NOT_FOUND");
    expect(within(inbox).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(inbox).queryByText("No EIRs are awaiting action.")).toBeNull();
    expect(document.activeElement).toBe(sectionLink);
  });

  it("refuses a section the person can't act on, and still offers theirs", async () => {
    renderAdmin(STAFF["safeguards validator"]!, "ccb");
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
    expect(screen.queryByText(/CCB inbox/, { selector: "h1" })).toBeNull();
    expect(sectionLinks()).toEqual(["EIR validation", "EIR definitions"]);
  });
});

describe("EDP Admin page: one EDP admin group holds every staff section (#226)", () => {
  const ADMIN_GROUP = "11111111111111";

  /** The profile `/api/session` serves for someone in `groups`, over a stubbed SCIM /Me. */
  async function sessionProfile(groups: string[]): Promise<UserProfile> {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_IDENTITY_CACHE_TTL_MS", "0");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", ADMIN_GROUP);
    vi.stubEnv("EDP_SAFEGUARDS_VALIDATOR_GROUP_ID", "1101");
    vi.stubEnv("EDP_BUSINESS_OFFICE_GROUP_ID", "1102");
    vi.stubEnv("EDP_CCB_GROUP_ID", "1103");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "3001",
          displayName: "Ada Admin",
          groups: groups.map((value) => ({ value, type: "direct" })),
        }),
        { status: 200 },
      ),
    );
    try {
      return await resolveSessionProfile(
        new Request("https://app.example/api/session", {
          headers: { "x-forwarded-access-token": "synthetic-token" },
        }),
      );
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
      resetSessionIdentityCacheForTests();
    }
  }

  it("gives an admin group member every section, the intake editor included", async () => {
    renderAdmin(await sessionProfile([ADMIN_GROUP]));
    expect(
      await screen.findByRole("heading", { level: 1, name: /Business & ROI review/ }),
    ).toBeVisible();
    expect(sectionLinks()).toEqual([
      "Business & ROI review",
      "CCB inbox",
      "EIR validation",
      "Change list",
      "Owner reassignment",
      "Intake form editor",
      "EIR definitions",
    ]);
  });

  it("shows a non-member, even one in every reserved group, a page that names the EDP admin group", async () => {
    renderAdmin(await sessionProfile(["1101", "1102", "1103"]));
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
    expect(
      screen.getByText("This page is for EDP staff: direct members of the EDP admin group."),
    ).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "EDP Admin sections" })).toBeNull();
  });
});
