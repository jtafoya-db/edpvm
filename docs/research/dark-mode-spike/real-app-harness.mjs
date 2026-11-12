// Dark-mode spike #347 evidence harness. Drives a local dev server (memory
// backend) in headless Chrome and injects the prototype into the served HTML
// <head> (init script + dark-tokens.css), as a real implementation would ship
// it, so nothing in the app source changes. Writes screenshots, a print PDF
// and report.json (axe WCAG 2.1 A/AA, first frame, keyboard stops, print,
// persistence) to docs/research/dark-mode-spike/out/ (gitignored). OUT may
// name another directory, but only one inside the repo. Usage:
//   npx vite dev --port 5347 --strictPort &
//   AXE_PATH=<axe.min.js> node docs/research/dark-mode-spike/real-app-harness.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = await fs.realpath(fileURLToPath(new URL("../../..", import.meta.url)));
const insideRoot = (target) => {
  const rel = path.relative(ROOT, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const OUT = path.resolve(ROOT, process.env.OUT ?? "docs/research/dark-mode-spike/out");
if (!insideRoot(OUT)) throw new Error(`OUT must be inside the repo (${ROOT}), got ${OUT}`);
await fs.mkdir(OUT, { recursive: true });
// Re-check after creating it, so a symlink can't point the output elsewhere.
if (!insideRoot(await fs.realpath(OUT))) throw new Error(`OUT resolves outside the repo: ${OUT}`);

const { chromium } = await import(`${ROOT}/node_modules/playwright/index.mjs`);
const { THEME_INIT_SCRIPT } = await import(`${ROOT}/src/prototypes/dark-mode/theme.ts`);
const CSS = await fs.readFile(`${ROOT}/src/prototypes/dark-mode/dark-tokens.css`, "utf8");
const AXE = await fs.readFile(process.env.AXE_PATH, "utf8");
const BASE = process.env.APP_URL ?? "http://localhost:5347";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const report = {};

// mode: baseline-* = today's app (no prototype); proto-* = prototype injected.
const MODES = {
  "baseline-light": { scheme: "light", inject: false },
  "baseline-systemdark": { scheme: "dark", inject: false },
  "proto-light": { scheme: "light", inject: true },
  "proto-system-dark": { scheme: "dark", inject: true },
  "proto-explicit-dark": { scheme: "light", inject: true, saved: "dark" },
  "proto-explicit-light-on-dark-device": { scheme: "dark", inject: true, saved: "light" },
};
const SCREENS = [
  ["home", null],
  ["onboarding", "Onboard new data"],
  ["eir", "My EIR"],
  ["datasets", "Datasets"],
  ["access-requests", "Access requests"],
  ["onboarding-requests", "My onboarding requests"],
];

async function newPage(mode) {
  const m = MODES[mode];
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: m.scheme,
  });
  if (m.saved) await ctx.addInitScript((v) => localStorage.setItem("edp-vm:theme", v), m.saved);
  // First-paint probe: record the root class and body background on the first frame.
  await ctx.addInitScript(() => {
    requestAnimationFrame(() => {
      window.__firstFrame = {
        dark: document.documentElement.classList.contains("dark"),
        bg: document.body ? getComputedStyle(document.body).backgroundColor : "no body",
      };
    });
  });
  if (m.inject) {
    await ctx.route(`${BASE}/`, async (route) => {
      const res = await route.fetch();
      let html = await res.text();
      html = html.replace(
        "<head>",
        `<head><script>${THEME_INIT_SCRIPT}</script><style data-proto>${CSS}</style>`,
      );
      await route.fulfill({
        response: res,
        body: html,
        headers: { ...res.headers(), "content-type": "text/html" },
      });
    });
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => (report.errors ??= []).push(`${mode}: ${e}`));
  return page;
}

