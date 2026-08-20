# Design Sync

Compile `DESIGN.md` into this project's NuxtUI v4 token layer, then verify the result.

## Usage

- `/design-sync` — recompile the generated files from the current `DESIGN.md`
- `/design-sync <description>` — author a new `DESIGN.md` from a brief, then compile
  (e.g. `/design-sync brutalist fintech, dense, monochrome with one acid accent`)
- `/design-sync <url|path>` — adopt an existing DESIGN.md (from
  [designmd.app](https://designmd.app/) or
  [awesome-claude-design](https://github.com/VoltAgent/awesome-claude-design)), then compile

## Instructions

### 1. Establish DESIGN.md

If an argument was given, rewrite `/DESIGN.md` first — wholesale, not by patching the existing
one. Keep the section structure intact (Identity, Color, Typography, Space/shape/elevation,
Motion, Component behavior, Compiling to NuxtUI v4) because step 2 reads those sections.

Fill in the **Identity** section properly — personality adjectives, references, density, motion
appetite, color-mode stance, and a real "Never" list. A vague identity produces a generic
result; this section is what makes the app look like something rather than like a template.

If no argument was given, read `/DESIGN.md` as-is and proceed.

### 2. Compile to the two generated files

Both files carry a `GENERATED FROM /DESIGN.md` header. Rewrite them fully — never leave a
hand-edit from a previous run in place.

| DESIGN.md section | Destination |
| --- | --- |
| Primary ramp | `app/assets/css/main.css` → `@theme static` → `--color-<name>-50…950` |
| Semantic assignments | `app/app.config.ts` → `ui.colors` |
| Primary shade choice | `main.css` → `:root` / `.dark` → `--ui-primary` |
| Families + scale | `main.css` → `@theme static` → `--font-*`, `--text-*` |
| Base type rules | `main.css` → `@layer base` |
| Radius, container | `main.css` → `:root` → `--ui-radius`, `--ui-container` |
| Component behavior | `app.config.ts` → per-component `slots` / `defaultVariants` |

Hard constraints — each of these silently breaks the build or the theme if violated:

1. **All 11 shades** (50, 100…900, 950) must be defined for any custom color. NuxtUI resolves
   shades at runtime; a missing shade fails at render, not at build.
2. **Use `@theme static`**, not `@theme`. Non-static lets Tailwind tree-shake shades that
   NuxtUI only references dynamically.
3. **Keep `@import 'tailwindcss'; @import '@nuxt/ui';`** at the top of `main.css`. Without them
   NuxtUI's generated theme never bundles and every page renders unstyled.
4. **Any color named in `ui.colors`** must exist with all 11 shades — either a Tailwind built-in
   or a custom ramp you just defined.
5. **Fonts need no install.** `@nuxt/fonts` ships with `@nuxt/ui` and auto-downloads families
   referenced in CSS. Also declare each family in a real `font-family` rule inside
   `@layer base` — that guarantees detection and applies the typography in one move.
6. **Match the weights the typeface actually has.** If the display face ships at 400 only, the
   base layer must set `font-weight: 400` and templates must not use `font-bold` on it.
7. **Read `.nuxt/ui/<component>.ts` before writing any component override.** It is the fully
   resolved theme. Most overrides people reach for are already the default (`font-medium` on
   buttons, `rounded-md` derived from `--ui-radius`), and a `slots` override *loses* to any
   `variants` entry touching the same property — so `slots.root: 'bg-elevated'` on a card is
   silently beaten by the `outline` variant's `bg-default`. Prefer `defaultVariants` over
   `slots` whenever a variant already expresses the intent.
8. **Reach for NuxtUI's own layout primitives.** `<UContainer>` reads `--ui-container`; a
   hardcoded `max-w-7xl` silently ignores it and drifts from DESIGN.md.

### 3. Propagate to existing UI

Update `app/layouts/default.vue`, `app/pages/index.vue`, and any feature components so they
reflect the new system — heading faces, density, and semantic tokens. A synced token layer
under untouched markup looks broken, not redesigned.

Use only the semantic utilities: `text-default|muted|dimmed|toned|highlighted|inverted`,
`bg-default|muted|elevated|accented|inverted`, `border-default|muted|accented|inverted`, and
`text-primary` etc. Never a numbered scale, never a raw hex.

### 4. Verify — do not skip

```bash
bun run design:check && bun run typecheck && bun run build
```

Then look at the result:

```bash
bun dev
```

Screenshot `/design-system` in **both** color modes (the route renders every token and component
state on one page) and check against the DESIGN.md "Never" list. Configuring a theme without
looking at it is how systems end up technically-compliant and visually incoherent.

Fix anything that reads wrong, then re-run the checks.

### 5. Report

State what changed: the personality in one line, the palette and type choices, which files were
regenerated, and anything in DESIGN.md you could not express in NuxtUI's token layer.
