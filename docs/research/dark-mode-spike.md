# Dark-mode spike: the smallest accessible approach (#347)

**Status:** spike findings. Nothing here ships dark mode. The prototype in
`src/prototypes/dark-mode/` isn't imported by the app, and a unit test fails if
any `src/` file references it or the capability registry gains a dark or theme
entry. That it's also absent from the build output was checked by hand (§3),
not by a test.

**Recommendation in one line:** use one `.dark` class on `<html>`, applied
before first paint, and **override tokens at the USWDS semantic layer** inside
`@media screen { :root.dark { … } }`. Don't add per-component `dark:`
variants. The app already routes about 1,200 colour references through USWDS
semantic tokens, nearly all of them in a single role. That makes a token
override the smallest change. Two small light-mode refactors have to land
first: split `--theme-primary` and move direct palette references to semantic
roles.

Measured on `main` at `49fcad5`, 2026-10-31.

---

## 1. Theme entry points and the styling systems involved

| Layer                     | Where                                                                                                                                                           | Role in dark mode                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document shell            | `src/routes/__root.tsx` `RootShell` renders `<html lang="en">`, `<head>` and `<body>` on the server, and links `styles.css` from `head()`                       | **The global theme entry point.** The `.dark` class and the pre-paint script belong here. `index.tsx` wraps the app in `<ClientOnly fallback={null}>`, so until the bundle runs the page is an empty body painted with the canvas colour.                                                                     |
| Tailwind v4 + shadcn      | `src/styles.css`: `@custom-variant dark (&:is(.dark *))`, shadcn `:root` and `.dark` token blocks, `body { background: var(--color-background) }`               | Already dark-ready, keyed on `.dark`, but barely used. Only 8 app files use `className`. One shadcn primitive is mounted (`AlertDialog`, in `src/components/Eir/DiscardUnsavedChanges.tsx`). The `body` background and text come from here.                                                                   |
| USWDS token sheet         | `src/design-system/uswds-design-system-3f2f32/design-system/uswds/tokens/*.css`, imported by `src/components/BrokerApp.tsx` **after** `styles.css`, client-only | **What the app actually paints with.** It defines a palette (`--color-{family}-{grade}`), semantic ladders (`--theme-{role}-{lighter…darker}`) and roles (`--surface-*`, `--text-*`, `--border-*`, `--link-*`). Its `:root` beats an earlier `.dark` of equal specificity, so overrides must be `:root.dark`. |
| Inline styles             | 1,668 `style={{…}}`/style objects in 90 files: `src/components/**`, `src/legacy/**`, the vendored USWDS components                                              | They reference tokens through `var(--…)`, so they follow a token override **without being edited**. Literal colours inside them don't.                                                                                                                                                                        |
| Vendored USWDS components | `src/uswds/design-system.js` (bundle loaded by `src/legacy/bootstrap.jsx`) and `src/design-system/…/components/**`                                              | Token-driven, with literal `#fff` on filled buttons. Focus is `--focus-outline` (4px `#face00`).                                                                                                                                                                                                              |
| Legacy prototype          | `src/legacy/*.jsx`. Header and nav (`chrome.jsx`), home, profile, the intake-editor part of `admin.jsx`, and the coming-soon mock screens                       | Same as inline styles. The mock screens (`browse`, `domain`, `dataset`, `bundle(s)`, `search`, `cart`, `requests`, `access`, and the admin operations tabs) are never rendered: `FeatureGate` shows a coming-soon card instead.                                                                               |
| Charts                    | `src/components/ui/chart.tsx` (shadcn `ChartContainer` + recharts, keyed on `.dark`), plus the hand-drawn SVG flowchart and meters in `admin.jsx`               | **No live chart today.** `ChartContainer` has no consumers. The SVG charts sit in the gated admin operations tabs and use hex literals. The spike checks `ChartContainer`, because any future chart would use it.                                                                                             |
| Non-React surfaces        | `src/lib/error-page.ts` (server HTML error page with its own `<style>`), EIR PDF (`src/data/eir/pdf.ts`, raw PDF operators)                                     | The error page needs its own `prefers-color-scheme` rule, since it has no JS. The EIR PDF isn't CSS-driven and is unaffected (also out of scope).                                                                                                                                                             |
| Dead sheet                | `src/uswds/uswds.css`                                                                                                                                           | Nothing imports it (`grep -rn "uswds.css" src` finds nothing outside docs). Ignore it, or delete it in its own PR.                                                                                                                                                                                            |

