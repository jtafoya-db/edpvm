import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "../store-provider";
import { resetStoreForTests } from "../loadStore";
import type { UserProfile } from "../types";

const PROFILE: UserProfile = {
  principalId: "scim-reviewer",
  name: "Riley Reviewer",
  initials: "RR",
  title: "EDP staff",
  tenant: "EDP",
  email: "riley.reviewer@example.test",
  isOnboardingLead: false,
  isAdmin: true,
  onboardingReviewerRoles: ["business-office", "ccb"],
  slaConfig: {
    stages: {
      "edp-roi-review": 5,
      ccb: 7,
      "eir-validation": 3,
      "access-request-decision": 3,
    },
    dueSoonThresholdBusinessDays: 1,
    holidays: [],
    eirValidityDays: 365,
    accessRequestSlaProvisional: true,
  },
};

beforeAll(async () => {
  await import("../../legacy/appData.js");
});

afterEach(() => {
  cleanup();
  resetStoreForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("StoreProvider session loading", () => {
  it("shows an announced signed-out state when /api/session refuses the user", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    render(
      <StoreProvider>
        <div>Loaded app</div>
      </StoreProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/loading your session/i);
    expect(await screen.findByRole("alert")).toHaveTextContent(/sign in to continue/i);
    expect(screen.queryByText("Loaded app")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("does not cache a rejected loadStore promise, so Retry can recover", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(Response.json(PROFILE));

    render(
      <StoreProvider>
        <div>Loaded app</div>
      </StoreProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText("Loaded app")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
