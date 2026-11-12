// Dark-mode spike (#347) seam: the real app shell (legacy App on the memory
// store, as AdminEditor.browser.test.tsx renders it) and representative
// components, under light, dark and device ("system") preference, in headless
// Chrome. Checks WCAG 2.1 AA text contrast, focus visibility on a keyboard
// pass, and the explicit choice. Throwaway with the prototype; see
// docs/research/dark-mode-spike.md.
//
// Order matters: the prototype sheet loads BEFORE the USWDS token sheet here,
// the opposite of the order that would favour it, to prove `:root.dark` wins
// on specificity rather than on load order.
import "./dark-tokens.css";
import "@/design-system/uswds-design-system-3f2f32/design-system/uswds/styles.css";

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Bar, BarChart } from "recharts";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { DiscardUnsavedChanges } from "@/components/Eir/DiscardUnsavedChanges";
import { ChartContainer } from "@/components/ui/chart";
import { createMemoryStore } from "@/data/adapters/memory";
import type { LegacyAppData } from "@/data/legacy-bridge";
import { readAppDataSeed } from "@/data/seed";
import { StoreProvider } from "@/data/store-provider";
import { FeatureGate } from "@/features/FeatureGate";
import { loadApp } from "@/legacy/bootstrap.jsx";
import { THEME_STORAGE_KEY, applyTheme, resolveTheme } from "./theme";
import { ThemeChoice, useThemePreference } from "./ThemeChoice";

type Theme = "light" | "dark";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  document.documentElement.className = "";
  localStorage.clear();
});

// ---- WCAG 2.1 contrast, computed from what Chrome actually paints ----------

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  // Let the browser normalise any CSS colour (oklch, var-resolved, named).
  const canvas = document.createElement("canvas").getContext("2d")!;
  canvas.fillStyle = "#000";
  canvas.fillStyle = value;
  const normal = String(canvas.fillStyle);
  if (normal.startsWith("#")) {
    const n = parseInt(normal.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const [r = 0, g = 0, b = 0, a = 1] = normal.match(/[\d.]+/g)!.map(Number);
  return [r, g, b, a];
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (i: 0 | 1 | 2) => top[i] * top[3] + bottom[i] * (1 - top[3]);
  return [mix(0), mix(1), mix(2), 1];
}

function luminance([r, g, b]: Rgba) {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba) {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The opaque colour behind an element: its own and its ancestors' fills,
 * composited. Null over a gradient or image, which a single ratio can't
 * describe (axe reports those as "needs review" too).
 */
function backdrop(element: Element): Rgba | null {
  const layers: Rgba[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.backgroundImage !== "none") return null;
    const fill = parseColor(style.backgroundColor);
    if (fill[3] > 0) layers.push(fill);
    if (fill[3] === 1) break;
  }
  // The canvas: what `color-scheme` paints when nothing else does.
  let colour: Rgba = document.documentElement.classList.contains("dark")
    ? [18, 18, 18, 1]
    : [255, 255, 255, 1];
  for (const layer of layers.reverse()) colour = over(layer, colour);
  return colour;
}

interface ContrastFailure {
  text: string;
  ratio: number;
  fg: string;
  bg: string;
}

/** Every visible HTML text run below `root` that misses AA (4.5:1, or 3:1 when large). */
function contrastFailures(root: Element): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || seen.has(element) || !node.textContent?.trim()) continue;
    if (element.closest("svg, [aria-hidden='true'], [inert]")) continue;
    seen.add(element);
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || element.getClientRects().length === 0) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue; // visually hidden (sr-only)
    const bg = backdrop(element);
    if (!bg) continue;
    const fg = over(parseColor(style.color), bg);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const ratio = contrast(fg, bg);
    if (ratio < (large ? 3 : 4.5))
      failures.push({
        text: node.textContent.trim().slice(0, 40),
        ratio: Math.round(ratio * 100) / 100,
        fg: `rgb(${fg.slice(0, 3).map(Math.round).join(", ")})`,
        bg: `rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`,
      });
  }
  return failures;
}

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---- The app shell -----------------------------------------------------------

