// Brand asset generator — run with `bun run brand:generate`.
//
// Derives every standalone brand file from two sources that already exist:
// the mark in app/components/Brand/Logo.vue, and the color roles, fonts, and
// app name declared in DESIGN.md › Brand mark. Nothing here is a design
// decision; it is a compiler, the same way /design-sync is one.
//
//   public/favicon.svg              32-grid icon, rounded, ground included
//   public/apple-touch-icon.png     180x180, full-bleed (iOS applies its own mask)
//   public/icon-192.png             192x192, maskable-safe, for the web manifest
//   public/icon-512.png             512x512, maskable-safe, for the web manifest
//   public/og.png                   1200x630 link preview
//   shared/utils/brand-colors.generated.ts  theme_color / background_color for
//                                    server/routes/manifest.webmanifest.get.ts —
//                                    a manifest has no color mode either, so
//                                    these are resolved here, not hand-written.
//   brand.lock.json                 fingerprint of the inputs, read by brand:check
//
// Rasterizing uses the Chromium that Playwright already installs for the a11y
// suite — no new dependency, and the OG image is composed in the same engine
// that renders the site, with the same webfonts. Chromium is also how the color
// tokens get resolved: DESIGN.md may name a Tailwind built-in whose value is
// `oklch(...)`, and asking a browser to paint one pixel is more durable than
// reimplementing OKLCH-to-sRGB and getting it subtly wrong on some future
// Tailwind release.
//
// The webfonts come from Google Fonts over the network, so this needs a
// connection. Offline, it still produces correct assets — the OG image just
// falls back to the generic family and says so.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium, type Page } from '@playwright/test'

import {
  collectBrandInputs,
  GENERATED_ASSETS,
  GENERATOR_VERSION,
  LOCK_FILE,
  ROOT,
  type BrandInputs,
} from './brand-inputs'
import { BRAND_ROLES, markPlacement, markTransform, type BrandRole } from './brand-source'

const OG = { width: 1200, height: 630 }
const APPLE_TOUCH = 180
/** Sizes Android/Chrome expect in a web app manifest — the 192 is what shows
 *  on the home screen and app switcher, the 512 is the splash-screen source. */
const MANIFEST_ICON_SIZES = [192, 512] as const
/** The mark's height on the share image. Smaller than ~80px it reads as debris
 *  at the size a timeline actually shows a link preview. */
const OG_MARK = 96
/** Share of the icon square the mark covers. Below ~0.6 it reads as a dot. */
const ICON_COVERAGE = 0.7
const APPLE_COVERAGE = 0.66
/**
 * Share of the canvas the mark's bounding *square* covers on the two manifest
 * icons. Android applies a maskable icon's own mask shape (circle, squircle,
 * rounded square — the OS chooses) and only guarantees a centered circle of
 * SAFE_ZONE_DIAMETER survives every shape — so this has to bound a circle,
 * not a square, and those are two different numbers.
 *
 * The worst case is the ink's bounding-box *corner*, not its edges: a square
 * of side `MASKABLE_COVERAGE · size`, centered, has its farthest corner at
 * `(MASKABLE_COVERAGE / 2) · √2 · size` from center. For that to stay inside
 * the safe-zone radius (`SAFE_ZONE_DIAMETER / 2 · size`):
 *
 *   MASKABLE_COVERAGE ≤ SAFE_ZONE_DIAMETER / √2  ≈  0.8 / 1.41  ≈  0.566
 *
 * 0.56 leaves a small margin below that ceiling. This mark clears it with
 * room to spare (assertMaskableSafeZone measures the real ink and checks —
 * the margin above isn't the guarantee, that assertion is).
 */
const MASKABLE_COVERAGE = 0.56
/** Diameter, as a fraction of icon size, of the circle every maskable mask
 *  shape is guaranteed to leave unclipped. Android's own contract, not this
 *  repo's — see https://developer.chrome.com/docs/android/trusted-web-activity/maskable-icons */
const SAFE_ZONE_DIAMETER = 0.8
/** Corner radius on the 32 grid — favicons are not masked by the browser. */
const FAVICON_RADIUS = 7

const inputs = collectBrandInputs()