## 2. Hard-coded colours and token bypasses, by migration strategy

Every count below comes from the scripts in
[`dark-mode-spike/`](dark-mode-spike/), run from the repo root against tracked,
non-test files under `src/`. The prototype is excluded. Each script ends
with a `== headline` section that prints the totals this doc cites:
`inventory-tokens.py` gives the semantic and palette totals, the live, gated,
admin and vendored split, and the primary-fill count. `inventory-literals.py`
gives the inline-style-object and `className` counts. `inventory-roles.py`
gives the single-role versus dual-role tokens.

```bash
python3 -I docs/research/dark-mode-spike/inventory-literals.py .   # colour literals, grouped
python3 -I docs/research/dark-mode-spike/inventory-tokens.py .     # var() refs by token family
python3 -I docs/research/dark-mode-spike/inventory-roles.py .      # which CSS property consumes each token
python3 -I docs/research/dark-mode-spike/inventory-undefined.py .  # var() refs to tokens nothing defines
```

What counts as a literal: hex in string or CSS position, `rgb[a]()`, `hsl[a]()`
and `oklch()`. A bare three-digit `#123` in prose is skipped, because those are
issue references.

### 2a. Token references: what already follows a token override

| Token family (TS/JS)                                            | References | Strategy                                                                 |
| --------------------------------------------------------------- | ---------: | ------------------------------------------------------------------------ |
| USWDS semantic ladders `--theme-*`                              |        694 | **Override in place.** No component edits.                               |
| USWDS roles `--surface-*`, `--text-*`, `--border-*`, `--link-*` |        522 | **Override in place.**                                                   |
| USWDS palette `--color-*` used directly                         |        369 | **Migrate to a semantic role** (DM-2). Stopgap: remap in the dark sheet. |
| shadcn tokens                                                   |          6 | Already have `.dark` values. Align them to the USWDS dark surfaces.      |

The palette references split as follows: 218 in 41 live UI files, 81 in the 9
gated mock screens, 34 in `admin.jsx` (mostly its gated operations tabs) and 36
in the vendored USWDS components. The most-used are `--color-gray-cool-70`
(77), `--color-blue-5v` (60), `--color-gray-cool-2` (30), `--color-white` (24)
and `--color-blue-20v` (21).

**Single role is the key fact.** Of the 72 colour tokens consumed in inline
styles, 69 are only ever a text colour or only ever a fill. That is why a token
override works without touching components. Three tokens are both:

| Token                  | As text colour | As fill | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------: | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--theme-primary`      |             28 |      14 | **Blocking.** On a dark surface, no single blue passes 4.5:1 both as text on the surface and behind the literal white button text. Needs a split: **DM-1**. The fills are 10 live sites (plus 3 in gated mock screens and 1 in the vendored bundle), mostly shared `primaryButton` style constants (`SchemaForm.tsx:172`, `edpWidgets.tsx:98`, `Onboarding/styles.ts:60`, `DatasetAccess/styles.ts:58`, `Eir/EirShared.tsx:61`, `AdminEditor.tsx:149`, `chrome.jsx:119`, `home.jsx:42,81`, `profile.jsx:169`). |
| `--color-gray-cool-80` |              6 |       1 | Minor. Fold into DM-2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--color-gray-cool-30` |              1 |       1 | Minor. Fold into DM-2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 2b. Colour literals