async function renderShell(hash: string) {
  window.location.hash = hash;
  const App = await loadApp();
  window.React = React;
  const seed = readAppDataSeed();
  const data: LegacyAppData = {
    ...seed,
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
}

const SCREENS = [
  {
    hash: "#home",
    ready: () => screen.findByRole("button", { name: "Start the onboarding wizard" }),
    primaryControls: ["Start the onboarding wizard", "Launch onboarding wizard"],
  },
  {
    hash: "#onboarding",
    ready: () =>
      screen.findByRole("heading", { name: "Onboard new data into EDP" }, { timeout: 10_000 }),
    primaryControls: ["Continue"],
  },
  {
    hash: "#eir",
    ready: () => screen.findByRole("button", { name: "Acknowledge and continue" }),
    primaryControls: ["Acknowledge and continue"],
  },
  {
    hash: "#datasets",
    ready: () => screen.findByRole("heading", { name: "Datasets" }),
    primaryControls: [],
  },
  {
    hash: "#access-requests",
    ready: () => screen.findByRole("heading", { name: "Access requests" }),
    primaryControls: [],
  },
  {
    hash: "#onboarding-requests",
    ready: () => screen.findByRole("heading", { name: "My onboarding requests" }),
    primaryControls: [],
  },
];

function expectPrimaryFill(element: HTMLElement) {
  const style = getComputedStyle(element);
  expect(style.backgroundColor).toBe("rgb(0, 94, 162)");
  expect(style.color).toBe("rgb(255, 255, 255)");
}

describe.each<Theme>(["light", "dark"])("app shell in %s", (theme) => {
  it.each(SCREENS)("$hash has AA text contrast (navigation, form, status)", async (s) => {
    applyTheme(document.documentElement, theme);
    await renderShell(s.hash);
    await s.ready();
    const failures = contrastFailures(document.body);
    expect(failures).toEqual([]);
  });
});

describe("primary fill roles", () => {
  it.each(SCREENS)("$hash keeps its named primary controls #005ea2 behind #ffffff", async (s) => {
    await renderShell(s.hash);
    await s.ready();
    for (const name of s.primaryControls) expectPrimaryFill(screen.getByRole("button", { name }));
  });

  it.each(SCREENS)("$hash keeps the profile avatar #005ea2 behind #ffffff", async (s) => {
    await renderShell(s.hash);
    await s.ready();
    expectPrimaryFill(screen.getByRole("button", { name: "Open your profile" }));
  });
});

describe("dark tokens", () => {
  it("override the USWDS sheet even when it loads after them", () => {
    expect(parseColor(token("--surface-default"))).toEqual(parseColor("#ffffff"));
    applyTheme(document.documentElement, "dark");
    expect(parseColor(token("--surface-default"))).toEqual(parseColor("#2d2e2f"));
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");
  });

  it("has no pinned white-on-primary contrast carve-out after DM-1", async () => {
    applyTheme(document.documentElement, "dark");
    await renderShell("#home");
    await screen.findByRole("navigation", {}, { timeout: 10_000 });
    expect(contrastFailures(document.body)).toEqual([]);
  });

  it("keep a focus indicator at 3:1 against its backdrop on every keyboard stop", async () => {
    applyTheme(document.documentElement, "dark");
    await renderShell("#onboarding");
    await screen.findByRole("heading", { name: "Onboard new data into EDP" }, { timeout: 10_000 });
    document.body.focus();
    const stops: FocusStop[] = [];
    for (let i = 0; i < 14; i++) {
      await userEvent.keyboard("{Tab}");
      stops.push(focusStop(document.activeElement as HTMLElement));
    }
    expect(stops).toHaveLength(14);
    expect(stops.filter((stop) => !stop.ok)).toEqual([]);
  });
});

interface FocusStop {
  element: string;
  kind: "outline" | "box-shadow" | "none";
  width: number;
  colour: string;
  ratio: number;
  ok: boolean;
}

/**
 * What the focused element paints as its indicator: an outline, or (as USWDS
 * ChoiceField does) a box-shadow ring. The ring sits outside the element, so
 * it is measured against the parent's backdrop. Chrome's `auto` outline is
 * measured by its computed colour; Chrome paints it as a two-tone ring, so
 * this is the conservative half.
 */
function focusStop(element: HTMLElement): FocusStop {
  const style = getComputedStyle(element);
  let kind: FocusStop["kind"] = "none";
  let width = 0;
  let colour: Rgba = [0, 0, 0, 0];
  if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) {
    kind = "outline";
    width = parseFloat(style.outlineWidth);
    colour = parseColor(style.outlineColor);
  } else if (style.boxShadow !== "none") {
    const ring = style.boxShadow.match(/^(rgba?\([^)]*\)) (?:-?[\d.]+px ){3}([\d.]+)px/);
    if (ring?.[1] && ring[2]) {
      kind = "box-shadow";
      width = parseFloat(ring[2]);
      colour = parseColor(ring[1]);
    }
  }
  const behind = backdrop(element.parentElement ?? element) ?? parseColor("#000");
  const ratio = colour[3] > 0 ? contrast(over(colour, behind), behind) : 0;
  const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
  return {
    element: `${element.tagName.toLowerCase()} "${label.slice(0, 30)}"`,
    kind,
    width,
    colour: style.outlineColor,
    ratio: Math.round(ratio * 100) / 100,
    ok: kind !== "none" && width > 0 && colour[3] > 0 && ratio >= 3,
  };
}

