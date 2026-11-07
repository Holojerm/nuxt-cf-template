// Security headers (CSP and friends) for routeRules in nuxt.config.ts. Lives here, not in
// the config, so test/security-headers.test.ts can assert on the policy without a browser.
// `isDev` is the one dev/prod delta (see frame-src); the vitest side checks the shipped one.

// A CSP that silently breaks analytics or checkout is worse than no CSP: the
// failure is invisible in dev (both vendors no-op without keys), invisible in
// tests, and shows up as "revenue stopped" in production. So every host below
// was derived from something checkable rather than from a blog post, and the
// provenance is recorded next to it. `test/csp/` re-checks the browser half in
// a real Chromium on every `bun run ci`.
//
// Why `routeRules` and not a Nitro middleware: the only thing a middleware buys
// here is a per-request nonce, and we cannot spend one (see `script-src`). What
// it costs is a handler invocation on every request, including the static assets
// Cloudflare would otherwise serve without waking the Worker.

/** Paddle's hosts, read out of the live bundle rather than guessed — see below. */
const PADDLE = {
  cdn: ['https://cdn.paddle.com', 'https://sandbox-cdn.paddle.com'],
  // `checkoutFrontEndBase` + `checkoutBase` from the bundle's env table.
  checkout: [
    'https://buy.paddle.com',
    'https://sandbox-buy.paddle.com',
    'https://create-checkout.paddle.com',
    'https://sandbox-create-checkout.paddle.com',
  ],
  // `apiBase` — fetched by Paddle.js for /pricing-preview and /transactions/preview.
  api: ['https://api.paddle.com', 'https://sandbox-api.paddle.com'],
} as const

/**
 * Cloudflare Turnstile. One host, doing two jobs: `script-src` for the
 * `api.js` loader @nuxtjs/turnstile injects, and `frame-src` for the challenge
 * iframe that loader then mounts. Both are named in Cloudflare's own CSP page
 * (turnstile/reference/content-security-policy) — `connect-src` is listed there
 * too but only for pre-clearance mode, which this app does not use, and 'self'
 * already covers our own verify round-trip.
 *
 * Present even while `turnstile.siteKey` is empty and the widget never renders.
 * A policy that only permits what today's config happens to load is a policy
 * that breaks on the day someone pastes in a key — at which point the widget
 * shows as an empty box with a console error, on the signup form, in production.
 */
const TURNSTILE = ['https://challenges.cloudflare.com'] as const

/**
 * Cloudflare Web Analytics. With it on for the zone (the default for a new
 * site), Cloudflare injects the beacon into every HTML response at the edge, so
 * no code in app/ loads it — and without these hosts every page logs a CSP
 * violation and the dashboard reads zero visits. `script-src` for
 * beacon.min.js, `connect-src` for the /cdn-cgi/rum reports, as listed on
 * Cloudflare's own CSP page. Cookieless; it is named in /privacy under
 * Cloudflare.
 */
const CF_WEB_ANALYTICS = {
  script: ['https://static.cloudflareinsights.com'],
  connect: ['https://cloudflareinsights.com'],
} as const

// `nuxt dev` sets NODE_ENV=development, `nuxt build` sets production.
//
// The dev delta is exactly one source — `frame-src 'self'`, for the Nuxt
// DevTools panel — and keeping it that small is deliberate. The tempting shape
// is "strict in production, off in dev", but test/csp/ runs against
// `bun run dev:app`: every source dev adds is a source the browser suite stops
// checking. One extra entry means the suite still exercises essentially the
// policy that ships.
//
// Everything else Vite dev was assumed to need turned out to be unnecessary —
// see connect-src.

/** Which optional layers shipped. Billing alone adds origins: without it the policy names no Paddle host. */
export type PolicyLayers = { billing: boolean }

