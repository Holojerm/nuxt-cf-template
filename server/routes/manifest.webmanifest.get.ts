// GET /manifest.webmanifest
//
// Finding 14: no web app manifest, so "Add to Home Screen" on Android/desktop
// installed a generic browser tile instead of the app's own icon and name.
//
// A route rather than a static public/manifest.webmanifest, for the same
// reason robots.txt and sitemap.xml are routes and not static files: `name`
// and `description` come from runtime config (NUXT_PUBLIC_APP_NAME /
// NUXT_PUBLIC_APP_DESCRIPTION), which differs per fork and per environment —
// a static file would need `bun run rename` to also rewrite JSON, and would
// say "My App" in every preview deploy until someone remembered to.
//
// theme_color/background_color are the one part that can NOT follow runtime
// config: a manifest has no color mode, so `--ui-primary` (which flips
// between light and dark) isn't a valid source for a key that has to pick
// one value. They're resolved the same way the PNG icons are — from
// DESIGN.md › Brand mark › Color roles, at `bun run brand:generate` time —
// and imported from the generated shared/utils/brand-colors.generated.ts.
// Never hand-write a hex here; regenerate it instead.
import { BRAND_MANIFEST_COLORS } from '#shared/utils/brand-colors.generated'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  const manifest = {
    name: config.public.appName,
    short_name: config.public.appName,
    description: config.public.appDescription,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BRAND_MANIFEST_COLORS.backgroundColor,
    theme_color: BRAND_MANIFEST_COLORS.themeColor,
    icons: [
      // "any maskable" on one entry rather than two: both icons were
      // generated with the maskable safe zone already respected (see
      // scripts/generate-brand-assets.ts › MASKABLE_COVERAGE), so they are
      // equally correct read either way.
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }

  setResponseHeader(event, 'Content-Type', 'application/manifest+json')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return JSON.stringify(manifest, null, 2)
})
