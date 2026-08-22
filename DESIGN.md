# DESIGN.md

The visual design system for this app, in the portable [DESIGN.md](https://designmd.app/)
format that Claude Code, Codex, Cursor, and friends read directly.

**This file is the source of truth.** `app/assets/css/main.css` and `app/app.config.ts` are
*compiled from it* — run `/design-sync` after editing this file, never hand-edit the two
generated files and expect them to survive. `bun run design:check` enforces that app code uses
only the tokens declared here.

The brand mark works the same way one level out: `/logo-sync` writes
`app/components/Brand/Logo.vue` from the Brand mark section below, `bun run brand:generate`
derives the favicon, app icon, and share image from that component, and `bun run brand:check`
fails the build when they fall out of sync.

> **Scope note:** this file means *visual* design — color, type, space, motion, component
> behavior. Architectural rationale and stack decisions live in `CLAUDE.md`, not here.

> **Forking?** Replace everything below the Identity heading. The system described here is
> "Quarry", the template's placeholder identity — it exists to prove the pipeline works, not
> because your app should look like this. Drop in any DESIGN.md from
> [designmd.app](https://designmd.app/) or
> [awesome-claude-design](https://github.com/VoltAgent/awesome-claude-design), then run
> `/design-sync`.

---

## Identity

- **Personality:** quarried, editorial, unhurried
- **References:** Linear's density with Stripe Press's typography; printed field guides
- **Audience:** people who read carefully and return daily
- **Density:** comfortable — generous vertical rhythm, restrained horizontal padding
- **Motion:** minimal. Motion confirms, it never decorates.
- **Iconography:** Lucide (`i-lucide-*`), bundled locally via `@iconify-json/lucide`. Line
  icons at default weight — never emoji, never a second icon family.
- **Color mode:** dual. Light is the primary design target; dark is a first-class equal.

### Never

- Gradients as decoration, glassmorphism, or drop shadows used for style rather than elevation
- More than one accent color visible in a single viewport
- Faux-bold headings (the display face ships at weight 400 only — never `font-bold` on it)
- Pure black (`#000`) or pure white (`#fff`) as a surface color
- Emoji as UI iconography

---

## Brand mark

Two quarried strata, offset — the lower one shorter and lighter, cut from the same face.
Abstract rather than a letterform on purpose: `bun run rename` cannot rewrite a picture, so
an initial would still spell the template's name long after the app stopped being called that.

**The mark lives in `app/components/Brand/Logo.vue`, and nowhere else.** Every standalone
file is derived from that component by `bun run brand:generate`:

| Generated file | Size | What it is |
|---|---|---|
| `public/favicon.svg` | 32 grid | The browser tab. Carries its own ground — a transparent mark vanishes against a dark tab strip. |
| `public/apple-touch-icon.png` | 180×180 | iOS home screen. Full-bleed: iOS applies its own corner mask, so baking one in double-rounds it. |
| `public/icon-192.png` | 192×192 | Android/desktop "Add to Home Screen", via `manifest.webmanifest`. Maskable-safe: the mark's bounding square covers 56% of the icon — bounding a *square* inside Android's 80%-diameter safe-zone *circle* takes a smaller number than the circle itself, not the same one (`MASKABLE_COVERAGE` in `scripts/generate-brand-assets.ts`). |
| `public/icon-512.png` | 512×512 | Same treatment, larger — the splash-screen source in `manifest.webmanifest`. |
| `public/og.png` | 1200×630 | Every link preview of this site — mark, app name, one sentence. |
| `shared/utils/brand-colors.generated.ts` | — | `theme_color`/`background_color` for `manifest.webmanifest`, resolved from the Color roles table below — a manifest has no color mode either. |

`bun run brand:check` (part of `bun run ci`) fails the build when those files no longer match
the component. A favicon a redesign behind the app is the normal outcome otherwise; nothing
about it ever throws.

### Construction

- **Grid:** 32×32 viewBox, geometry on whole and half units only.
- **Optical box:** the glyph spans 3→29 across and 7→25 down, so it is centred with room to
  breathe once an icon square is drawn around it.
- **Corners:** `rx 1.5` — slab corners that echo `--ui-radius`. Never a pill.
- **Fill:** `currentColor`, one flat fill plus a single opacity step. No stroke, no gradient,
  no second hue.
- **Minimum size:** 16px. A mark that stops reading at favicon size is a different mark.
- **Clear space:** half the mark's height on every side. In the lockup that is the `gap-2`
  between glyph and wordmark.

### Color roles

A PNG has no color mode, so each role below resolves to a concrete ramp token rather than a
`--ui-*` alias — the aliases flip between light and dark, and a file has to pick one.

| Role | Token | Where it lands |
|---|---|---|
| `icon-ink` | `--color-clay-50` | The glyph inside the app icon |
| `icon-ground` | `--color-clay-600` | The square behind it |
| `og-mark` | `--color-clay-600` | The mark on the share image |
| `og-ground` | `--color-stone-50` | Share image background |
| `og-ink` | `--color-stone-900` | Share image title |
| `og-muted` | `--color-stone-500` | Share image description and footer |
| `manifest-theme` | `--color-clay-600` | `theme_color` in `manifest.webmanifest` — the browser UI tint once installed |
| `manifest-ground` | `--color-stone-50` | `background_color` in `manifest.webmanifest` — the splash screen before the app paints |

In-app the mark takes `text-primary` and inherits the color mode for free. These eight exist
only for the files that can't.

### Never

- A second mark. If a surface seems to need a different logo, the logo is wrong.
- Effects: shadow, gradient, outline, rotation, or animation on the mark.
- The wordmark in anything but the display face at weight 400 (DESIGN.md › Typography).
- Hand-editing anything in `public/` — or `shared/utils/brand-colors.generated.ts` — that
  this pipeline generates.

---

## Color

### Primary ramp — `clay`

A warm earth red. Confident at 600, quiet at 100.

| Shade | Hex | Shade | Hex |
|---|---|---|---|
| 50 | `#fdf5f3` | 500 | `#db6a4b` |
| 100 | `#fbe8e3` | 600 | `#c74f2f` |
| 200 | `#f8d5cb` | 700 | `#a63e24` |
| 300 | `#f2b8a7` | 800 | `#883622` |
| 400 | `#e88f75` | 900 | `#713122` |
| | | 950 | `#3d160d` |

### Semantic assignments

| Role | Color | Use |
|---|---|---|
| `primary` | `clay` | CTAs, active nav, focus rings, links |
| `secondary` | `stone` | Secondary actions — deliberately not a second hue |
| `neutral` | `stone` | Text, borders, surfaces |
| `success` | `emerald` | Confirmations |
| `info` | `sky` | Neutral notices |
| `warning` | `amber` | Reversible risk |
| `error` | `rose` | Failure, destructive actions |

Semantic colors resolve one to three steps darker than NuxtUI's 500 default in light mode,
and to **400** in dark. This is not taste — NuxtUI's defaults fail WCAG AA in light mode in
both directions that matter, as text on their own 10% tint (`subtle` alerts and badges) and
as white text on the solid fill (`solid` buttons):

| Role | Light shade | Text on tint | White on solid |
|---|---|---|---|
| `primary` | 600 | 4.04 ✗ | 4.58 ✓ |
| `secondary` | 600 | 6.48 ✓ | 7.64 ✓ |
| `success` | 700 | 4.66 ✓ | 5.36 ✓ |
| `info` | 700 | 5.08 ✓ | 5.86 ✓ |
| `warning` | 800 | 6.06 ✓ | 7.09 ✓ |
| `error` | 700 | 5.19 ✓ | 6.03 ✓ |

`primary` stays at 600 because it is the brand accent rather than a status color, and 600
clears AA for its real uses. It is the one exception in the table: **never pair
`color="primary"` with `variant="subtle"`** — clay-600 on a clay tint is 4.04:1. Use `solid`.

Warning needs 800 specifically; amber-700 reaches only 4.39:1 on its tint.

### Surface and text rules

Use the semantic utility, never a numbered scale. `text-gray-900` is a build failure.

| Intent | Token |
|---|---|
| Page background | `bg-default` |
| Sectioned / subtle background | `bg-muted` |
| Cards, modals, popovers | `bg-elevated` |
| Hover state on a surface | `bg-accented` |
| Body copy | `text-default` |
| Headings | `text-highlighted` |
| Secondary / captions | `text-muted` |
| Placeholders, disabled | `text-dimmed` |
| Default border | `border-default` |
| Emphasized border | `border-accented` |

---

## Typography

### Families

| Token | Family | Use |
|---|---|---|
| `font-display` | Instrument Serif, 400 only | `h1`–`h3`, pull quotes, numerals in stat tiles |
| `font-sans` | Inter | Body, UI, labels, everything else |
| `font-mono` | JetBrains Mono | Code, IDs, keyboard keys, tabular data |

Headings are set in the display serif at weight 400 with `-0.02em` tracking. The size does the
work, not the weight.

### Scale

| Token | Size | Line height |
|---|---|---|
| `text-xs` | 0.75rem | 1.4 |
| `text-sm` | 0.875rem | 1.5 |
| `text-base` | 1rem | 1.65 |
| `text-lg` | 1.125rem | 1.6 |
| `text-xl` | 1.375rem | 1.4 |
| `text-2xl` | 1.75rem | 1.3 |
| `text-3xl` | 2.25rem | 1.2 |
| `text-4xl` | 3rem | 1.1 |
| `text-5xl` | 3.75rem | 1.05 |

Body copy runs at `text-base` with a 1.65 line height — looser than Tailwind's default,
because this system is for reading. Never set arbitrary sizes (`text-[13px]`).

---

## Space, shape, elevation

- **Spacing:** standard Tailwind scale only — 1, 2, 3, 4, 6, 8, 12, 16, 24. No invented values.
- **Container:** `72rem` max width (`--ui-container`), narrower than the 80rem default. Use
  `<UContainer>` for page shells — it reads this variable; a hardcoded `max-w-*` will not.
- **Radius:** `0.25rem` base (`--ui-radius`). Tight. Nothing is a pill except avatars and badges.
- **Borders:** 1px, `border-default`. Structure comes from borders and spacing, not shadows.
- **Elevation:** dark mode elevates with lighter surfaces (`bg-elevated`), never shadows.
  Light mode may use at most `shadow-sm` on genuinely floating elements (popover, dropdown).

---

## Motion

- Duration `150ms` for state changes, `200ms` for entrances. Nothing slower.
- Easing: `ease-out` entering, `ease-in` leaving.
- Respect `prefers-reduced-motion` — all non-essential motion drops to zero duration.
- No entrance animation on page content. Skeletons over spinners for loads above 300ms.

---

## Component behavior

- **Buttons:** NuxtUI defaults already carry `font-medium` and derive radius from `--ui-radius`
  — no override needed. Primary = solid clay, secondary = outline neutral, destructive = solid
  error. One primary button per view.
- **Cards:** NuxtUI `subtle` variant — elevated surface, hairline ring, no shadow. Padding
  stays on the component default (`p-4`, `p-6` from `sm`), which is already mobile-first.
- **Inputs:** 1px border, `bg-default`. Focus shows a 2px primary ring, never a glow.
- **Focus:** every interactive element has a visible focus-visible ring. Never `outline: none`
  without a replacement.
- **Navigation:** inline links from `sm` up; below that they collapse into a right-side
  `USlideover` behind an `i-lucide-menu` trigger. Drawer rows are `size="lg"` and
  `block`, left-aligned — full-width rows are the easiest thing on a screen to hit. The
  drawer closes on route change, not on click, so redirects close it too. Never let the
  header wrap to two lines or scroll sideways.
- **Links:** inline prose links are `text-primary` **and** underlined (see Accessibility ›
  Contrast). Standalone links in navigation or footers are colour-only by design.
- **Long-form content:** markdown (the blog, `content/`) renders through NuxtUI's `Prose*`
  components, which already read the token layer. Two of their defaults contradict this file
  and are overridden in `app.config.ts` under `ui.prose`: `h1`–`h3` drop `font-bold`, and
  inline links get a real `underline` instead of a hover-only bottom border. Measure is
  `max-w-2xl` — a reading column, not the full container.
- **Empty states:** one line of `text-muted` explanation plus one action. No illustrations.
- **Tables:** `font-mono` for numeric columns, right-aligned. Row separators, not zebra striping.

---

## Accessibility

WCAG 2.2 AA is the floor, not the goal. Two gates enforce it, and they see different
things: `bun run design:check` reads source for patterns a regex can catch, and
`bun run test:a11y` runs axe in a real browser against every public route in **both** color
modes, which is the only way to check a rendered contrast ratio. What neither can judge —
whether a label actually describes its field, whether alt text is meaningful — is on review.

### Contrast

| Intent | Minimum |
|---|---|
| Body copy, labels, any text below `text-xl` | 4.5:1 |
| `text-xl` and up | 3:1 |
| Borders, focus rings, icons that carry meaning | 3:1 |
| Disabled text, decorative rules | none |

The semantic tokens in Color are vetted at both ends of the color-mode switch. A numbered
scale is a build failure precisely because `text-stone-500` can pass in light mode and fail
in dark — the token layer *is* the contrast guarantee.

**Never convey state by color alone.** Every status pairs its color with an icon or a word.
`<UBadge color="error" icon="i-lucide-x">Failed</UBadge>`, never a bare red dot.

The same rule catches inline links: a link inside a paragraph is **underlined**
(`underline underline-offset-2`), because `text-primary` alone distinguishes it from the
surrounding prose by color only. Links that are already unmistakably links by position —
nav items, footer rows, buttons — don't need it.

### Keyboard and focus

- Every interactive element is reachable and operable by keyboard, in DOM order.
- A visible `focus-visible` ring on everything focusable: 2px, `primary`. Suppressing the
  outline without replacing it is a build failure.
- No positive `tabindex`. `tabindex="-1"` is for programmatic focus targets only.
- Handlers go on a `<button>`, an `<a>`, or a NuxtUI component — never a `<div @click>`.
  That is where roles and keyboard support come from for free.
- A skip link is the first focusable element on the page, pointing at `#main`.

### Structure and labels

- `<html lang>` is set (`nuxt.config.ts` → `app.head.htmlAttrs`).
- One `<h1>` per page. Heading levels never skip.
- Landmarks on every page: `header`, `nav`, `main` (id `main`), `footer`.
- Every image and avatar carries `alt`. Decorative images take `alt=""` — an empty string,
  not a missing attribute.
- Form fields get a visible label through `<UFormField>`. A placeholder is not a label.
- Icon-only buttons need `aria-label`. An icon with no accessible name is an unlabeled
  button to a screen reader.

### Viewport and touch

- **Height:** `min-h-dvh`, never `min-h-screen`. Mobile browser chrome makes `100vh` taller
  than the visible viewport, which hides the bottom of the page under the URL bar.
- **Safe areas:** anything pinned to a viewport edge uses the safe-area utilities
  (`bottom-safe`, `right-safe`) so it clears the iOS home bar and the notch in landscape.
  The `viewport-fit=cover` meta in `nuxt.config.ts` is what makes those insets non-zero.
- **Target size:** two floors, because one number can't serve both a mouse and a thumb.
  - **24x24px everywhere** (WCAG 2.5.8, AA). NuxtUI's `sm` and `md` sizes clear this on
    their own; `size="xs"` does not reliably, so it is desktop-dense-chrome only.
  - **44x44px on coarse pointers.** Apply the `min-touch` utility, which is scoped to
    `@media (pointer: coarse)` — it buys the thumb its target without inflating the
    mouse-driven UI, whose 29-33px controls are the density this system is for.

  Every icon-only control gets `min-touch`; `design:check` enforces that one, because an
  icon-only button is the case that ends up smallest and is hardest to spot by eye.
  Anything pinned to a viewport edge or acting as a primary mobile action gets it too.
- **Motion:** `prefers-reduced-motion` is honored globally in `main.css` (see Motion) — no
  component should re-implement it.

---

## Compiling to NuxtUI v4

`/design-sync` maps the sections above onto the two generated files:

| This file | Destination |
|---|---|
| Primary ramp | `main.css` → `@theme static` → `--color-clay-*` (all 11 shades required) |
| Semantic assignments | `app.config.ts` → `ui.colors` |
| Primary shade choice | `main.css` → `:root`/`.dark` → `--ui-primary` |
| Families + scale | `main.css` → `@theme static` → `--font-*`, `--text-*` |
| Base type rules | `main.css` → `@layer base` |
| Radius, container | `main.css` → `:root` → `--ui-radius`, `--ui-container` |
| Component behavior | `app.config.ts` → per-component `slots` / `defaultVariants` |
| Safe-area utilities | `main.css` → `@utility bottom-safe` / `right-safe` |
| Touch-target floor | `main.css` → `@utility min-touch` |
| Semantic shade choices | `main.css` → `:root`/`.dark` → `--ui-primary` … `--ui-error` |

The Brand mark section compiles through a second, smaller pipeline of its own:

| This file | Destination | Run by |
|---|---|---|
| Brand mark › Construction | `app/components/Brand/Logo.vue` | `/logo-sync` |
| Brand mark › Color roles | `public/favicon.svg`, `apple-touch-icon.png`, `og.png` | `bun run brand:generate` |

Two Accessibility rules land outside the generated files, because no CSS variable can
express them: `<html lang>` and `viewport-fit=cover` live in `app.head` in
`nuxt.config.ts`, and the skip link lives in `app/layouts/default.vue`. `/design-sync`
does not own those three — leave them alone.

Verify the result at `/design-system` in dev — every token and component state on one page,
in both color modes.