const cspSources = (isDev: boolean, { billing }: PolicyLayers): Record<string, string[]> => {
  const paddle = billing ? PADDLE : { cdn: [], checkout: [], api: [] }
  return {
    'default-src': ["'self'"],

    // 'unsafe-inline' is load-bearing, and not something to quietly accept.
    //
    // Nuxt SSR emits two executable inline scripts on every page. The payload is
    // NOT one of them — it ships as `<script type="application/json">`, which the
    // browser never executes and CSP therefore never blocks. The two real ones are
    // @nuxtjs/color-mode's pre-paint FOUC guard (NuxtUI depends on it; removing it
    // makes every page flash the wrong theme) and Nuxt's runtime-config
    // serialization.
    //
    // Neither can be nonced: `routeRules` headers are static strings, and even
    // behind a middleware Nuxt has no API for stamping a nonce onto framework
    // injected script tags — the color-mode guard would stay unnonced and dark
    // mode would break instead.
    //
    // Neither can be safely hashed either, and this is the trap worth naming: the
    // color-mode guard's bytes change when that dependency updates, and the config
    // script's bytes contain `appName` and `appUrl`, so it changes on `bun run
    // rename` and on any [vars] edit. A hash allowlist would ship green through
    // lint, typecheck and this repo's own tests, then white-screen production
    // after a routine `bun update`.
    //
    // What survives: script-src still refuses every *external* origin except
    // Paddle's CDN, Turnstile's and the Web Analytics beacon, so an injected
    // `<script src="//evil.tld/x.js">` does not load. Paired with object-src/
    // base-uri below, the classic bypasses stay shut. test/security-headers.test.ts pins that list.
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...paddle.cdn,
      ...TURNSTILE,
      ...CF_WEB_ANALYTICS.script,
    ],

    // Vue SSR emits inline style attributes and Vite dev injects <style> blocks;
    // there is no build flag that stops either. Paddle's overlay pulls
    // assets/css/paddle.css from its CDN (verified: that file has no @font-face
    // and no url(), so it drags nothing else in with it).
    'style-src': ["'self'", "'unsafe-inline'", ...paddle.cdn],

    // data: because the @nuxt/icon client bundle inlines icons as
    // `mask-image: url("data:image/svg+xml,…")`, which is img-src, not style-src.
    // The two avatar hosts are where `users.avatar_url` comes from — GitHub's
    // profile CDN and Google's, which shards across *.googleusercontent.com.
    // Paddle's CDN serves the overlay's images plus a health-check.gif.
    'img-src': [
      "'self'",
      'data:',
      ...paddle.cdn,
      'https://avatars.githubusercontent.com',
      'https://*.googleusercontent.com',
    ],

    // @nuxt/fonts downloads Inter / Instrument Serif / JetBrains Mono at build
    // time and serves them from /_fonts — there is deliberately no Google Fonts
    // origin here, and if one ever appears it means the build stopped self-hosting.
    'font-src': ["'self'"],

    // PostHog needs no host of its own: the SDK is pinned to `api_host: '/ingest'`
    // and server/routes/ingest/[...path].ts reverse-proxies events, decide, replay
    // snapshots and the SDK's own assets. Adding a *.posthog.com origin here would
    // defeat that proxy (its point is to survive ad blockers) — so if you find
    // yourself reaching for one, fix the proxy instead.
    //
    // No `ws:` for Vite's HMR socket, which is the obvious thing to add here and
    // measurably unnecessary: CSP3 has `'self'` match ws/wss on the document's own
    // host, and dropping it changed nothing in test/csp. It is also not a cheap
    // addition — `ws:` is a bare scheme source, so it would permit a socket to
    // *any* host, which is a strange thing to hand a dev server.
    'connect-src': ["'self'", ...paddle.api, ...CF_WEB_ANALYTICS.connect],

    // The overlay checkout is an iframe into this page, which is frame-src.
    // X-Frame-Options / frame-ancestors govern the opposite direction and do not
    // conflict with it — a common reason people delete one of the two.
    //
    // 'self' in dev is the one genuine dev/prod difference, and it is here to stop
    // this policy from getting itself deleted. Nuxt DevTools mounts its panel in a
    // same-origin iframe (/__nuxt_devtools__/client/), and frame-src does NOT fall
    // back to default-src's 'self' — a same-origin frame is refused unless listed.
    // Worse, a refused iframe still fires `load`, so the panel renders *blank*: it
    // reads as a broken DevTools, not as a CSP decision, and the natural next move
    // is to rip the header out. DevTools does not exist in a production build, so
    // the shipped policy keeps frame-src to Paddle and Turnstile alone.
    'frame-src': [...paddle.cdn, ...paddle.checkout, ...TURNSTILE, ...(isDev ? ["'self'"] : [])],

    // PostHog session replay runs rrweb's packer in a worker built from a Blob
    // (`new Worker(URL.createObjectURL(...))` in posthog-js/dist/recorder.js), so
    // blob: here is the difference between replay working and replay being
    // silently absent from your dashboard.
    'worker-src': ["'self'", 'blob:'],
    // Same blob worker, for Safari < 15.4, which never shipped worker-src and
    // falls back to child-src. Not redundant with frame-src: frame-src is set
    // explicitly above and wins for frames in every browser that has it.
    'child-src': ["'self'", 'blob:'],

    // No <object>/<embed> anywhere in this app, and leaving it open is one of the
    // two standard ways to bypass a script-src that allows 'unsafe-inline'.
    'object-src': ["'none'"],
    // The other one: without this, injected markup can repoint every relative
    // script URL at an attacker's origin.
    'base-uri': ["'self'"],
    // Sign-in is a top-level navigation to /api/auth/<provider> (which then
    // redirects out), not a cross-origin form post — so nothing legitimate here
    // submits off-origin.
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  }
}

// `layers` defaults to the template's own shape. nuxt.config.ts passes what is actually on disk,
// so a fork that removes layers/billing loses the Paddle origins with it — no hand edit to forget.
export const contentSecurityPolicy = (
  isDev: boolean,
  layers: PolicyLayers = { billing: true },
): string =>
  Object.entries(cspSources(isDev, layers))
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ')

export const securityHeaders = (isDev: boolean, layers: PolicyLayers = { billing: true }) => ({
  'Content-Security-Policy': contentSecurityPolicy(isDev, layers),
  // Two years is the preload-list minimum, but `preload` itself is deliberately
  // absent: it is a submission to a browser-vendor registry that ships in binary
  // releases and takes months to reverse. That is the app owner's call to make
  // on their own domain, not a default a template should make for them.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // Full URL to our own origin, origin-only to third parties, nothing at all on
  // an HTTPS→HTTP downgrade. Keeps internal referrers useful in PostHog without
  // leaking gated paths or query strings to Paddle.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Redundant with frame-ancestors for modern browsers, kept for the ones that
  // only understand this. Note it says nothing about the Paddle overlay, which
  // is an iframe *into* this page.
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // Deliberately short. `payment` is the conspicuous omission: Paddle's overlay
  // delegates Apple Pay / Google Pay into its own iframe, and the lazily-loaded
  // checkout chunk (cdn.paddle.com/paddle/v2/paddle.js is only a loader) is what
  // sets that iframe's `allow` attribute — so we cannot verify what it needs
  // from here. `payment=()` is an empty allowlist that an iframe's `allow`
  // cannot re-open, so guessing wrong silently removes the wallet buttons and
  // nothing logs. The default (`payment=self`, delegable) is already correct.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
})
