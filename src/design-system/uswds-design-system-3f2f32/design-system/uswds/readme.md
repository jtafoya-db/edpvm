# U.S. Web Design System (USWDS) — Design System

A faithful, file-based recreation of the **U.S. Web Design System (USWDS)** — the
shared design system for U.S. federal government websites. It packages the
authentic USWDS design tokens (color, typography, spacing), the four official
typefaces, real icon assets, reusable React UI components, and full-screen UI
kit recreations so design agents can produce on-brand government interfaces.

> USWDS is an open-source product of the U.S. General Services Administration
> (GSA), maintained by the Technology Transformation Services. Its guiding
> principle: **"Design for the American public."** Everything here is built to
> meet Section 508 / WCAG 2.1 AA accessibility and the 21st Century IDEA act.

---

## What USWDS is

USWDS gives federal teams a tested, accessible, mobile-first foundation so that
government services *look* and *behave* consistently across hundreds of agencies
and thousands of sites — from benefits applications to public-health alerts to
informational portals. It is not a single product but a **system**: design
tokens, components, page templates, and guidance that any `.gov` team composes
into their own site.

**Surfaces represented in this kit**
- **Government informational websites** — agency homepages, landing pages, and
  content pages (hero, card collections, summary boxes, process lists).
- **Government web applications & forms** — multi-step forms, input validation,
  benefit/eligibility flows (text inputs, selects, checkboxes, alerts, step
  indicators, date pickers).
- **Cross-site federal chrome** — the official `.gov` banner, agency headers,
  identifier, and footers that appear on every compliant site.

---

## Sources (for the reader to explore further)

This system was reconstructed from the following inputs. You may not have access
to all of them, but they are recorded here so you can dig deeper:

- **GitHub — `uswds/uswds`**: https://github.com/uswds/uswds
  The canonical source of truth. Color/spacing/typography tokens were lifted
  directly from `packages/uswds-core/src/styles/` (`settings/` + `tokens/`).
  Icons from `packages/usa-icon/`. **Explore this repo to build higher-fidelity
  USWDS designs** — every component lives under `packages/usa-*`.
- **Official documentation**: https://designsystem.digital.gov
- **Figma**: `uswds-design-kit-beta.fig` (the official USWDS Figma component
  library — tokens, all components, and templates).
- **Uploaded typefaces**: Public Sans, Merriweather, Roboto Mono, Source Sans Pro
  (the four official USWDS fonts; extracted into `assets/fonts/`).
- **Uploaded references**: `uswds-colors.sketch`, `uswds-components.xd`.

---

## CONTENT FUNDAMENTALS — how USWDS writes

USWDS content follows the **Federal Plain Language Guidelines** (plainlanguage.gov).
The voice is **plain, direct, civic, and reassuring** — never clever, never
salesy. The reader is a member of the public trying to accomplish a task
(often under stress), so clarity beats personality every time.

- **Person & address:** Speak directly to the user as **"you"**; the agency is
  **"we"** or named directly ("the Social Security Administration"). Example:
  *"You can apply online. We'll review your application within 30 days."*
- **Voice:** Active voice, present tense, short sentences. *"Submit your form
  by June 30"* — not *"Forms must be submitted no later than…"*.
- **Casing:** **Sentence case** everywhere — headings, buttons, nav, labels.
  ("Get started", "Manage your account") — never Title Case or ALL CAPS for
  UI copy. Small all-caps overlines exist as a typographic device only.
- **Buttons & actions:** Verb-first and specific. "Start application",
  "Download form (PDF, 2 MB)", "Find a location" — not "Click here" / "Submit".
- **Tone:** Calm, factual, helpful. In alerts: state what happened, then what to
  do. Error messages are specific and blame-free: *"Enter a date in
  MM/DD/YYYY format,"* not *"Invalid input."*
- **Numbers, dates, units:** Numerals for clarity (write "5", not "five"); spell
  out file size/type next to download links; dates as "January 5, 2026".
- **Reading level:** Aim for ~8th-grade reading level. Define acronyms on first
  use. Avoid jargon, legalese, and bureaucratic nominalizations.
- **Emoji:** **Never.** Government interfaces do not use emoji. Iconography is
  the functional, literal Material/USWDS icon set only.
- **Inclusivity:** Language is accessible and neutral; content is written to be
  understood by people of all abilities, reading levels, and backgrounds.