const browser = await chromium.launch().catch((error: unknown) => {
  // The one dependency this script has that nothing else in a fresh clone
  // needs first — the a11y suite installs it, but only once you've run it.
  console.error(String(error instanceof Error ? error.message : error))
  console.error('\nIf Chromium is missing, install it once:\n\n  bun run playwright:install\n')
  process.exit(1)
})
const context = await browser.newContext({ deviceScaleFactor: 1 })
const page = await context.newPage()

// Before anything is written: a fork that redraws the mark fuller than this
// template's does could pass MASKABLE_COVERAGE's margin comfortably and still
// clip on Android, and brand:check could never catch it — it fingerprints
// inputs, it never measures pixels. This does.
await assertMaskableSafeZone(page, inputs)

const palette = await resolvePalette(page, inputs)

writeFileSync(join(ROOT, 'public/favicon.svg'), faviconSvg(inputs, palette))

await shoot(
  page,
  iconGroundHtml(inputs, palette, APPLE_TOUCH, APPLE_COVERAGE),
  APPLE_TOUCH,
  APPLE_TOUCH,
  'public/apple-touch-icon.png',
)

for (const size of MANIFEST_ICON_SIZES) {
  await shoot(
    page,
    iconGroundHtml(inputs, palette, size, MASKABLE_COVERAGE),
    size,
    size,
    `public/icon-${size}.png`,
  )
}

writeFileSync(join(ROOT, 'shared/utils/brand-colors.generated.ts'), brandColorsTs(palette))

const fontsLoaded = await shoot(
  page,
  ogHtml(inputs, palette),
  OG.width,
  OG.height,
  'public/og.png',
  inputs,
)

writeFileSync(
  LOCK_FILE,
  `${JSON.stringify(
    {
      _comment:
        'Generated by `bun run brand:generate`. Fingerprints the inputs behind the files listed in `generated` below so `bun run brand:check` can fail the build when they drift. `generatorVersion` is recorded separately from `fingerprint` so brand:check can tell "the pipeline changed" apart from "your inputs changed" — see scripts/check-brand.ts. Commit it.',
      fingerprint: inputs.fingerprint,
      generatorVersion: GENERATOR_VERSION,
      generated: GENERATED_ASSETS,
    },
    null,
    2,
  )}\n`,
)

await browser.close()

console.info(`brand:generate — wrote ${GENERATED_ASSETS.join(', ')} and brand.lock.json`)
console.info(`  mark      ${inputs.mark.viewBox} from app/components/Brand/Logo.vue`)
console.info(`  name      ${inputs.appName}${inputs.appHost ? `  (${inputs.appHost})` : ''}`)
console.info(`  colors    ${BRAND_ROLES.map((role) => `${role} ${palette[role]}`).join('  ')}`)
if (!fontsLoaded) {
  console.warn(
    `  fonts     ${inputs.fonts.display} did not load — og.png fell back to a generic family.\n` +
      '            Check the network, or that the family is on Google Fonts, then re-run.',
  )
}

// ── Rendering ───────────────────────────────────────────────────────────────

type Palette = Record<BrandRole, string>

/** The mark as a standalone <svg>, painted in one flat color. */
function markSvg(inputs: BrandInputs, fill: string, size: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${inputs.mark.viewBox}" ` +
    `width="${size}" height="${size}" fill="${fill}" aria-hidden="true">${inputs.mark.inner}</svg>`
  )
}

function faviconSvg(inputs: BrandInputs, palette: Palette): string {
  const transform = markTransform(inputs.mark.viewBox, 32, ICON_COVERAGE)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="${escapeHtml(inputs.appName)}">
  <!-- GENERATED by \`bun run brand:generate\` from app/components/Brand/Logo.vue.
       Hand-edits are overwritten and \`bun run brand:check\` fails on them.
       The mark carries its own ground here: a transparent icon disappears
       against a dark browser tab strip. -->
  <rect width="32" height="32" rx="${FAVICON_RADIUS}" fill="${palette['icon-ground']}"/>
  <g fill="${palette['icon-ink']}" transform="${transform}">
    ${inputs.mark.inner.replace(/\n\s+/g, '\n    ')}
  </g>
</svg>
`
}

