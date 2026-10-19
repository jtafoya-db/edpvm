import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// The onboarding entrypoint pulls ds.jsx -> the heavy USWDS design system. Mock
// it with a no-op StepIndicator (the only component ds() resolves on this
// screen); the wizard body is rendered by <SchemaForm>, which is what we
// exercise here. vitest hoists this above the side-effect import below.
vi.mock("@/design-system/uswds-design-system-3f2f32", () => ({
  StepIndicator: () => null,
}));

// Importing the REAL entrypoint registers window.OnboardingScreen (+ globals).
import "../../legacy/onboarding.jsx";
// The screen reads app data through the seam (getData), the way the host
// (App.jsx) injects it via setData before each render — not window.AppData.
import { setData } from "../../legacy/appDataBridge.js";
import { onboardingStore } from "../Onboarding/__tests__/store-wrapper";

type Dict = Record<string, unknown>;
const w = window as unknown as Dict;

// Minimal stand-ins for the prototype chrome the bootstrap normally puts on
// window. They render children/plain markup; parity here is about the assembled
// request, not the chrome visuals (the fields, cards and nav are native to
// SchemaForm and render regardless).
const domains = [
  { id: "individual-filing", name: "Individual Filing" },
  { id: "business-filing", name: "Business Filing" },
  { id: "enforcement-collections", name: "Enforcement & Collections" },
];

function installGlobals() {
  const appData = { domains, dom: (id: string) => domains.find((d) => d.id === id) };
  w["AppData"] = appData;
  // Inject through the seam so OnboardingScreen's getData() resolves, mirroring
  // the host wiring (App.jsx calls setData(data) before screens render).
  setData(appData);
  w["AppIcon"] = () => null;
  w["Pill"] = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  w["Panel"] = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  w["SectionHead"] = ({ title, eyebrow }: { title: string; eyebrow?: string }) => (
    <div>
      <div>{eyebrow}</div>
      <h2>{title}</h2>
    </div>
  );
  w["Page"] = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  w["Trail"] = () => <nav />;
}

afterEach(cleanup);

