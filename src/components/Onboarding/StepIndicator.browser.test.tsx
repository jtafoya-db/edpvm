/// <reference types="@vitest/browser-playwright" />
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryStore } from "../../data/adapters/memory";
import type { LegacyAppData } from "../../data/legacy-bridge";
import { completeIntake } from "../../data/onboarding/intake.fixtures";
import type { OnboardingIntake } from "../../data/onboarding/types";
import { readAppDataSeed } from "../../data/seed";
import type { DataStore } from "../../data/store";
import { StoreProvider } from "../../data/store-provider";
import type { UserProfile } from "../../data/types";
import { loadApp } from "../../legacy/bootstrap.jsx";
import { loadSchema } from "../../schema";
import { fillDatasetOwner, fillInitiativeStep } from "./__tests__/intake-wizard";
import "@/design-system/uswds-design-system-3f2f32/design-system/uswds/styles.css";

// The onboarding step indicator on the real routes (#165): the app as it ships,
// so the design system's own StepIndicator draws it, never the headless test
// chrome (which already wraps and marks the current step).

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const STEPS = loadSchema().steps;
const LABELS = STEPS.map((s) => s.label);
const titleOf = (label: string) => STEPS.find((s) => s.label === label)!.title;

function formControl(scope: HTMLElement, label: string | RegExp): HTMLElement {
  return within(scope)
    .getAllByLabelText(label)
    .find((element) => element.tagName !== "BUTTON")!;
}

let signedIn: UserProfile;

async function renderRoute(hash: string, prepare?: (store: DataStore) => Promise<void>) {
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
  signedIn = data.user;
  const store = createMemoryStore(data, { currentUser: async () => signedIn });
  await prepare?.(store);
  signedIn = data.user;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  window.location.hash = hash;
  render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>
        <App data={data} submitRequest={() => undefined} />
      </StoreProvider>
    </QueryClientProvider>,
  );
}

const INTAKE: OnboardingIntake = completeIntake({
  workspaceNeeds: { isolation: "Not sure", teamSize: 6 },
});

/** A request the business office sent back to the signed-in provider. */
async function sendBackARequest(store: DataStore) {
  const created = await store.onboarding.submit(INTAKE);
  signedIn = { ...signedIn, principalId: "scim-bo", onboardingReviewerRoles: ["business-office"] };
  await store.onboarding.decide(created.id, {
    type: "send-back",
    to: "submitted",
    note: "Which streams use it?",
  });
}

// ---- the new-onboarding wizard ---------------------------------------------

/** Open the wizard and fill its first step, so Continue moves on. */
async function openIntake() {
  await renderRoute("#onboarding");
  await screen.findByRole("heading", { name: titleOf(LABELS[0]!) });
  fillInitiativeStep(document.body);
  return document.body;
}

// ---- the resubmission wizard (#222) ----------------------------------------

async function openResubmission() {
  await renderRoute("#onboarding-requests", sendBackARequest);
  const open = await screen.findByRole("button", { name: "Review the intake and resubmit" });
  fireEvent.click(open);
  const wizard = screen.getByRole("region", { name: /^Edit the intake for/ });
  await within(wizard).findByRole("heading", { name: titleOf(LABELS[0]!) });
  return wizard;
}

// ---- reading the indicator -------------------------------------------------

/** The wizard's step indicator: the list holding every step label, in order. */
function indicatorIn(scope: HTMLElement, labels: readonly string[] = LABELS): HTMLElement {
  const lists = Array.from(scope.querySelectorAll("ol")).filter(
    (ol) => ol.children.length === labels.length && ol.textContent?.includes(labels[0]!),
  );
  expect(lists).toHaveLength(1);
  return lists[0]!.parentElement!;
}

const isShown = (el: Element) => {
  const box = el.getBoundingClientRect();
  return box.width > 1 && box.height > 1 && getComputedStyle(el).visibility !== "hidden";
};

/** Every element in the indicator that draws text on screen. */
function visibleTextBoxes(indicator: HTMLElement): HTMLElement[] {
  return Array.from(indicator.querySelectorAll<HTMLElement>("*")).filter(
    (el) =>
      isShown(el) &&
      Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
  );
}

function longestWordWidth(el: HTMLElement): number {
  const longest = (el.textContent ?? "").split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? "";
  const probe = document.createElement("span");
  probe.textContent = longest;
  probe.style.cssText = `position:fixed;visibility:hidden;white-space:nowrap;font:${getComputedStyle(el).font};`;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

/** The indicator's text is legible: nothing clipped, collided or off the page. */
function expectReadable(indicator: HTMLElement, width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const boxes = visibleTextBoxes(indicator);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    const rect = box.getBoundingClientRect();
    expect(rect.width, box.textContent ?? "").toBeGreaterThanOrEqual(longestWordWidth(box) - 1);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i]!.contains(boxes[j]!) || boxes[j]!.contains(boxes[i]!)) continue;
      const a = boxes[i]!.getBoundingClientRect();
      const b = boxes[j]!.getBoundingClientRect();
      expect(overlaps(a, b), `"${boxes[i]!.textContent}" overlaps "${boxes[j]!.textContent}"`).toBe(
        false,
      );
    }
}