| Group                                                                              | Literals | Strategy                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token definition sheets (USWDS `colors.css` 463, `spacing.css` 7, `styles.css` 64) |      534 | **None.** These are the token values themselves.                                                                                                                                                                                                                                                                          |
| Orphaned `src/uswds/uswds.css`                                                     |      470 | **None.** Not imported.                                                                                                                                                                                                                                                                                                   |
| Live UI: `#fff` text or icons on primary or dark fills                             |       44 | Ride along with **DM-1**: `color: var(--text-on-fill)`. Correct in both themes as long as the fill stays dark.                                                                                                                                                                                                            |
| Live UI: fallbacks inside `var(--token, #hex)`                                     |       17 | **None.** They only apply if the token is missing. Exception: two point at tokens **nothing defines**, so the fallback always wins (below).                                                                                                                                                                               |
| Live UI: other literals                                                            |       40 | Case by case in **DM-2**. Most are in `admin.jsx`'s gated operations tabs (flowchart, meters). Live ones: `home.jsx:26,29` hero gradient (already dark, fine), `chrome.jsx:251` footer rule (on a dark footer, fine), `AdminEditor.tsx:183` code-block text on `--color-gray-cool-90` (fine), `FieldHelp.tsx:119` shadow. |
| Vendored USWDS bundle (`design-system.js` 20, `Button.jsx` 13, `Alert.jsx` 2)      |       35 | All `#fff` on fills. Same as DM-1. Don't hand-edit the generated bundle: override with `--text-on-fill` where it reads a token, and accept its button fills (they stay dark-blue) otherwise.                                                                                                                              |
| Legacy mock screens (gated coming-soon)                                            |       23 | **Defer.** Never rendered. Each one's own go-live ticket must pass the dark contrast suite.                                                                                                                                                                                                                               |
| shadcn `chart.tsx`                                                                 |        5 | **None.** recharts selector strings (`#ccc`, `#fff`), not colours that get painted.                                                                                                                                                                                                                                       |
| Non-UI (`error-page.ts` 5, `store-provider.tsx` 1)                                 |        6 | `error-page.ts` gets a `@media (prefers-color-scheme: dark)` block (DM-3).                                                                                                                                                                                                                                                |

**Tokens nothing defines** (`inventory-undefined.py`, app-relevant only):
`var(--text-strong, #1b1b1b)` at `src/data/store-provider.tsx:54` always
paints `#1b1b1b`, which would be near-black text on a dark surface.
`var(--theme-focus, #2491ff)` at `src/components/EirDefinitions/YamlEditor.tsx:48`
always paints the fallback, which happens to work in both themes. Both go in
DM-2.

Tailwind palette utilities (`bg-red-500` and similar) appear only as `bg-black/80` modal
overlays in 4 shadcn primitives, which is fine in both themes. One trap for later: Tailwind v4's default
palette variables (`--color-red-50`, …) share names with USWDS palette tokens,
and the later USWDS sheet would win. That's harmless while nobody uses Tailwind
palette utilities.

## 3. Prototype

Files, all in `src/prototypes/dark-mode/` and imported only by their own tests:

- `theme.ts` is the preference model: `system | light | dark`, saved under
  `localStorage["edp-vm:theme"]`, resolved against `prefers-color-scheme`,
  applied as `.dark` on `<html>`. It also exports `THEME_INIT_SCRIPT`, the
  inline `<head>` script that applies the saved theme before first paint, and
  follows live device changes while the choice is "system".
- `dark-tokens.css` holds the provisional dark values from the USWDS palette.
  They override USWDS semantic ladders and roles, the stopgap palette remaps,
  and the shadcn tokens, inside `@media screen { :root.dark { … } }`.
- `ThemeChoice.tsx` is the explicit choice: a native radio group (Match my
  device, Light, Dark) plus `useThemePreference`.

Representative surfaces exercised:

| Surface    | Where it was checked                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation | Real app shell: USWDS banner, `TopNav`, breadcrumb, onboarding `StepIndicator`, footer. Checked in the browser test and in the real-app harness on 6 screens. |
| Form       | Onboarding wizard step 1 (text input, radios, select, help buttons)                                                                                           |
| Status     | `FeatureGate` stub notice, development privacy notice, SLA/status pills on Datasets and Access requests                                                       |
| Modal      | `DiscardUnsavedChanges` (Radix `AlertDialog` through the shadcn wrapper)                                                                                      |
| Chart      | shadcn `ChartContainer` with a themed series colour (no live chart exists, see §1)                                                                            |
| Choice     | `ThemeChoice` radio group                                                                                                                                     |

### Evidence

**Automated seam.** `src/prototypes/dark-mode/dark-mode.browser.test.tsx` runs
in headless Chrome as part of `npm test`. It renders the real legacy App on the
memory store, as `AdminEditor.browser.test.tsx` does, plus the components above.
It computes WCAG 2.1 contrast for every visible HTML text run from Chrome's
painted colours, so it composites alpha and skips gradients like axe does.
`theme.test.ts` (jsdom) covers the preference model, the parity between the
pre-paint script and `resolveTheme`, the pre-paint script with storage that
throws, and the isolation guard. The guard fails if any `src/` file outside the
folder mentions `prototypes/dark-mode`, or if the capability registry has a
dark or theme entry. Absence from the build output isn't tested, because
`npm test` runs before any build. It was checked by hand after
`npm run build:databricks`:
`grep -rl "edp-vm:theme\|prototypes/dark-mode" .output` finds nothing.