/**
 * A square, full-bleed icon: the ground fills the canvas edge-to-edge and the
 * mark sits centred at `coverage` of it. Shared by the apple-touch icon and
 * the two manifest icons because the same fact is true of all three — the OS
 * applies its own mask (iOS's rounded square, Android's maskable shape), so a
 * radius baked in here would double up with — or conflict with — that mask.
 */
function iconGroundHtml(
  inputs: BrandInputs,
  palette: Palette,
  size: number,
  coverage: number,
): string {
  return htmlPage(`
    <div style="width:${size}px;height:${size}px;background:${palette['icon-ground']};display:flex;align-items:center;justify-content:center">
      ${markSvg(inputs, palette['icon-ink'], size * coverage)}
    </div>
  `)
}

function ogHtml(inputs: BrandInputs, palette: Palette): string {
  const { display, sans, mono } = inputs.fonts
  // DESIGN.md › Typography: display face at weight 400 with -0.02em tracking,
  // body in the sans. Sizes are the OG canvas's own scale — 1200x630 is
  // routinely shown at 500px wide, so nothing subtle survives.
  return htmlPage(
    `
    <div style="width:${OG.width}px;height:${OG.height}px;background:${palette['og-ground']};display:flex;flex-direction:column;justify-content:space-between;padding:80px;box-sizing:border-box">
      <div>
        ${markSvg(inputs, palette['og-mark'], OG_MARK)}
        <div style="font-family:'${display}',serif;font-weight:400;letter-spacing:-0.02em;font-size:88px;line-height:1.1;color:${palette['og-ink']};margin-top:40px;max-width:940px">
          ${escapeHtml(inputs.appName)}
        </div>
        <div style="font-family:'${sans}',sans-serif;font-size:34px;line-height:1.5;color:${palette['og-muted']};margin-top:28px;max-width:880px">
          ${escapeHtml(inputs.appDescription)}
        </div>
      </div>
      ${
        inputs.appHost
          ? `<div style="font-family:'${mono}',monospace;font-size:26px;color:${palette['og-muted']};border-top:1px solid ${palette['og-muted']}33;padding-top:28px">${escapeHtml(inputs.appHost)}</div>`
          : ''
      }
    </div>
  `,
    [display, sans, mono],
  )
}

/**
 * The web manifest's `theme_color`/`background_color`, resolved to hex at
 * generate time and written as a TS module — never as hand-typed hex in
 * server/routes/manifest.webmanifest.get.ts. Same reasoning as the PNGs
 * (DESIGN.md › Brand mark › Color roles): a manifest is a JSON file with no
 * color mode, so `--ui-*` aliases (which flip between light and dark) aren't
 * a valid source for it.
 */
function brandColorsTs(palette: Palette): string {
  return `// GENERATED by \`bun run brand:generate\`. Hand-edits are overwritten and
// \`bun run brand:check\` fails on them.
//
// theme_color / background_color for server/routes/manifest.webmanifest.get.ts,
// resolved from DESIGN.md › Brand mark › Color roles \`manifest-theme\` and
// \`manifest-ground\` — see scripts/generate-brand-assets.ts.

export const BRAND_MANIFEST_COLORS = {
  themeColor: '${palette['manifest-theme']}',
  backgroundColor: '${palette['manifest-ground']}',
} as const
`
}

/** One <link> per family: a single stylesheet request naming a family that the
 *  provider doesn't have fails the whole request, taking the others with it. */
