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

Primary resolves to **600** in light mode and **400** in dark — one step darker than NuxtUI's
default for contrast against warm neutrals.

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
- **Empty states:** one line of `text-muted` explanation plus one action. No illustrations.
- **Tables:** `font-mono` for numeric columns, right-aligned. Row separators, not zebra striping.

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

Verify the result at `/design-system` in dev — every token and component state on one page,
in both color modes.