**Real-app harness.** [`dark-mode-spike/real-app-harness.mjs`](dark-mode-spike/real-app-harness.mjs)
isn't part of `npm test`. It drives `vite dev` (memory backend) in headless
Chrome at 1280×900 and injects the init script and the token sheet into the
served `<head>`, the way the real implementation would ship them. It writes
only inside the repo, to the gitignored `docs/research/dark-mode-spike/out/`,
and refuses an `OUT` that resolves outside the repo, symlinks included. It then runs
axe-core WCAG 2.1 A/AA on Home, Onboard new data, My EIR, Datasets, Access
requests and My onboarding requests in six modes.

| Mode                                     | axe violations (6 screens)                                  |
| ---------------------------------------- | ----------------------------------------------------------- |
| Today's app, light device                | 0                                                           |
| Today's app, dark device                 | 0. Renders light: the app ignores the device setting today. |
| Prototype, light device                  | 0                                                           |
| Prototype, explicit Light on dark device | 0                                                           |
| Prototype, dark device ("system")        | 10 nodes, **all** `#ffffff` on `#58b4ff` (primary fills)    |
| Prototype, explicit Dark on light device | Same 10 nodes                                               |

The first harness run also flagged `#775540` on `#352313`, the "Data provider"
pill, because the accent-warm ladder wasn't remapped yet. The current sheet
remaps it. That is the kind of gap the contrast suite catches.

Screenshots, with the prototype on a dark device:

- Home: [`proto-system-dark--home.png`](dark-mode-spike/proto-system-dark--home.png)
- Onboarding form: [`proto-system-dark--onboarding.png`](dark-mode-spike/proto-system-dark--onboarding.png)
- Datasets: [`proto-system-dark--datasets.png`](dark-mode-spike/proto-system-dark--datasets.png)
- Keyboard focus in the header: [`proto-system-dark--focus.png`](dark-mode-spike/proto-system-dark--focus.png)
- The same onboarding screen in today's app on a dark device, for comparison: [`baseline-systemdark--onboarding.png`](dark-mode-spike/baseline-systemdark--onboarding.png)

The light-blue "LD" avatar and primary buttons in those screenshots are the
open DM-1 gap.

## 4. Checks

| Check                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrast (WCAG 2.1 AA, 1.4.3) | Passes everywhere checked. DM-1 split primary text and fill roles and deleted the browser test's white-on-primary carve-out; the suite now requires zero contrast failures. The generated vendored USWDS bundle remains the documented exception and keeps its existing dark-blue button fills. The chart series reaches ≥ 3:1 against the surface in both themes (1.4.11).                                                                                                                                                                                                                                                                                                                         |
| Focus visibility (2.4.7)      | The browser test tabs through 14 stops in the dark shell. For each stop it reads the indicator Chrome paints (an outline, or a box-shadow ring) and asserts a width above 0, an opaque colour, and at least 3:1 against the parent's backdrop. All 14 pass, at 9.78:1 to 12.74:1. The USWDS banner button paints `4px solid #face00` (9.78:1). Native controls get Chrome's `auto` ring, measured by its computed colour `rgb(238,238,238)`, which `color-scheme: dark` makes light. Chrome paints that ring two-tone, so this is the conservative half. Weak spot: the ring's inner edge against the light-blue avatar fill is about 1.9:1 (computed, not tested). DM-1 fixes it with the fill.    |
| Persistence                   | An explicit choice survives reload, and it beats the device setting in both directions. Clearing it returns to the device setting. A live device change is followed only while the choice is "system". Unreadable or blocked storage falls back to the device setting without throwing, both in `readPreference` and in the pre-paint script, which reads storage in its own `try`. A test runs the script with a `getItem` that throws.                                                                                                                                                                                                                                                            |
| Initial-render flash          | Today a dark-device user gets a white first frame (`oklch(1 0 0)`), then a light app. With the inline `<head>` script, the first frame already has `.dark`. The body is still transparent then (empty under `ClientOnly`), so what shows is the canvas, which `color-scheme: dark` makes dark. That last step is per the CSS spec, read off the screenshots, not measured as a pixel. The script must be inline in `RootShell`, not a module: module scripts run after first paint. `<html>` then needs `suppressHydrationWarning`, because the class is set before React hydrates. There's no CSP today, so an inline script is allowed. If a CSP lands, it needs a hash or nonce for this script. |
| Print / Save as PDF           | Chrome drops backgrounds when printing, so dark tokens would print light-on-white. `@media screen` scoping fixes that for the USWDS layer: printing resolves `--text-default` to `#1b1b1b`. **Finding:** the existing shadcn `.dark` block in `styles.css` isn't screen-scoped, and it sets the body colours. The prototype resets them under `@media print`. The real change (DM-3) moves that block under `@media screen` instead. The generated EIR PDF (`src/data/eir/pdf.ts`) is raw PDF operators, unaffected.                                                                                                                                                                                |
| USWDS ↔ shadcn interaction    | Three findings. (1) Load order: the USWDS sheet loads after `styles.css` and its `:root` wins over `.dark`. Use `:root.dark`. The browser test loads the sheets in the unfavourable order to prove specificity wins. (2) Two token sets paint one page: `body` uses shadcn `--background`, while surfaces use USWDS `--surface-*`. Dark values must be chosen together, or the page edge and the cards drift (the darker band above the footer in the screenshots is likely this). (3) shadcn's `dark:` variant and `ChartContainer` both key on `.dark`, so one class serves both systems.                                                                                                         |