/** The current step is marked for assistive tech and named in visible text. */
function expectCurrent(indicator: HTMLElement, label: string) {
  const marked = indicator.querySelectorAll('[aria-current="step"]');
  expect(marked).toHaveLength(1);
  expect(marked[0]!.textContent).toContain(label);
  const named = visibleTextBoxes(indicator).some((box) => box.textContent?.trim() === label);
  expect(named, `"${label}" is shown`).toBe(true);
}

/**
 * The label reaches the accessibility tree once: the list item that carries
 * aria-current, not a second visible copy as well.
 */
function expectAnnouncedOnce(indicator: HTMLElement, label: string) {
  const exposed = Array.from(indicator.querySelectorAll<HTMLElement>("*")).filter(
    (el) =>
      !el.closest('[aria-hidden="true"]') &&
      Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() === label,
      ),
  );
  expect(exposed).toHaveLength(1);
  expect(exposed[0]!.closest('[aria-current="step"]')).not.toBeNull();
}

/** Every label shows, left to right, as the full multi-label indicator. */
function expectFullIndicator(indicator: HTMLElement, labels: readonly string[] = LABELS) {
  const shown = visibleTextBoxes(indicator);
  const lefts = labels.map((label) => {
    const box = shown.find((b) => b.textContent?.trim() === label);
    expect(box, `"${label}" is shown`).toBeDefined();
    return box!.getBoundingClientRect().left;
  });
  for (let i = 1; i < lefts.length; i++) expect(lefts[i]!).toBeGreaterThan(lefts[i - 1]!);
}

// ---- driving the wizard -----------------------------------------------------

const button = (scope: HTMLElement, name: RegExp) => within(scope).getByRole("button", { name });

/** Press a wizard button with the keyboard: Tab onto it, then press Enter. */
async function pressWithKeyboard(control: HTMLElement) {
  // Land on it with a real Tab (out and back), as a keyboard user would.
  control.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(control);
  expectFocusVisible(control);
  await userEvent.keyboard("{Enter}");
}

/** Keyboard focus draws a ring: an outline or a box shadow. */
function expectFocusVisible(control: HTMLElement) {
  expect(control.matches(":focus-visible"), control.textContent ?? "").toBe(true);
  const style = getComputedStyle(control);
  const ring =
    (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
    style.boxShadow !== "none";
  expect(ring, `${control.textContent} shows its focus`).toBe(true);
}

/**
 * Tap a control with a real touch: Chrome's touch input over CDP, at the
 * control's centre on screen. Resolves with the pointer types it received.
 */
async function tap(control: HTMLElement): Promise<string[]> {
  control.scrollIntoView({ block: "center" });
  const received: string[] = [];
  const record = (event: PointerEvent) => received.push(event.pointerType);
  control.addEventListener("pointerdown", record);
  // The test page runs in an iframe that the runner may scale to fit.
  const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, 0);
  const scale = frame.width / window.innerWidth;
  const box = control.getBoundingClientRect();
  const point = {
    x: frame.left + (box.left + box.width / 2) * scale,
    y: frame.top + (box.top + box.height / 2) * scale,
  };
  const session = cdp();
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await new Promise(requestAnimationFrame);
  control.removeEventListener("pointerdown", record);
  return received;
}

