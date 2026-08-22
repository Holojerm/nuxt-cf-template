// Pure manifest-building logic for GET /manifest.webmanifest. The route
// (server/routes/manifest.webmanifest.get.ts) stays a thin wrapper that reads
// runtime config and calls buildManifest() — this is what's actually
// unit-tested (test/manifest.test.ts), the same split robots.txt.get.ts /
// server/utils/seo.ts already uses.
//
// No Nitro auto-imports here on purpose. Route files rely on Nuxt's
// build-time transform to inject `defineEventHandler`/`useRuntimeConfig`, and
// that transform never runs under `vitest-pool-workers` — a plain `import`
// of the route file would throw on the auto-imported names before a single
// assertion ran. Keeping this file free of them, and taking every value as a
// parameter, is what lets a test import it directly.

import { BRAND_MANIFEST_COLORS } from '#shared/utils/brand-colors.generated'

/**
 * Join `app.baseURL` onto a root-relative path.
 *
 * A fork deployed under a sub-path (`app.baseURL: '/app/'`, not just the
 * default `/`) needs every URL-shaped manifest field to carry that prefix:
 * `scope` without it excludes the very app it's meant to scope, and an icon
 * `src` without it 404s. `app.baseURL` is always given with a leading slash
 * and, when it isn't `/`, a trailing one too — this only has to strip
 * whatever trailing slash is there before appending `path` (which always
 * starts with its own leading slash), so `/` + `/` doesn't double up.
 */
export function withBase(baseURL: string, path: string): string {
  const base = (baseURL || '/').replace(/\/+$/, '')
  return `${base}${path}`
}

export interface ManifestConfig {
  baseURL: string
  appName: string
  appDescription: string
}

/**
 * Builds the manifest object served by the route. `theme_color`/
 * `background_color` come from shared/utils/brand-colors.generated.ts — see
 * that file and DESIGN.md › Brand mark › Color roles for why those two are
 * generated rather than read off runtime config like the name/description
 * are: a manifest has no color mode, so a `--ui-*` alias can't answer for it.
 *
 * Both icons were generated maskable-safe (scripts/generate-brand-assets.ts
 * › MASKABLE_COVERAGE), so one `purpose: "any maskable"` entry per icon
 * covers both interpretations rather than needing two entries each.
 */
export function buildManifest(config: ManifestConfig) {
  const { baseURL, appName, appDescription } = config

  return {
    name: appName,
    short_name: appName,
    description: appDescription,
    start_url: withBase(baseURL, '/'),
    scope: withBase(baseURL, '/'),
    display: 'standalone' as const,
    background_color: BRAND_MANIFEST_COLORS.backgroundColor,
    theme_color: BRAND_MANIFEST_COLORS.themeColor,
    icons: [
      {
        src: withBase(baseURL, '/icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: withBase(baseURL, '/icon-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }
}