function htmlPage(body: string, families: string[] = []): string {
  const links = families
    .map(
      (family) =>
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}&display=block">`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8">${links}<style>*{margin:0;padding:0}body{display:flex}</style></head><body>${body}</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Browser work ────────────────────────────────────────────────────────────

/**
 * Measures the mark's REAL rendered ink — not the constant's worst-case
 * arithmetic above — and fails `bun run brand:generate` if any corner of it
 * falls outside Android's maskable safe zone. MASKABLE_COVERAGE's margin
 * assumes the ink is no fuller than a square bounding box scaled to
 * `MASKABLE_COVERAGE · size`; a redesigned mark (via `/logo-sync`) that draws
 * closer to its own viewBox edges could break that assumption while the
 * constant itself is untouched, and nothing else in this pipeline would
 * notice — `brand:check` only fingerprints inputs, it never measures pixels.
 *
 * `getBBox()` on the ink, wrapped in a bare `<g>` with no transform, returns
 * its bounding box in the mark's own viewBox units — unaffected by whatever
 * size the icon ends up rendered at, so this only needs to run once,
 * independent of MANIFEST_ICON_SIZES. markPlacement() with SIZE = 1 then maps
 * those viewBox units onto the same centred scale/translate the icons are
 * actually placed with (verified equivalent to the flex-centered <svg>
 * iconGroundHtml() renders: both are a uniform scale-to-fit-and-center of the
 * viewBox, so the same formula answers for either), so every distance below
 * is a fraction of the icon's own size — the same units SAFE_ZONE_DIAMETER is in.
 */
async function assertMaskableSafeZone(page: Page, inputs: BrandInputs): Promise<void> {
  const { viewBox, inner } = inputs.mark

  await page.setContent(
    `<!doctype html><html><body><svg xmlns="http://www.w3.org/2000/svg"><g id="ink">${inner}</g></svg></body></html>`,
  )
  const ink = await page.evaluate(() => {
    const g = document.getElementById('ink') as unknown as SVGGraphicsElement
    const box = g.getBBox()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })

  const SIZE = 1 // a unit canvas — every distance computed below is a fraction of icon size
  const { x: translateX, y: translateY, scale } = markPlacement(viewBox, SIZE, MASKABLE_COVERAGE)

  const corners = [
    [ink.x, ink.y],
    [ink.x + ink.width, ink.y],
    [ink.x, ink.y + ink.height],
    [ink.x + ink.width, ink.y + ink.height],
  ]
  const center = SIZE / 2
  const safeRadius = SAFE_ZONE_DIAMETER / 2
  const farthest = Math.max(
    ...corners.map(([mx = 0, my = 0]) =>
      Math.hypot(translateX + mx * scale - center, translateY + my * scale - center),
    ),
  )

  if (farthest > safeRadius) {
    throw new Error(
      `The mark's ink reaches ${(farthest * 100).toFixed(1)}% of the icon size from center at ` +
        `MASKABLE_COVERAGE = ${MASKABLE_COVERAGE} (scripts/generate-brand-assets.ts) — Android's ` +
        `maskable safe zone only guarantees ${(safeRadius * 100).toFixed(0)}%. Lower ` +
        `MASKABLE_COVERAGE, or redraw the mark closer to its viewBox center.`,
    )
  }
}

/**
 * Resolve each declared token to an sRGB hex by painting one pixel with it.
 * Canvas accepts any color syntax the browser parses, and getImageData hands
 * back the bytes — no color math, and no way for it to disagree with what the
 * app renders.
 */
async function resolvePalette(page: Page, inputs: BrandInputs): Promise<Palette> {
  await page.setContent('<!doctype html><html><body></body></html>')

  const values = BRAND_ROLES.map((role) => inputs.colors[role].value)
  const hexes = await page.evaluate((values: string[]) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')!
    return values.map((value) => {
      if (!CSS.supports('color', value)) return ''
      ctx.fillStyle = value
      ctx.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
      return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
    })
  }, values)

  const palette = {} as Palette
  BRAND_ROLES.forEach((role, index) => {
    const hex = hexes[index]
    if (!hex) {
      throw new Error(
        `The value behind \`${inputs.colors[role].token}\` is not a color the browser understands: ` +
          `"${inputs.colors[role].value}"`,
      )
    }
    palette[role] = hex
  })
  return palette
}

/** Render HTML at exact pixel dimensions and write the PNG. Returns whether the
 *  requested webfonts actually arrived. */
async function shoot(
  page: Page,
  html: string,
  width: number,
  height: number,
  target: string,
  fontCheck?: BrandInputs,
): Promise<boolean> {
  await page.setViewportSize({ width, height })
  await page.setContent(html, { waitUntil: 'domcontentloaded' })

  // Never block on the font provider: an offline run should still produce a
  // correct-looking image rather than hang for the default navigation timeout.
  await page.evaluate(() =>
    Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 15_000))]),
  )

  const loaded = fontCheck
    ? await page.evaluate(
        (family: string) => document.fonts.check(`88px "${family}"`),
        fontCheck.fonts.display,
      )
    : true

  await page.screenshot({ path: join(ROOT, target), type: 'png' })
  return loaded
}