async function axe(page) {
  if (!(await page.evaluate(() => Boolean(globalThis.axe))))
    await page.addScriptTag({ content: AXE });
  return page.evaluate(async () =>
    (
      await globalThis.axe.run(document.body, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      })
    ).violations.map((v) => ({
      id: v.id,
      n: v.nodes.length,
      sample: v.nodes
        .slice(0, 4)
        .map((x) => `${x.target.join(" ")} :: ${(x.any[0]?.message || "").slice(0, 140)}`),
    })),
  );
}

for (const mode of Object.keys(MODES)) {
  report[mode] = {};
  const page = await newPage(mode);
  await page.goto(`${BASE}/#home`);
  await page.waitForSelector("header", { timeout: 60000 });
  await page.waitForTimeout(1200);
  report[mode].firstFrame = await page.evaluate(() => window.__firstFrame);
  for (const [name, link] of SCREENS) {
    if (link) {
      await page.locator("header").getByRole("link", { name: link, exact: true }).first().click();
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: `${OUT}/${mode}--${name}.png`, fullPage: false });
    const v = await axe(page);
    report[mode][name] = {
      h1: await page.evaluate(() => document.querySelector("h1,h2")?.textContent?.trim()),
      axe: v,
    };
  }
  await page.context().close();
}

// Keyboard + focus visibility on the dark prototype: Tab through the header and
// the first form, record the focus indicator each control actually paints.
{
  const page = await newPage("proto-system-dark");
  await page.goto(`${BASE}/#onboarding`);
  await page.waitForSelector("header");
  await page.waitForTimeout(1500);
  const stops = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        let bgEl = el,
          bg = "rgba(0, 0, 0, 0)";
        while (bgEl && (bg = getComputedStyle(bgEl).backgroundColor) === "rgba(0, 0, 0, 0)")
          bgEl = bgEl.parentElement;
        return {
          el: `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || "").trim().slice(0, 40)}"`,
          outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
          boxShadow: cs.boxShadow.slice(0, 60),
          behind: bg,
        };
      }),
    );
    if (i === 5) await page.screenshot({ path: `${OUT}/proto-system-dark--focus.png` });
  }
  report.keyboard = stops;
  // Print: what the dark-mode page resolves to under print media.
  await page.emulateMedia({ media: "print" });
  report.print = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    textDefault: getComputedStyle(document.documentElement)
      .getPropertyValue("--text-default")
      .trim(),
    bodyColor: getComputedStyle(document.body).color,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  await page.pdf({ path: `${OUT}/proto-system-dark--print.pdf` });
  await page.emulateMedia({ media: "screen" });
  // Persistence: explicit choice survives reload; "system" follows a live device change.
  await page.evaluate(() => localStorage.setItem("edp-vm:theme", "light"));
  await page.reload();
  await page.waitForSelector("header");
  const afterReloadLight = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  await page.evaluate(() => localStorage.removeItem("edp-vm:theme"));
  await page.reload();
  await page.waitForSelector("header");
  const systemDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  report.persistence = {
    savedLightOnDarkDevice_isDark: afterReloadLight,
    noSaved_onDarkDevice_isDark: systemDark,
  };
  await page.context().close();
}

// Modal: EIR "Discard unsaved changes" dialog (Radix AlertDialog, shadcn wrapper).
for (const mode of ["baseline-light", "proto-system-dark"]) {
  const page = await newPage(mode);
  try {
    await page.goto(`${BASE}/#home`);
    await page.waitForSelector("header");
    await page.locator("header").getByRole("link", { name: "My EIR", exact: true }).first().click();
    await page.waitForTimeout(2000);
    const start = page.getByRole("button", { name: /start|begin|continue|create/i }).first();
    if (await start.count()) {
      await start.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    const field = page.locator("main input[type=text], main textarea").first();
    await field.fill("Spike edit");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Discard unsaved changes" }).click();
    await page.getByRole("alertdialog").waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${OUT}/${mode}--modal.png` });
    report[mode].modal = {
      focused: await page.evaluate(() => document.activeElement?.textContent),
      axe: await axe(page),
    };
  } catch (e) {
    report[mode].modal = { error: String(e).slice(0, 300) };
  }
  await page.context().close();
}

await fs.writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
console.log("done");
