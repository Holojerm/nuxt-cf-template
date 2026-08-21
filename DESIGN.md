# DESIGN.md

The visual design system for this app, in the portable [DESIGN.md](https://designmd.app/)
format that Claude Code, Codex, Cursor, and friends read directly.

**This file is the source of truth.** `app/assets/css/main.css` and `app/app.config.ts` are
*compiled from it* — run `/design-sync` after editing this file, never hand-edit the two
generated files and expect them to survive. `bun run design:check` enforces that app code uses
only the tokens declared here.

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

Two Accessibility rules land outside the generated files, because no CSS variable can
express them: `<html lang>` and `viewport-fit=cover` live in `app.head` in
`nuxt.config.ts`, and the skip link lives in `app/layouts/default.vue`. `/design-sync`
does not own those three — leave them alone.

Verify the result at `/design-system` in dev — every token and component state on one page,
in both color modes.
