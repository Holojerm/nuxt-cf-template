// The brand pipeline's parsing layer — pure functions only. No filesystem, no
// browser, no Playwright, so it runs in the workerd test pool alongside the
// rest of test/ (see test/brand.test.ts).
//
// Both halves of the pipeline read their inputs through this module:
// `bun run brand:generate`, which rasterizes, and `bun run brand:check`, which
// only fingerprints. That sharing is the point — a gate that parses its inputs
// differently from the generator eventually disagrees with it, and the first
// symptom is a build that fails on assets which are actually fine.

/** The mark as authored in app/components/Brand/Logo.vue. */
export interface BrandMark {
  viewBox: string
  /** Geometry only — the enclosing <svg> tag is rebuilt by the generator. */
  inner: string
}

/**
 * Colour roles the raster assets — and the web manifest, which has the same
 * problem a PNG does — need, in the order they appear in DESIGN.md › Brand
 * mark. Every one resolves to a concrete ramp token: a PNG (or a JSON file
 * with a `theme_color` key) has no color mode, so `--ui-primary` (which flips
 * between light and dark) cannot be the answer for a file that has to pick one.
 */
export const BRAND_ROLES = [
  'icon-ink',
  'icon-ground',
  'og-mark',
  'og-ground',
  'og-ink',
  'og-muted',
  'manifest-theme',
  'manifest-ground',
] as const

export type BrandRole = (typeof BRAND_ROLES)[number]

/** Anything that would make the extracted markup render differently in a file
 *  than it does in the component: interpolation, directives, bindings, handlers. */
const VUE_SYNTAX = /\{\{|\sv-[a-z]|\s:[a-zA-Z][\w-]*=|\s@[a-zA-Z][\w-]*=/

/**
 * Pull the mark out of the Vue component. The component is the single source
 * of truth for the glyph — the header renders this exact markup, and so does
 * every generated file, which is what keeps a favicon from drifting a redesign
 * behind the app it belongs to.
 */
export function extractMark(source: string): BrandMark {
  // Search the template only. The script block above it talks *about*
  // `<svg data-brand-mark>` in prose, and a regex over the whole file happily
  // matches the sentence instead of the element.
  const scope = source.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? source
  const svg = scope.match(/<svg\b([^>]*\bdata-brand-mark\b[^>]*)>([\s\S]*?)<\/svg>/)
  if (!svg) {
    throw new Error(
      'No <svg data-brand-mark> found in the logo component.\n' +
        'The generator extracts that element by name — keep the attribute on it.',
    )
  }

  const [, attrs = '', inner = ''] = svg

  const viewBox = attrs.match(/viewBox="([^"]+)"/)?.[1]
  if (!viewBox) throw new Error('<svg data-brand-mark> needs a literal viewBox attribute.')

  if (VUE_SYNTAX.test(inner)) {
    throw new Error(
      'The mark geometry contains Vue syntax (interpolation, a directive, or a binding).\n' +
        'It has to be static: a .svg file and a .png cannot evaluate it, so anything\n' +
        'dynamic in there renders one way in the app and another in every icon.',
    )
  }

  if (/fill="#|stroke="#/.test(inner)) {
    throw new Error(
      'The mark geometry hardcodes a hex color. Paint it with `currentColor` so it\n' +
        'inherits the token layer in-app — the generator substitutes the resolved\n' +
        'DESIGN.md color when it writes the standalone files.',
    )
  }

  // Comments are stripped rather than carried through: they document the mark
  // for whoever edits the component, and they would otherwise both bloat every
  // generated file and re-flag the assets as stale over a reworded sentence.
  return { viewBox, inner: inner.replace(/<!--[\s\S]*?-->/g, '').trim() }
}

/**
 * `--color-*` declarations from a CSS file, as written. Values stay verbatim
 * (hex from main.css, oklch from Tailwind's theme.css) — resolving them to
 * sRGB is the browser's job in the generator, not a color-math reimplementation
 * here that would be wrong in a different way every major Tailwind release.
 */
export function parseColorTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const [, name = '', value = ''] of css.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim()
  }
  return tokens
}