Not checked: forced-colors or Windows High Contrast mode, 200% and 400% zoom
in dark (light layout is unaffected because tokens don't change layout),
Firefox and Safari, and the live Delta-backed screens behind EDP Admin. Those go
in DM-3's checklist.

## 5. Recommendation: semantic-token override behind a `.dark` class

| Option                                                               | Verdict                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `.dark` on `<html>` + USWDS semantic-token overrides (chosen)** | One sheet of 99 declarations (`grep -c '^ *--' src/prototypes/dark-mode/dark-tokens.css`), recolours ~1,200 references with no component edits. Shares the switch with shadcn and charts. In the spike, every surface passed except one gap that needs a split token. Print and flash both handled. |
| B. Per-component Tailwind `dark:` variants                           | The app is styled through 1,668 inline style objects, not classes. Only 8 files use `className`. This would mean rewriting most UI into Tailwind first. Not small.                                                                                                                                  |
| C. `@media (prefers-color-scheme: dark)` only, no class              | Smallest CSS, but there's no explicit choice, and it can't follow a saved preference. The ticket requires both.                                                                                                                                                                                     |
| D. Override the palette ramps (invert `--color-*`)                   | Tempting for the 369 direct palette references, but palette names would stop meaning their colour (`--color-white` paints dark grey). It breaks any intentionally fixed colour, such as the brand chip and the dark footer. Use it only as the documented stopgap in DM-3, deleted by DM-2.         |

## 6. Follow-up tickets (drafts, not filed)

Estimates are agent-days at this repo's DoD: tests, gates, review, preview,
UAT. Each ticket is its own PR off `main` and is demoable at its own head. DM-1
and DM-2 are **light-mode refactors with no visible change**, so their demo is
evidence that light mode is unchanged plus a number that moved. Start DM-2
only after DM-1 merges: it's a separate slice, but it touches the same style
modules.

### DM-1: Split `--theme-primary` into a text role and a fill role

- **Goal:** filled primary controls take `--theme-primary-fill` and
  `--text-on-fill`. `--theme-primary` keeps the text and border roles. Light
  mode looks the same.
- **Scope:** the 10 live primary-fill sites (`inventory-tokens.py` headline,
  listed in §2a), and the 44 live `#fff` literals on fills. Vendored bundle:
  leave it, record the exception.
- **Demo at its own head:**
  1. A browser test renders the six live screens and asserts that every
     primary control's computed fill and text colour equal today's
     (`#005ea2` behind `#ffffff`). That is "light is identical" as a
     computed-style check, and the PR adds harness screenshots of `main` and
     the branch side by side.
  2. A token-pair contrast test checks the new roles: `--text-on-fill` on
     `--theme-primary-fill`, and `--theme-primary` on `--surface-default`,
     each at least 4.5:1. It runs on the light values, and on the spike's
     provisional dark values passed in as test data. No dark sheet ships.
  3. `inventory-tokens.py` reports 0 `background: var(--theme-primary)`
     fills in live UI (10 today). A repo test enforces it.
- **Seam:** the rendered screens' computed styles, and the token pairs.
- **Estimate:** 1 day. **Blockers:** none.

### DM-2: Move direct palette references in live UI to semantic roles

- **Goal:** live UI references only semantic tokens. This removes the 218
  palette references in 41 live files, the two undefined tokens
  (`--text-strong`, `--theme-focus`), and the dual roles of `--color-gray-cool-80`
  and `--color-gray-cool-30`. New semantic roles (for example
  `--surface-info-tint` for `--color-blue-5v`) go in the USWDS theme layer,
  not ad hoc.
- **Demo at its own head:**
  1. The `inventory-tokens.py` headline drops from 218 to 0 palette references
     in live UI, enforced by a repo test. The gated mock screens and the
     vendored bundle are exempt.
  2. `inventory-undefined.py` lists no app-relevant undefined token.
  3. Light is unchanged: a browser test asserts computed colours on the six
     screens match a snapshot taken from `main`, and the PR adds harness
     screenshots of `main` and the branch side by side.
- **Seam:** the inventory scripts, as repo tests, and the rendered screens'
  computed styles.
- **Estimate:** 1.5 days. **Blockers:** DM-1 merged (same style modules). It
  starts off `main` after that merge; it isn't stacked.

### DM-3: Dark theme behind a flag: tokens, pre-paint, device preference

- **Goal:** with the flag on, a dark-device user gets an accessible dark app
  from the first frame. With it off (the default), nothing changes.
- **Scope:**
  - The dark sheet, in `styles.css` or the USWDS theme layer, under
    `@media screen`, keyed on `:root.dark`.
  - Move the existing shadcn `.dark` block under `@media screen`.
  - The inline init script in `RootShell`, with `suppressHydrationWarning`.
  - Align `--background` with `--surface-*`.
  - A dark block for `error-page.ts`.
  - Register `dark-mode` in `src/features/registry.ts` as `stub` until DM-4.
  - Promote this spike's browser contrast and focus suite to cover every live
    route in light and dark.
  - Delete `src/prototypes/dark-mode/`.
- **Acceptance:**
  - The contrast suite passes in both themes, with the DM-1 carve-out gone.
  - The first frame is dark on a dark device.
  - Print resolves to light.
  - axe WCAG 2.1 AA is clean on the preview in both themes.
  - 200% and 400% zoom are checked, and forced-colors is checked.
- **Estimate:** 2 days. **Blockers:** DM-1 and DM-2 merged. A **human decision
  on the dark palette values**, from the design/508 owner (this spike's values
  are provisional), and on the flag mechanism (build-time env or a per-user
  setting).

### DM-4: Explicit theme choice and turn it on

- **Goal:** a person can pick Match my device, Light or Dark. The choice is
  remembered in this browser. Dark mode is live.
- **Scope:** the `ThemeChoice` control, which is native radios, so it's
  keyboard-operable for free. Put it on the Profile page (or the header
  account menu). Flip the registry entry to `live`, and state in its notes that
  the choice is per-browser, not per-account.
- **Acceptance:** the persistence matrix from §4 is pinned in tests. UAT on a
  preview.
- **Estimate:** 1 day. **Blockers:** DM-3 merged. A **human decision** on where
  the control lives, and whether per-browser storage is enough or it needs a
  saved profile setting (that would need a backend column, so it's a separate
  ticket).

### Not ticketed

The gated mock screens and the admin operations charts stay light-only until
each goes live. Its go-live ticket adds itself to the DM-3 suite.

**Total:** about 5.5 agent-days across four PRs.

## 7. Uncertainties

- Contrast numbers come from Chrome's computed colours, and the harness uses
  the memory backend. Delta-only states (for example the EIR after
  acknowledgement, and EDP Admin inboxes) weren't rendered. The EIR privacy
  notice can't be acknowledged on the memory backend, so the modal was checked
  as a component, not in place.
- The dark palette values are provisional choices from the USWDS palette, not
  a reviewed design.
- The vendored USWDS bundle is generated. Whether it can be regenerated with
  `--text-on-fill` is unknown.
- Text over gradients and images (the home hero) can't be measured with one
  ratio. It was checked by eye in the screenshots.