**Microcopy examples (from the system's spirit):**
- Banner: *"An official website of the United States government"* →
  *"Here's how you know"*
- Identifier: *"An official website of the [Agency]"*
- Empty/required hint: *"Required"* shown in `--theme-secondary` next to label.
- Success alert: *"You've successfully signed in."*

---

## VISUAL FOUNDATIONS

The USWDS look is **sober, sturdy, and trustworthy** — high-contrast, generous
whitespace, flat surfaces, and a restrained federal palette anchored by
deep blue. It deliberately reads as *official* and *neutral*, not branded or
trendy. The aesthetic prioritizes legibility and accessibility over decoration.

### Color
- **Primary** is USWDS blue — `--theme-primary` `#005ea2` (blue-60v), the default
  link and action color. Darker `#1a4480` / `#162e51` for hovers and dark
  surfaces.
- **Base** neutrals are the **cool gray** family (`gray-cool`): text ink
  `#1b1b1b`, body `#71767a`, hairlines `#dfe1e2`, page tints `#f0f0f0`.
- **Secondary** is red `#d83933` (used sparingly — required markers, emphasis).
- **State colors** are semantic and consistent: success green-cool `#00a91c`,
  warning gold `#ffbe2e`, error red-warm `#d54309`, info cyan `#00bde3`.
  Alerts pair a vivid left border with a pale tint background.
- The full system palette is a **grade scale** (5–90, lighter→darker) across ~24
  hue families, each with a standard and a **"vivid" (`v`)** variant. Tokens are
  named `--color-{family}-{grade}` / `--color-{family}-{grade}v`. **Use the
  `--theme-*` semantic aliases in product UI, not raw palette grades.**
- Color is never the *only* signal — state is always reinforced with an icon
  and/or text (accessibility requirement).

### Typography
- **Headings / display:** **Merriweather** (serif) — gives the system its
  authoritative, editorial, "public-record" feel. Tight heading line-height (1.15).
- **Body / UI:** **Public Sans** (open-source grotesque sans designed for
  government). Highly legible at small sizes; body is 16px / 1.62 line-height.
- **Code / data:** **Roboto Mono.** **Alternate sans:** **Source Sans Pro**
  (the historical USWDS sans, still available).
- Type scale is a fixed token set (10 → 140px). Default heading sizes: display
  48, h1 40, h2 32, h3 22. Weights are intentionally limited: 300 / 400 / 700,
  plus 800 (Public Sans ExtraBold) reserved for very large display.
- Measure (line length) is capped (~68ex for body prose) for readability.

### Spacing & layout
- **8px base unit.** The spacing scale is `0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7,
  8, 9, 10, 15` units (4px → 120px), exposed as `--space-*` tokens, plus literal
  `1px`/`2px`.
- **12-column grid**, max content width `desktop` = 1024px, site margins of 2
  units (mobile) / 4 units (desktop). Mobile-first responsive breakpoints:
  mobile-lg 480, tablet 640, tablet-lg 880, desktop 1024, desktop-lg 1200,
  widescreen 1400.
- Layouts are **left-aligned, document-like**, with clear sectioning. Generous
  vertical rhythm; content sits on white.

### Surfaces, borders, radius, shadow
- **Cards** are flat: white background, a 1px `--border-default` hairline, small
  `--radius-lg` (8px) corners — *or* a subtle `--shadow-2`. Not both heavy.
  No colored left-border-accent cards; no gradient cards.
- **Radius** is small and functional: 2 / 4 / 8px. Pills only for tags/badges.
- **Shadows** are a soft 5-step elevation scale (1–5), low-opacity black, used
  sparingly (modals, dropdowns, raised cards). Most UI is borders, not shadows.
- **Borders** carry most of the structure: 1px hairlines for dividers, 2px for
  inputs, 4px for the left rule on alerts and the active nav indicator.

### Backgrounds & imagery
- Predominantly **flat white / pale gray** (`#f0f0f0`, `gray-cool-2`). Dark
  sections use `--surface-dark` (`#162e51`).
- **No gradients, no textures, no decorative noise.** Hero units may use a full
  photograph (warm, candid, real people / civic settings) with a solid color
  block or a subtle dark scrim for text legibility — never a purple gradient.
- Imagery is **documentary and inclusive**: real Americans, public spaces,
  natural color (neither heavily filtered nor black-and-white).

### Motion, hover & press
- Motion is **minimal and functional** — short (~150–250ms) ease transitions on
  color/background for hover; accordion expand/collapse; modal fade. No bounces,
  no parallax, no decorative looping animation. Respects
  `prefers-reduced-motion`.
- **Hover:** buttons darken to the next-darker theme grade (primary →
  primary-dark); links darken and underline. **Press/active:** darken again
  (primary-darker). No scale/shrink transforms.
- **Focus (critical):** a **4px solid gold (`#face00`) outline** on every
  interactive element — the single most recognizable USWDS accessibility signal.
  Never removed.
- Transparency/blur is essentially unused; surfaces are opaque.

---

## ICONOGRAPHY

- **Primary icon set:** USWDS's icon system is the **Material Icons (filled)**
  library, which the upstream project compiles into a single **SVG sprite**
  (`usa-icon`) rendered inline as `<svg class="usa-icon"><use href="…/sprite.svg#name"></use></svg>`
  and sized in `em`/spacing units so icons scale with text. Icons are
  **functional and literal** — navigation, status, actions — never decorative.
- **In this kit**, the icon set ships as a **local, dependency-free `Icon`
  React component** (`components/core/Icon.jsx`) holding the inline SVG geometry
  for the glyphs used across the system (`<Icon name="search" />`). No webfont,
  no CDN — so it renders instantly (no FOUT) and survives PDF/PPTX/offline
  export. Button and Alert use it internally.
- Icons are monochrome and inherit `currentColor`; status icons take the
  matching `--theme-*` state color (e.g. error icon in error-dark red).
- **USWDS-custom icons** (not in Material): weather/emergency glyphs, social
  logos, and a few utilities — these are copied into `assets/icons/uswds/`
  (`hurricane`, `flooding`, `snow`, `tornado`, `severe_weather`, `rain`,
  `identification`, `sort_arrow`, `navigate_far_*`, `chevron_*`, plus social:
  `facebook`, `x`/`twitter`, `instagram`, `youtube`, `linkedin`, `github`,
  `flickr`).
- **Emoji / unicode as icons:** never used.
- **⚠️ Coverage note:** the `Icon` component covers the ~26 glyphs this system
  actually uses, not the full USWDS catalog (~250 icons). To add more, drop the
  glyph's 24×24 path into the registry in `components/core/Icon.jsx`, or pull the
  complete set from `@uswds/uswds/dist/img/sprite.svg`. Paths use standard
  Material Icons geometry — visually identical to the USWDS sprite.

---

## INDEX / manifest

**Foundations (root)**
- `styles.css` — global entry point (import this). `@import`s the token layers.
- `tokens/colors.css` — full system palette + `--theme-*` semantic aliases.
- `tokens/typography.css` — families, type scale, line-heights, weights.
- `tokens/spacing.css` — spacing units, radius, borders, breakpoints, shadow, focus.
- `tokens/fonts.css` — `@font-face` for the four official typefaces.
- `assets/fonts/` — Public Sans, Merriweather, Roboto Mono, Source Sans Pro.
- `assets/icons/uswds/` — USWDS-custom SVG icons.
- `guidelines/` — foundation specimen cards (Design System tab).

**Components** (`components/<group>/` — each has `<Name>.jsx`, `.d.ts`, `.prompt.md`)
- `core/` — **Button** (primary/secondary/base/accent/outline/unstyled, big, icon, disabled), **Tag**
- `feedback/` — **Alert** (info/success/warning/error/emergency, slim)
- `forms/` — **TextInput**, **Select**, **Checkbox**, **Radio** (label/hint/error contract)
- `layout/` — **Card**, **Accordion**, **SummaryBox**
- `navigation/` — **Breadcrumb**, **Pagination**, **StepIndicator**
- `gov/` — **Banner** (official .gov site-identification banner, assets inlined)

  Consume from the compiled bundle: `const { Button, Alert, … } = window.<Namespace>`
  (run `check_design_system` for the exact namespace). Reference `_ds_bundle.js`
  by its relative path to the project root; do not `<script src>` the `.jsx`.

**UI kits** (`ui_kits/<product>/`)
- `federal-site/` — **Benefits.gov**, an interactive federal benefits portal:
  homepage, filtered benefits listing, and a multi-step eligibility screener.
  Open `ui_kits/federal-site/index.html`.

> See the Design System tab for live specimen cards of every foundation and
> component. `SKILL.md` makes this folder usable as a downloadable Claude skill.

### ⚠️ Substitutions to confirm
- **Icons:** provided as a local, dependency-free inline-SVG `Icon` component
  (`components/core/Icon.jsx`) using standard Material/USWDS geometry — no CDN,
  no FOUT, export-safe. It covers the ~26 glyphs used here; USWDS-unique SVGs
  (weather, social) are in `assets/icons/uswds/`. Pull
  `@uswds/uswds/dist/img/sprite.svg` for the full ~250-icon catalog.
- **Primary sans = Public Sans.** USWDS's SCSS *default* token is Source Sans
  Pro, but the official site and this Figma kit use Public Sans; both fonts ship
  here (Source Sans Pro is the `--font-alt-sans`).