/** On screen, inside the viewport, and at least a 44 by 44px target. */
function expectReachable(control: HTMLElement, width: number) {
  const box = control.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(width);
  expect(box.width, `${control.textContent} width`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${control.textContent} height`).toBeGreaterThanOrEqual(44);
}

async function showsStep(scope: HTMLElement, label: string) {
  await within(scope).findByRole("heading", { name: titleOf(label) });
}

/** Fill the rest of the new intake's required fields, through to Review. */
async function walkIntakeToReview(scope: HTMLElement) {
  const next = () => fireEvent.click(button(scope, /^continue/i));
  await continueTo(scope, "Business case");
  fireEvent.change(formControl(scope, /business justification/i), {
    target: { value: "Prioritize balance-due cases across streams." },
  });
  fireEvent.click(button(scope, /Reduce fraud and improper payments/i));
  fireEvent.change(formControl(scope, /primary mission outcome/i), {
    target: { value: "fraud" },
  });
  fireEvent.change(formControl(scope, /estimated annual benefit/i), {
    target: { value: "100000" },
  });
  next();
  fireEvent.change(formControl(scope, "Dataset 1 name"), {
    target: { value: "Signals" },
  });
  fireEvent.change(formControl(scope, "Dataset 1 source system"), {
    target: { value: "IMF / Individual Master File" },
  });
  fireEvent.change(formControl(scope, "Dataset 1 domain"), {
    target: { value: "individual-filing" },
  });
  fireEvent.change(formControl(scope, "Dataset 1 ingestion method"), {
    target: { value: "eftu" },
  });
  fireEvent.change(formControl(scope, "Dataset 1 tag"), {
    target: { value: "signals" },
  });
  fillDatasetOwner(scope, 1, 1, { name: "Olive Owner", email: "olive.owner@example.gov" });
  next();
  fireEvent.change(formControl(scope, /code or work products/i), {
    target: { value: "Not sure — ask EDP staff to assess" },
  });
  fireEvent.change(formControl(scope, /how many people/i), { target: { value: "6" } });
  next();
  fireEvent.change(formControl(scope, /data volume/i), { target: { value: "500" } });
  fireEvent.change(formControl(scope, /load frequency/i), { target: { value: "Daily" } });
  fireEvent.change(formControl(scope, /transformation complexity/i), {
    target: { value: "Moderate — joins and recurring business rules" },
  });
  fireEvent.change(formControl(scope, /business users needing to query/i), {
    target: { value: "40" },
  });
  fireEvent.click(button(scope, /run preliminary estimate/i));
  await within(scope).findByRole(
    "button",
    { name: /re-run preliminary estimate/i },
    { timeout: 5000 },
  );
  next();
  await showsStep(scope, "Review & submit");
}

/** Continue until the step labelled `label` shows (the resubmission is prefilled). */
async function continueTo(scope: HTMLElement, label: string) {
  const heading = () => within(scope).queryByRole("heading", { name: titleOf(label) });
  for (let i = 0; i < LABELS.length && !heading(); i++) {
    if (within(scope).queryByRole("heading", { name: titleOf("Initiative") })) {
      fireEvent.change(formControl(scope, /data sensitivity/i), {
        target: { value: "SBU" },
      });
    }
    if (within(scope).queryByRole("heading", { name: titleOf("Architecture") })) {
      fireEvent.click(button(scope, /All within Databricks/i));
    }
    if (within(scope).queryByRole("heading", { name: titleOf("Delivery support") })) {
      fireEvent.click(button(scope, /We have our own resources/i));
    }
    fireEvent.click(button(scope, /^continue/i));
    await new Promise(requestAnimationFrame);
  }
  await showsStep(scope, label);
}

const consumers = [
  {
    name: "new-onboarding wizard",
    open: openIntake,
    toReview: walkIntakeToReview,
    submit: /^submit data onboarding request/i,
    submitted: () => screen.findByRole("heading", { name: "Onboarding request submitted" }),
  },
  {
    name: "resubmission wizard",
    open: openResubmission,
    toReview: async (scope: HTMLElement) => {
      fireEvent.change(screen.getByLabelText("Your answer"), {
        target: { value: "Collections and exam." },
      });
      await continueTo(scope, "Review & submit");
    },
    submit: /^answer and resubmit/i,
    submitted: () => screen.findByText(/^Resubmitted ONB-[A-Z0-9]+: it's back with/),
  },
] as const;

describe.each(consumers)("the $name's step indicator at 390px", (consumer) => {
  const { open, toReview } = consumer;
  it("keeps the real onboarding progress indicator within a 390px viewport", async () => {
    await page.viewport(390, 900);
    const scope = await open();
    expectReadable(indicatorIn(scope), 390);
    await continueTo(scope, "Delivery support");
    expectReadable(indicatorIn(scope), 390);
  });

  it("marks the real current onboarding step programmatically", async () => {
    await page.viewport(390, 900);
    const scope = await open();
    expectCurrent(indicatorIn(scope), LABELS[0]!);
    expect(indicatorIn(scope).textContent).toContain(`Step 1 of ${LABELS.length}`);
    await continueTo(scope, "Delivery support");
    expectCurrent(indicatorIn(scope), "Delivery support");
    expect(indicatorIn(scope).textContent).toContain(`Step 3 of ${LABELS.length}`);
    await toReview(scope);
    expectCurrent(indicatorIn(scope), "Review & submit");
    expectReadable(indicatorIn(scope), 390);
  });

  it("keeps Back, Continue and Submit usable by keyboard at 390px", async () => {
    await page.viewport(390, 900);
    const scope = await open();
    await continueTo(scope, "Architecture");
    fireEvent.click(button(scope, /All within Databricks/i));
    expectReachable(button(scope, /^back/i), 390);
    expectReachable(button(scope, /^continue/i), 390);

    await pressWithKeyboard(button(scope, /^continue/i));
    await showsStep(scope, "Delivery support");
    expectCurrent(indicatorIn(scope), "Delivery support");
    await pressWithKeyboard(button(scope, /^back/i));
    await showsStep(scope, "Architecture");
    expectCurrent(indicatorIn(scope), "Architecture");

    await toReview(scope);
    const submit = button(scope, consumer.submit);
    expectReachable(submit, 390);
    await pressWithKeyboard(submit);
    await consumer.submitted();
  });

  it("keeps Back, Continue and Submit usable by touch at 390px", async () => {
    await page.viewport(390, 900);
    const scope = await open();
    await continueTo(scope, "Architecture");
    fireEvent.click(button(scope, /All within Databricks/i));

    expect(await tap(button(scope, /^continue/i))).toEqual(["touch"]);
    await showsStep(scope, "Delivery support");
    expect(await tap(button(scope, /^back/i))).toEqual(["touch"]);
    await showsStep(scope, "Architecture");
    expectCurrent(indicatorIn(scope), "Architecture");

    await toReview(scope);
    expect(await tap(button(scope, consumer.submit))).toEqual(["touch"]);
    await consumer.submitted();
  });

  it("leaves the step labels as progress, not controls", async () => {
    await page.viewport(390, 900);
    const scope = await open();
    const indicator = indicatorIn(scope);
    expect(indicator.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
  });

  it("announces the current step once to assistive tech", async () => {
    await page.viewport(390, 900);
    const scope = await open();
    await continueTo(scope, "Delivery support");
    expectAnnouncedOnce(indicatorIn(scope), "Delivery support");
  });
});

describe.each(consumers)("the $name's step indicator at tablet and desktop", ({ open }) => {
  it("keeps every label in a row at 1280px", async () => {
    await page.viewport(1280, 900);
    const scope = await open();
    expectFullIndicator(indicatorIn(scope));
    expect(indicatorIn(scope).textContent).not.toMatch(/Step \d+ of \d+/);
    await continueTo(scope, "Delivery support");
    expectFullIndicator(indicatorIn(scope));
    expectReadable(indicatorIn(scope), 1280);
  });

  // Eight labels already ran into each other at 768px on main, so a tablet gets
  // the narrow presentation too.
  it("shows the current step only where eight labels can't fit, at 768px", async () => {
    await page.viewport(768, 900);
    const scope = await open();
    await continueTo(scope, "Delivery support");
    expectReadable(indicatorIn(scope), 768);
    expectCurrent(indicatorIn(scope), "Delivery support");
    expect(indicatorIn(scope).textContent).toContain(`Step 3 of ${LABELS.length}`);
  });

  it.each([768, 1280])("marks the current step at %ipx", async (width) => {
    await page.viewport(width, 900);
    const scope = await open();
    expectCurrent(indicatorIn(scope), LABELS[0]!);
    await continueTo(scope, "Delivery support");
    expectCurrent(indicatorIn(scope), "Delivery support");
    expectAnnouncedOnce(indicatorIn(scope), "Delivery support");
  });
});

// The shared StepIndicator's other consumers keep their full layout above 390px.
describe("other StepIndicator consumers at tablet and desktop", () => {
  const STAGES = ["Submitted", "Business & ROI review", "CCB", "Standup"];

  it.each([768, 1280])("keeps the request's stage track in a row at %ipx", async (width) => {
    await page.viewport(width, 900);
    await renderRoute("#onboarding-requests", sendBackARequest);
    await screen.findByRole("button", { name: "Review the intake and resubmit" });
    const track = indicatorIn(document.body, STAGES);
    expectFullIndicator(track, STAGES);
    expectReadable(track, width);
  });

  it("marks the request's current stage", async () => {
    await page.viewport(1280, 900);
    await renderRoute("#onboarding-requests", sendBackARequest);
    await screen.findByRole("button", { name: "Review the intake and resubmit" });
    expectCurrent(indicatorIn(document.body, STAGES), "Submitted");
  });

  it("keeps the admin editor's live-preview steps in a row at 1280px", async () => {
    await page.viewport(1280, 900);
    await renderRoute("#admin");
    fireEvent.click(await screen.findByRole("button", { name: "Live preview" }));
    expectFullIndicator(indicatorIn(document.body));
    expectReadable(indicatorIn(document.body), 1280);
  });

  // On main its eight labels already ran into the counters at 768px.
  it("shows the admin editor's live preview as the current step only at 768px", async () => {
    await page.viewport(768, 900);
    await renderRoute("#admin");
    fireEvent.click(await screen.findByRole("button", { name: "Live preview" }));
    expectReadable(indicatorIn(document.body), 768);
    expectCurrent(indicatorIn(document.body), LABELS[0]!);
  });
});