describe.each<Theme>(["light", "dark"])("representative components in %s", (theme) => {
  it("status notice (FeatureGate stub) has AA contrast", () => {
    applyTheme(document.documentElement, theme);
    render(<FeatureGate id="access-request-persistence" presentation="notice" />);
    expect(contrastFailures(document.body)).toEqual([]);
  });

  it("modal (Radix AlertDialog via shadcn) opens with AA contrast and focus on Keep editing", async () => {
    applyTheme(document.documentElement, theme);
    render(<DiscardUnsavedChanges disabled={false} onDiscard={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard unsaved changes" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(document.activeElement?.textContent).toBe("Keep editing");
    const failures = contrastFailures(dialog);
    expect(failures).toEqual([]);
  });

  it("chart (shadcn ChartContainer) swaps series colour by theme, at 3:1 against the surface", () => {
    applyTheme(document.documentElement, theme);
    const { container } = render(
      <div style={{ background: "var(--surface-default)", width: 320, height: 160 }}>
        <ChartContainer
          config={{
            value: { label: "Requests", theme: { light: "#005ea2", dark: "#58b4ff" } },
          }}
          style={{ width: 320, height: 160 }}
        >
          <BarChart data={[{ value: 3 }, { value: 5 }]} width={320} height={160}>
            <Bar dataKey="value" fill="var(--color-value)" isAnimationActive={false} />
          </BarChart>
        </ChartContainer>
      </div>,
    );
    const bar = container.querySelector(".recharts-bar-rectangle path, .recharts-rectangle")!;
    expect(bar).not.toBeNull();
    const fill = parseColor(getComputedStyle(bar).fill);
    expect(fill).toEqual(parseColor(theme === "dark" ? "#58b4ff" : "#005ea2"));
    expect(contrast(fill, parseColor(token("--surface-default")))).toBeGreaterThanOrEqual(3);
  });
});

describe("explicit choice", () => {
  function Harness() {
    const [preference, setPreference] = useThemePreference();
    return <ThemeChoice value={preference} onChange={setPreference} />;
  }

  it("is a keyboard-operable radio group that applies, saves and overrides the device", async () => {
    render(<Harness />);
    const deviceIsDark = resolveTheme("system", window.matchMedia) === "dark";
    expect(
      (screen.getByRole("radio", { name: "Match my device" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(deviceIsDark);

    screen.getByRole("radio", { name: "Match my device" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect((screen.getByRole("radio", { name: "Light" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await userEvent.keyboard("{ArrowDown}");
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(contrastFailures(document.body)).toEqual([]);
  });
});
