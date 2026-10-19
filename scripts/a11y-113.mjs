import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Install browser tooling outside the checkout; it is not part of the app.
const requireTools = createRequire(
  resolve(process.env.UX_TOOLS_DIR || "/tmp/ux-axe-113", "package.json"),
);
const { chromium } = requireTools("playwright");
const { AxeBuilder } = requireTools("@axe-core/playwright");
const base = process.env.A11Y_URL || "http://127.0.0.1:4113";
const output = process.env.A11Y_OUTPUT || "/tmp/ux-axe-113/verification";
const baseline = process.argv.includes("--baseline");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const evidence = [];
let failures = 0;

async function scan(page, state, width, rules) {
  let builder = new AxeBuilder({ page });
  if (rules) builder = builder.withRules(rules);
  const result = await builder.analyze();
  await page.screenshot({ path: `${output}/${state}-${width}.png`, fullPage: true });
  evidence.push({ state, width, url: page.url(), rules: rules || "all", ...result });
  console.log(state, width, result.violations.map((v) => `${v.id}:${v.nodes.length}`).join(", "));
  failures += result.violations.length;
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    // Local-only HTTP fixture: #admin is staff-only, so the browser evidence
    // route uses an admin session without changing the app server or env.
    await context.route("**/api/session", (route) =>
      route.fulfill({
        json: {
          principalId: "dev-local-user",
          name: "Local Dev (a11y fixture)",
          initials: "LD",
          title: "EDP User",
          tenant: "IRS Enterprise Data Platform",
          email: "local-dev@edp.invalid",
          isOnboardingLead: false,
          isAdmin: true,
          isSafeguardsValidator: true,
          onboardingReviewerRoles: ["business-office", "ccb"],
          slaConfig: {
            stages: {
              "edp-roi-review": 3,
              ccb: 5,
              "eir-validation": 3,
              "access-request-decision": 3,
            },
            dueSoonThresholdBusinessDays: 1,
            holidays: [],
            eirValidityDays: 365,
            accessRequestSlaProvisional: true,
          },
        },
      }),
    );
    const page = await context.newPage();
    for (const route of [
      "onboarding",
      "admin",
      "datasets",
      "team/ds-refund-anomaly-scores",
      "change-list",
    ]) {
      await page.goto(`${base}/#${route}`);
      await page.getByRole("main").waitFor();
      await page.getByRole("main").getByRole("heading", { level: 1 }).waitFor();
      await page.waitForTimeout(500);
      await scan(page, route.replaceAll("/", "-"), width);
    }

    await page.goto(`${base}/#onboarding`);
    await page.getByRole("heading", { name: "Tell us about the data" }).waitFor();
    if (!baseline && width === 390) {
      const nav = page.getByRole("navigation", { name: "Primary", exact: true });
      const box = await nav.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.height <= 60);
      for (const link of await nav.getByRole("link").all()) {
        await link.focus();
        assert.ok(
          await link.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const n = el.closest("nav").getBoundingClientRect();
            return r.left >= n.left - 1 && r.right <= n.right + 1;
          }),
          "focused navigation label is fully visible",
        );
      }
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      for (const name of ["Cancel", "Continue"]) {
        const button = page.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        assert.ok(
          await button.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return (
              document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest("button") === el
            );
          }),
          "bottom controls are not covered",
        );
      }
      await scan(page, "onboarding-invalid", width);
    }

    // Local-only HTTP fixture: do not use this setup to claim live preview UAT.
    await context.route("**/api/seed-config", (route) =>
      route.fulfill({ json: { datasetOwnerIds: ["dev-local-user"] } }),
    );
    await page.goto(`${base}/#team/ds-refund-anomaly-scores`);
    await page.reload();
    const form = page.getByRole("form", { name: "Add a member" });
    await form.getByLabel(/name/i).fill("A11y Tester");
    await form.getByLabel(/email/i).fill("a11y.tester@example.gov");
    await form.getByRole("button", { name: /Review/i }).click();
    await page.getByRole("button", { name: /Confirm/i }).click();
    await page.getByText("a11y.tester@example.gov", { exact: true }).waitFor();
    await scan(page, "team-pending", width);
    await page.evaluate(() => {
      location.hash = "change-list";
    });
    await page.getByRole("heading", { name: "Change list", exact: true }).waitFor();
    await scan(page, "change-list-pending", width);

    await page.goto(`${base}/#admin`);
    await page.getByRole("button", { name: "Save changes" }).click();
    if (!baseline) {
      const status = page.getByRole("status").filter({ hasText: "No changes to submit yet" });
      await status.waitFor({ state: "attached" });
      assert.equal(await status.getAttribute("aria-live"), "polite");
      assert.ok(await status.evaluate((el) => !!el.closest("main")));
    }
    // Targeted scan completes while the short-lived toast is still mounted.
    await scan(page, "admin-after-save", width, ["region", "heading-order"]);
    await context.close();
  }
  if (!baseline) assert.equal(failures, 0, "axe scans have no known violations");
} finally {
  await writeFile(`${output}/scans.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
