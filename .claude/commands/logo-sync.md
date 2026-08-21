# Logo Sync

Design the brand mark from `DESIGN.md`, then compile it into every file that needs one.

`/design-sync` stops at the token layer — color, type, space. This is the layer above it: the
one image the app has. It exists as a separate command because a mark is a *decision*, made
once and then left alone, while tokens get recompiled every time DESIGN.md moves.

## Usage

- `/logo-sync` — design a mark from the identity already in `DESIGN.md`
- `/logo-sync <description>` — design against a brief
  (e.g. `/logo-sync a folded map, drawn in one stroke`)
- `/logo-sync <path-to.svg>` — adopt an existing mark the fork already owns

## What already exists

Do not rebuild any of this:

| Piece | What it does |
| --- | --- |
| `DESIGN.md` › Brand mark | The contract: concept, construction rules, color roles, never-list |
| `app/components/Brand/Logo.vue` | The mark itself, and the only place it is drawn |
| `bun run brand:generate` | Derives `favicon.svg`, `apple-touch-icon.png`, `og.png` from that component |
| `bun run brand:check` | Fails `bun run ci` when those files no longer match the mark |
| `/design-system` › Brand mark | The mark at 16–48px, on an inverted ground, next to the generated files |

## Instructions

### 1. Read the identity before drawing anything

`DESIGN.md` › Identity is the brief: personality adjectives, references, density, and the
"Never" list. A mark that ignores it will clash with the app it sits on top of, and the clash
shows up on the one surface where you can't hide it.

If an argument was given, rewrite `DESIGN.md` › Brand mark **first** — concept sentence,
Construction bullets, and the Color roles table. That section is what the generator parses
and what `brand:check` fingerprints; drawing first and documenting after is how the two
end up describing different logos.

Keep the six role names exactly as they are (`icon-ink`, `icon-ground`, `og-mark`,
`og-ground`, `og-ink`, `og-muted`) and point each at a concrete `--color-*` token that
`app/assets/css/main.css` or Tailwind defines. A `--ui-*` alias is not valid there: it flips
with the color mode, and a PNG has to pick one.

### 2. Draw three candidates, then choose with the user

Three, not one. The first idea is almost never the mark, and comparison is the only way
anyone can tell you why.

Constraints, all of them load-bearing rather than stylistic:

1. **Geometry only, and static.** No interpolation, bindings, or directives — a `.png` cannot
   evaluate them, and the generator refuses rather than shipping a mark that differs between
   the header and the browser tab.
2. **`currentColor`, one flat fill,** plus at most one opacity step. No gradient, no filter,
   no `<image>`, no external reference. The mark has to survive being one colour on someone
   else's dark background.
3. **No letterforms.** `bun run rename` rewrites six files and cannot rewrite a picture — an
   initial keeps spelling the old name forever. (An existing company's real wordmark is the
   one exception, and it belongs in `/logo-sync <path>`.)
4. **On the declared grid**, whole and half units only, geometry rounded to one decimal.
5. **Legible at 16px.** This is where most candidates die. Check it before falling in love.
6. **Nothing on the DESIGN.md Never list** — for this template that means no gradients, no
   drop shadows, no second hue, no pills.

Render the candidates side by side before asking: each one at 16, 24, 48 and 96px, in the
`icon-ink`-on-`icon-ground` square as well as flat, on a light and a dark ground. A scratch
HTML file plus a screenshot is enough. Then present them with a one-line rationale each and
let the user pick — this is their logo, not yours.

For `/logo-sync <path>`: skip the candidates, but normalise what you adopt — one `viewBox`,
fills replaced by `currentColor`, `<text>` converted to paths or removed, gradients flattened.
Say what you changed and why.

### 3. Write the winner into the component

Replace the `<svg data-brand-mark>` element in `app/components/Brand/Logo.vue`. Leave the
props, the lockup markup, and the `data-brand-mark` attribute alone — the generator finds the
element by that attribute, and the header renders the same element the icons are cut from.

### 4. Compile

```bash
bun run brand:generate
```

It writes `public/favicon.svg`, `public/apple-touch-icon.png`, `public/og.png`, and
`brand.lock.json`. Read its output: it prints the resolved colors and warns if the display
webfont failed to load, in which case `og.png` fell back to a generic family and should be
regenerated rather than committed.

### 5. Verify — do not skip

```bash
bun run brand:check && bun run design:check && bun run typecheck
```

Then look at it, in a browser, at real size:

```bash
bun dev
```

`/design-system` › Brand mark shows the component and the generated files together, in both
color modes. Check the 16px cell first, then the header lockup on a real page. A mark that
only works in the design-system grid is not finished.

### 6. Report

The concept in one line, why this candidate over the other two, which files were written, and
anything in `DESIGN.md` › Brand mark you could not honour — including the thing forks most
often hit: a brand whose real logo needs two colours, which this pipeline deliberately does
not support.
