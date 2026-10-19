import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryStore } from "../../data/adapters/memory";
import type { LegacyAppData } from "../../data/legacy-bridge";
import { readAppDataSeed } from "../../data/seed";
import { StoreProvider } from "../../data/store-provider";
import { loadApp } from "../../legacy/bootstrap.jsx";
import "@/design-system/uswds-design-system-3f2f32/design-system/uswds/styles.css";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

async function renderAdminRoute() {
  const App = await loadApp();
  window.React = React;
  const seed = readAppDataSeed();
  const data: LegacyAppData = {
    ...seed,
    user: { ...seed.user, isAdmin: true },
    statuses: {},
    sys: (id) => seed.systems.find((system) => system.id === id),
    dom: (id) => seed.domains.find((domain) => domain.id === id),
    bun: (id) => seed.bundles.find((bundle) => bundle.id === id),
    ds: (id) => seed.datasets.find((dataset) => dataset.id === id),
  };
  const store = createMemoryStore(data, { currentUser: async () => data.user });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>
        <App data={data} submitRequest={() => undefined} />
      </StoreProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByText("Admin · Intake form editor"));
  await screen.findByRole("heading", { name: "Admin console" });
  expect(window.location.hash).toBe("#admin");
}

function expectNoPageOverflow(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
}

function visibleElements<T extends HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

function expectUsableEditorControls() {
  const targets = visibleElements<HTMLElement>(
    '.admin-editor button, .admin-editor input:not([type="checkbox"]), .admin-editor select, .admin-editor textarea, .admin-editor label:has(> input[type="checkbox"])',
  );
  for (const target of targets)
    expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

  const focusable = visibleElements<HTMLElement>(
    ".admin-editor button, .admin-editor input, .admin-editor select, .admin-editor textarea",
  );
  for (const control of focusable) {
    control.focus();
    expect(document.activeElement).toBe(control);
    expect(getComputedStyle(control).outlineStyle).not.toBe("none");
  }
}

function expectTextKeepsItsLongestWord(label: HTMLElement) {
  const longestWord = label.textContent?.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? "";
  const probe = document.createElement("span");
  const style = getComputedStyle(label);
  probe.textContent = longestWord;
  probe.style.cssText = `position:fixed;visibility:hidden;white-space:nowrap;font:${style.font};`;
  document.body.appendChild(probe);
  const longestWordWidth = probe.getBoundingClientRect().width;
  probe.remove();
  expect(label.getBoundingClientRect().width).toBeGreaterThanOrEqual(longestWordWidth - 1);
}

function expectStepIndicatorMatchesItsResponsiveContract() {
  const indicator = screen.getByRole("region", { name: "Preview steps" });
  const labels = Array.from(indicator.querySelectorAll<HTMLElement>("[data-step-label]"));
  expect(labels.length).toBeGreaterThan(0);

  // Compact labels are visually clipped to 1px, but remain exposed to assistive
  // technology as the contents of the ordered list.
  for (const label of labels) {
    expect(label.closest('[aria-hidden="true"]')).toBeNull();
    expect(getComputedStyle(label).display).not.toBe("none");
    expect(getComputedStyle(label).visibility).not.toBe("hidden");
  }

  const compactSummary = indicator.querySelector<HTMLElement>(
    ':scope > div > [aria-hidden="true"]',
  );
  if (compactSummary) {
    const current = indicator.querySelector<HTMLElement>('[aria-current="step"]');
    expect(current).not.toBeNull();
    const steps = Array.from(indicator.querySelectorAll<HTMLElement>("li"));
    const currentStep = steps.indexOf(current!);
    expect(currentStep).toBeGreaterThanOrEqual(0);
    const currentLabel = current!.querySelector<HTMLElement>("[data-step-label]")!.textContent;
    const summaryText = Array.from(
      compactSummary.querySelectorAll<HTMLSpanElement>(":scope > span"),
    );
    expect(summaryText).toHaveLength(2);
    expect(summaryText[0]!.textContent).toBe(`Step ${currentStep + 1} of ${labels.length}`);
    expect(summaryText[1]!.textContent).toBe(currentLabel);
    for (const text of summaryText) expectTextKeepsItsLongestWord(text);
  } else {
    const visibleLabels = labels.filter((label) => label.getClientRects().length > 0);
    expect(visibleLabels).toHaveLength(labels.length);
    for (const label of visibleLabels) expectTextKeepsItsLongestWord(label);
  }
}

function expectSizingColumnCount(columns: 1 | 2) {
  const inputs = visibleElements<HTMLInputElement>('input[aria-label^="Coefficient freqFactor"]');
  expect(inputs.length).toBeGreaterThanOrEqual(3);
  const rows = inputs.slice(0, 3).map((input) => Math.round(input.getBoundingClientRect().top));
  const [firstRow, secondRow, thirdRow] = rows;
  expect(firstRow).toBeDefined();
  expect(secondRow).toBeDefined();
  expect(thirdRow).toBeDefined();

  if (columns === 1) {
    expect(new Set(rows).size).toBe(3);
  } else {
    expect(firstRow).toBe(secondRow);
    expect(thirdRow!).toBeGreaterThan(firstRow!);
  }
}

describe("AdminEditor — responsive route layout", () => {
  it("keeps every editor state usable within 390px, including long exported code", async () => {
    await page.viewport(390, 900);
    await renderAdminRoute();

    for (const name of ["Option lists", "Fields", "Sizing coefficients", "Structure"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expectNoPageOverflow(390);
      expectUsableEditorControls();
      if (name === "Sizing coefficients") expectSizingColumnCount(1);
    }

    fireEvent.click(screen.getByRole("button", { name: "Live preview" }));
    expectNoPageOverflow(390);
    expectUsableEditorControls();
    expectStepIndicatorMatchesItsResponsiveContract();

    fireEvent.click(screen.getByRole("button", { name: "Option lists" }));
    fireEvent.change(screen.getByLabelText(/name for ingestPatterns option eftu/i), {
      target: {
        value:
          "a-very-long-code-like-value-that-must-not-expand-the-page-beyond-the-mobile-viewport",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(screen.getByLabelText("Config diff")).toBeTruthy();
    expectNoPageOverflow(390);
    expectUsableEditorControls();
    const diff = screen.getByLabelText("Config diff");
    expect(diff.scrollWidth).toBeGreaterThan(diff.clientWidth);
  });

  it.each([768, 1280])("keeps Live-preview step labels intact at %ipx", async (width) => {
    await page.viewport(width, 900);
    await renderAdminRoute();
    fireEvent.click(screen.getByRole("button", { name: "Live preview" }));

    expectNoPageOverflow(width);
    expectStepIndicatorMatchesItsResponsiveContract();
  });

  it.each([768, 1280])("keeps the sizing grid at two columns at %ipx", async (width) => {
    await page.viewport(width, 900);
    await renderAdminRoute();
    fireEvent.click(screen.getByRole("button", { name: "Sizing coefficients" }));

    expectNoPageOverflow(width);
    expectSizingColumnCount(2);
  });
});