/** The first family named by each `--font-*` token — the one a `<link>` to a
 *  font provider has to ask for. Fallback stacks are the browser's business. */
export function parseFontFamilies(css: string): Record<string, string> {
  const families: Record<string, string> = {}
  for (const [, role = '', value = ''] of css.matchAll(/--font-([\w-]+):\s*([^;]+);/g)) {
    const [first = ''] = value.split(',')
    const family = first.trim().replace(/^['"]|['"]$/g, '')
    if (family) families[role] = family
  }
  return families
}

/**
 * The role → token table under DESIGN.md › Brand mark. Parsed rather than
 * duplicated in a config file, for the same reason the color ramp is: DESIGN.md
 * is the contract, and a second place to state a brand color is a second place
 * for it to be stale.
 */
export function parseBrandRoles(designMd: string): Record<BrandRole, string> {
  const section = designMd.match(/\n## Brand mark\n([\s\S]*?)(?=\n## |$)/)
  if (!section) {
    throw new Error('DESIGN.md has no `## Brand mark` section — the brand pipeline reads it.')
  }

  const found: Partial<Record<BrandRole, string>> = {}
  for (const [, role = '', token = ''] of section[1]!.matchAll(
    /^\|\s*`([\w-]+)`\s*\|\s*`(--color-[\w-]+)`\s*\|/gm,
  )) {
    if ((BRAND_ROLES as readonly string[]).includes(role)) found[role as BrandRole] = token
  }

  const missing = BRAND_ROLES.filter((role) => !found[role])
  if (missing.length) {
    throw new Error(
      `DESIGN.md › Brand mark is missing a token for: ${missing.join(', ')}.\n` +
        'Each role needs a row of the form: | `role` | `--color-ramp-shade` | … |',
    )
  }

  return found as Record<BrandRole, string>
}

/**
 * FNV-1a, 64-bit, hex. Not cryptography — a change detector for
 * `bun run brand:check`, which only ever compares it to the value the generator
 * wrote. Implemented here rather than imported so this module keeps its "no
 * platform APIs" property and stays testable inside workerd.
 */
export function fingerprint(parts: Record<string, string>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${collapse(parts[key] ?? '')}`)
    .join('\n')

  let hash = 0xcbf29ce484222325n
  for (const char of canonical) {
    hash ^= BigInt(char.codePointAt(0)!)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * A `KEY = "value"` entry from wrangler.toml's `[vars]`. That file is what the
 * deployed Worker actually reads, so it — not the nuxt.config default — is the
 * app name that belongs on a share image.
 */
export function parseWranglerVar(toml: string, key: string): string | undefined {
  const match = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
  return match?.[1]
}

/**
 * A `key: 'value'` entry from nuxt.config.ts's `runtimeConfig.public`. Read by
 * regex rather than by importing the config: nuxt.config.ts calls the
 * auto-imported `defineNuxtConfig`, so it does not evaluate outside Nuxt.
 * Handles the value sitting on the next line, which is where oxfmt puts the
 * longer ones.
 */
export function parseNuxtPublicVar(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`\\b${key}:\\s*(?:\\n\\s*)?'((?:[^'\\\\]|\\\\.)*)'`))
  return match?.[1]?.replace(/\\(.)/g, '$1')
}

/**
 * Where the mark sits inside a square canvas of `size`, covering `coverage` of
 * it. Derived from the authored viewBox rather than assumed, so a fork that
 * draws on a 24 or 48 grid gets correctly centred icons without touching this.
 */
export function markTransform(viewBox: string, size: number, coverage: number): string {
  const [minX = 0, minY = 0, width = 0, height = 0] = viewBox.trim().split(/\s+/).map(Number)
  if (!width || !height) throw new Error(`Unusable viewBox on the mark: "${viewBox}"`)

  const scale = (size * coverage) / Math.max(width, height)
  const x = round((size - width * scale) / 2 - minX * scale)
  const y = round((size - height * scale) / 2 - minY * scale)
  return `translate(${x} ${y}) scale(${round(scale)})`
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

/** Whitespace between attributes and tags is not a design change. */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
