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
// The actual building — including joining every URL-shaped field onto
// `app.baseURL`, for a fork deployed under a sub-path — lives in
// server/utils/manifest.ts, unit-tested by test/manifest.test.ts. This route
// is deliberately thin: it reads config and calls buildManifest().
import { buildManifest } from '../utils/manifest'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  const manifest = buildManifest({
    baseURL: config.app.baseURL,
    appName: config.public.appName,
    appDescription: config.public.appDescription,
  })

  setResponseHeader(event, 'Content-Type', 'application/manifest+json')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return JSON.stringify(manifest, null, 2)
})
