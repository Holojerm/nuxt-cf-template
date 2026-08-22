// Everything the brand pipeline reads off disk, in one place, so that
// `bun run brand:generate` and `bun run brand:check` cannot disagree about
// what the current inputs are. The parsing itself lives in ./brand-source.ts
// (pure, unit-tested); this file only locates files and assembles the result.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  BRAND_ROLES,
  extractMark,
  fingerprint,
  parseBrandRoles,
  parseColorTokens,
  parseFontFamilies,
  parseNuxtPublicVar,
  parseWranglerVar,
  type BrandMark,
  type BrandRole,
} from './brand-source'

export const ROOT = resolve(import.meta.dir, '..')
export const LOCK_FILE = join(ROOT, 'brand.lock.json')
export const LOGO_COMPONENT = 'app/components/Brand/Logo.vue'

/** Files the generator writes, relative to the project root. */
export const GENERATED_ASSETS = [
  'public/favicon.svg',
  'public/apple-touch-icon.png',
  'public/icon-192.png',
  'public/icon-512.png',
  'public/og.png',
  'shared/utils/brand-colors.generated.ts',
] as const

/**
 * Bump when the layout of a generated asset changes — the OG composition, the
 * icon's coverage, the favicon's corner radius. The fingerprint includes it, so
 * a template change re-flags every fork's assets as stale, which is the point:
 * the inputs didn't move, but the output would.
 *
 * Bumped to '2' when public/icon-192.png, public/icon-512.png and
 * shared/utils/brand-colors.generated.ts joined the pipeline (Finding 14: web
 * app manifest).
 *
 * Bumped to '3' when MASKABLE_COVERAGE moved from 0.8 to 0.56 (Wave 4.4 fix
 * round, finding 1): 0.8 bounded the *diameter* Android's maskable safe zone
 * guarantees, not the smaller square that actually fits inside it, so a fork
 * that had already generated icons under the old value needs this bump to
 * get flagged stale and re-render them — nothing in `fingerprintOf()` below
 * hashes MASKABLE_COVERAGE itself, only this string.
 */
export const GENERATOR_VERSION = '3'

export interface BrandColor {
  /** The `--color-*` token named in DESIGN.md › Brand mark. */
  token: string
  /** Its declared value — hex from main.css, oklch from Tailwind's theme. */
  value: string
}

export interface BrandInputs {
  mark: BrandMark
  colors: Record<BrandRole, BrandColor>
  fonts: { display: string; sans: string; mono: string }
  appName: string
  appDescription: string
  /** Bare hostname for the OG footer, or '' when no origin is configured. */
  appHost: string
  /** Change detector for brand:check. */
  fingerprint: string
}

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

export function collectBrandInputs(): BrandInputs {
  const mark = extractMark(read(LOGO_COMPONENT))
  const roles = parseBrandRoles(read('DESIGN.md'))

  // Tailwind's own theme first so a built-in ramp (`stone`, `sky`) resolves,
  // then main.css on top so this app's custom ramp wins on any name collision.
  const tokens = {
    ...parseColorTokens(read('node_modules/tailwindcss/theme.css')),
    ...parseColorTokens(read('app/assets/css/main.css')),
  }

  const colors = {} as Record<BrandRole, BrandColor>
  for (const role of BRAND_ROLES) {
    const token = roles[role]
    const value = tokens[token]
    if (!value) {
      throw new Error(
        `DESIGN.md › Brand mark maps \`${role}\` to \`${token}\`, which no stylesheet defines.\n` +
          'Custom ramps live in app/assets/css/main.css (run /design-sync after editing\n' +
          'DESIGN.md › Color); built-in ramps come from Tailwind.',
      )
    }
    colors[role] = { token, value }
  }

  const css = read('app/assets/css/main.css')
  const families = parseFontFamilies(css)
  const fonts = {
    display: families.display ?? 'serif',
    sans: families.sans ?? 'sans-serif',
    mono: families.mono ?? 'monospace',
  }

  // Deployment order of precedence: the environment the generator runs in, then
  // wrangler.toml's [vars] (what the deployed Worker actually serves), then the
  // nuxt.config default. A share image should say what the live site says.
  const wrangler = read('wrangler.toml')
  const nuxtConfig = read('nuxt.config.ts')
  const setting = (envKey: string, configKey: string) =>
    process.env[envKey] ??
    parseWranglerVar(wrangler, envKey) ??
    parseNuxtPublicVar(nuxtConfig, configKey) ??
    ''

  const appName = setting('NUXT_PUBLIC_APP_NAME', 'appName')
  const appDescription = setting('NUXT_PUBLIC_APP_DESCRIPTION', 'appDescription')
  const appUrl = setting('NUXT_PUBLIC_APP_URL', 'appUrl')
  const appHost = appUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')

  const inputs: Omit<BrandInputs, 'fingerprint'> = {
    mark,
    colors,
    fonts,
    appName,
    appDescription,
    appHost,
  }

  return { ...inputs, fingerprint: fingerprintOf(inputs) }
}

function fingerprintOf(inputs: Omit<BrandInputs, 'fingerprint'>): string {
  const parts: Record<string, string> = {
    generator: GENERATOR_VERSION,
    viewBox: inputs.mark.viewBox,
    geometry: inputs.mark.inner,
    'font.display': inputs.fonts.display,
    'font.sans': inputs.fonts.sans,
    'font.mono': inputs.fonts.mono,
    appName: inputs.appName,
    appDescription: inputs.appDescription,
    appHost: inputs.appHost,
  }
  for (const role of BRAND_ROLES) {
    parts[`color.${role}`] = `${inputs.colors[role].token}:${inputs.colors[role].value}`
  }
  return fingerprint(parts)
}