function next(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
}
function clickButton(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}
function setField(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

// The complete request the ORIGINAL hand-written wizard produced for this exact
// sequence of choices — hand-computed from the config templates + sizing/ROI
// heuristics, NOT read back from assembleRequest. Uses a NON-DEFAULT off-pattern
// ingest ("other" -> architecture consultation) and NON-DEFAULT platform-built
// delivery ("full") so the conditional subrequest paths are exercised.
const GOLDEN_REQUEST = {
  id: "REQ-2080",
  title: "EDP data onboarding: Collections case signals",
  submittedAt: "Jun 5, 2026",
  status: "In progress",
  overall: "Submitted — pending EDP business and ROI review",
  purpose:
    "Onboard Collections case signals from IDRS into the Enforcement & Collections domain via " +
    "Something else (needs consultation), consumed through Tableau. Prioritize balance-due cases " +
    "across treatment streams. Mission value: Reduce the tax gap, Reduce cost and contractor " +
    "support (primary: Reduce the tax gap). Sizing: Extra large — reserved capacity (40000 GB, " +
    "Streaming loads, Very heavy / ML features transforms, 200 query users) · est. $6.5M/yr vs. " +
    "$1.3M annual benefit (ROI 0.2x).",
  items: [
    {
      kind: "Onboarding",
      label: "Collections case signals",
      sub: "Enforcement & Collections · Extra large — reserved capacity",
    },
    {
      kind: "Onboarding",
      label: "Ingestion — Something else (needs consultation)",
      sub: "Streaming · Very heavy / ML features transforms",
    },
    { kind: "Onboarding", label: "Consumption — Tableau", sub: "200 query users" },
    { kind: "Onboarding", label: "Platform capacity", sub: "151480 DBU/mo · 62.5 TB" },
    {
      kind: "Onboarding",
      label: "Mission value — Reduce the tax gap",
      sub: "Reduce the tax gap · Reduce cost and contractor support",
    },
    {
      kind: "Onboarding",
      label: "Delivery — We need data engineering support",
      sub: "EDP data engineering support requested",
    },
  ],
  subRequests: [
    {
      system: "Architecture consultation",
      status: "active",
      detail: "Pattern outside approved list — EDP architecture review required",
    },
    {
      system: "Data engineering capacity review",
      status: "pending",
      detail: "We need data engineering support — EDP platform engineering effort",
    },
    {
      system: "EDP business and ROI review",
      status: "pending",
      detail: "Reduce the tax gap · $6.5M/yr est. cost · ROI 0.2x",
    },
    {
      system: "EDP intake CCB",
      status: "pending",
      detail: "Enforcement & Collections intake change control board",
    },
    {
      system: "BEARS entitlement creation",
      status: "pending",
      detail: "Access entitlements for 200 query users",
    },
    {
      system: "DBX users, Unity Catalog, and compute provisioning",
      status: "pending",
      detail: "Medallion layers + pipeline scaffold",
    },
  ],
  stageIndex: 0,
};

describe("OnboardingScreen — end-to-end request parity (golden fixture)", () => {
  it("drives the real entrypoint through all 8 steps and submits the exact request", async () => {
    installGlobals();
    // Pin the request number (2080 + floor(random*19)) and the estimator timer.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const submitRequest = vi.fn();
    const submitOnboarding = vi
      .fn()
      .mockResolvedValue({ id: "ONB-1001", stage: "business-roi-review" });
    const go = vi.fn();
    const flash = vi.fn();
    const ctx = { submitRequest, go, flash };

    try {
      const OnboardingScreen = w["OnboardingScreen"] as React.ComponentType<{ ctx: unknown }>;
      expect(typeof OnboardingScreen).toBe("function");
      render(<OnboardingScreen ctx={ctx} />, {
        wrapper: onboardingStore(submitOnboarding).Wrapper,
      });

      // step 0 — source profile (non-default source system + target domain)
      setField(/initiative name/i, "Collections case signals");
      setField(/source system/i, "IDRS");
      setField(/target domain/i, "enforcement-collections");
      fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
      fireEvent.click(next());

      // step 1 — architecture: NON-DEFAULT off-pattern ingest + changed access
      clickButton(/Something else \(needs consultation\)/i);
      clickButton(/^Tableau/i);
      fireEvent.click(next());

      // step 2 — delivery: NON-DEFAULT platform-built model
      clickButton(/We need data engineering support/i);
      fireEvent.click(next());

      // step 3 — business: retarget levers + outcome, custom benefit
      clickButton(/Reduce fraud and improper payments/i); // deselect the default
      clickButton(/Reduce the tax gap/i);
      clickButton(/Reduce cost and contractor support/i);
      setField(/business justification/i, "Prioritize balance-due cases across treatment streams.");
      setField(/primary mission outcome/i, "taxgap");
      setField(/estimated annual benefit/i, "1250000");
      fireEvent.click(next());

      // step 4 — datasets & owners (#86)
      setField(/^Dataset 1 name$/, "Collections case signals (curated)");
      setField(/^Dataset 1 domain$/, "enforcement-collections");
      setField(/^Dataset 1 tag$/, "collections_case_signals");
      const owner = within(screen.getByRole("group", { name: "Dataset 1 owner 1" }));
      fireEvent.click(owner.getByRole("radio", { name: /someone else/i }));
      fireEvent.change(owner.getByLabelText("Owner's name"), { target: { value: "C. Reyes" } });
      fireEvent.change(owner.getByLabelText("Owner's email"), {
        target: { value: "c.reyes@example.test" },
      });
      fireEvent.click(next());

      // step 5 — workspace needs (#86)
      setField(/isolated from other tenants/i, "Yes — it must be isolated from other tenants");
      setField(/how many people/i, "9");
      fireEvent.click(next());

      // step 6 — sizing: non-default volume/frequency/complexity/users, then run
      setField(/data volume/i, "40000");
      setField(/load frequency/i, "Streaming");
      setField(/transformation complexity/i, "Very heavy / ML features");
      setField(/business users needing to query/i, "200");
      clickButton(/run ai sizing/i);
      act(() => vi.advanceTimersByTime(900));
      fireEvent.click(next());

      // step 7 — review & submit
      clickButton(/submit data onboarding request/i);
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }

    // The onboarding request is created on the new lifecycle from the extended intake...
    await waitFor(() => expect(submitOnboarding).toHaveBeenCalledTimes(1));
    expect(submitOnboarding.mock.calls[0]?.[0]).toMatchObject({
      initiativeName: "Collections case signals",
      businessCase: "Prioritize balance-due cases across treatment streams.",
      annualBenefit: 1250000,
      levers: ["taxgap", "cost"],
      datasets: [
        {
          name: "Collections case signals (curated)",
          domain: "enforcement-collections",
          datasetTag: "collections_case_signals",
          owners: [{ name: "C. Reyes", email: "c.reyes@example.test" }],
        },
      ],
      workspaceNeeds: { isolation: "Yes — it must be isolated from other tenants", teamSize: 9 },
    });

    // ...and nothing else: no old-model request is written (#176). The assembled
    // request only feeds the confirmation summary; its golden shape is pinned in
    // schema.test.ts ("assembleRequest (launch parity)").
    await screen.findByText("Onboarding request submitted");
    expect(submitRequest).not.toHaveBeenCalled();
    expect(screen.getByText(GOLDEN_REQUEST.title)).toBeTruthy();
    expect(screen.getByText(GOLDEN_REQUEST.purpose)).toBeTruthy();
    // We land on the inline confirmation showing the onboarding request and its stage,
    // never the (gated) old-model status screen.
    expect(flash).toHaveBeenCalledWith("Onboarding request submitted for business & ROI review");
    expect(go).not.toHaveBeenCalledWith("status", { id: "REQ-2080" });
    expect(screen.getByText("Onboarding request submitted")).toBeTruthy();
    expect(screen.getByText("ONB-1001")).toBeTruthy();
  });
});
