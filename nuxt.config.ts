// https://nuxt.com/docs/api/configuration/nuxt-config
import { useNitro, useNuxt } from '@nuxt/kit'

import type { PublicPage } from './shared/utils/site'

// ─── Security headers ────────────────────────────────────────────────────────
//
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
const isDev = process.env.NODE_ENV !== 'production'

const CSP: Record<string, string[]> = {
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
  // Paddle's CDN and Turnstile's, so an injected `<script src="//evil.tld/x.js">`
  // does not load. Paired with object-src/base-uri below, the classic bypasses
  // stay shut. test/csp/ pins that list to exactly those two vendors.
  'script-src': ["'self'", "'unsafe-inline'", ...PADDLE.cdn, ...TURNSTILE],

  // Vue SSR emits inline style attributes and Vite dev injects <style> blocks;
  // there is no build flag that stops either. Paddle's overlay pulls
  // assets/css/paddle.css from its CDN (verified: that file has no @font-face
  // and no url(), so it drags nothing else in with it).
  'style-src': ["'self'", "'unsafe-inline'", ...PADDLE.cdn],

  // data: because the @nuxt/icon client bundle inlines icons as
  // `mask-image: url("data:image/svg+xml,…")`, which is img-src, not style-src.
  // The two avatar hosts are where `users.avatar_url` comes from — GitHub's
  // profile CDN and Google's, which shards across *.googleusercontent.com.
  // Paddle's CDN serves the overlay's images plus a health-check.gif.
  'img-src': [
    "'self'",
    'data:',
    ...PADDLE.cdn,
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
  'connect-src': ["'self'", ...PADDLE.api],

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
  'frame-src': [...PADDLE.cdn, ...PADDLE.checkout, ...TURNSTILE, ...(isDev ? ["'self'"] : [])],

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

const contentSecurityPolicy = Object.entries(CSP)
  .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
  .join('; ')

const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy,
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
}

export default defineNuxtConfig({
  // Nuxt 4 compatibility
  future: {
    compatibilityVersion: 4,
  },

  modules: [
    '@nuxt/ui',
    '@nuxthub/core',
    // The blog. Markdown in content/, parsed at build time into SQL, queried at
    // runtime out of D1 — see the `content` block further down for which
    // database that is and why. Registering it also makes @nuxt/ui register its
    // Prose* components globally, which is what gives rendered markdown the
    // DESIGN.md type scale without a stylesheet of our own.
    '@nuxt/content',
    'nuxt-auth-utils',
    // nuxt-mcp rewrites `.mcp.json` — a *tracked* file — with the live dev
    // server URL every time a dev server boots. Helpful when you started that
    // server yourself; destructive in automation, because `bun run test:a11y`
    // boots one too. An agent or CI run would finish with a dirty tree, and a
    // `git add -A` would sweep a throwaway port into the commit, clobbering the
    // `my-app.localhost` URL that `bun run rename` is responsible for.
    //
    // Gated on the same signal the a11y suite already sets. Options go in the
    // array form because nuxt-mcp registers `configKey: 'mcp'` without
    // augmenting `@nuxt/schema`, so a top-level `mcp:` key would not typecheck.
    ['nuxt-mcp', { updateConfig: process.env.NUXT_DEVTOOLS === 'false' ? false : 'auto' }],
    // Cloudflare Turnstile. Registered with no options on purpose: the module's
    // own defaults hand `nuxt dev` Cloudflare's always-passing TEST keys, and
    // the explicit empty `turnstile` entries in runtimeConfig below override
    // them (defu keeps a value already present on the config). So the template
    // renders no widget and verifies nothing until a real key is set — the same
    // "runs without an account" posture as Resend and Paddle, and identical in
    // dev and production rather than only in one of them.
    //
    // Expect one build-time warning, "No site key was provided." That is the
    // module telling you which env var to set; a template that ships without a
    // Turnstile account cannot make it go away without pretending to have one.
    '@nuxtjs/turnstile',
  ],

  // NuxtUI v4 requires this CSS entry — without it, Tailwind utilities and
  // NuxtUI semantic tokens (text-foreground, bg-background, etc.) won't apply
  // and pages render unstyled. See app/assets/css/main.css.
  css: ['~/assets/css/main.css'],

  // Document-level defaults every page inherits.
  app: {
    head: {
      // Nuxt does not set this for you. Without it, screen readers guess the
      // pronunciation and translation tools guess the source language — and
      // Google treats a missing lang as a weak signal about who the page is for.
      htmlAttrs: { lang: 'en' },
      // viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
      // anything but 0 on iOS — the `bottom-safe` / `right-safe` utilities in
      // main.css are inert without it (DESIGN.md › Accessibility › Viewport).
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      // Deliberately no `theme-color`: the correct value is the page
      // background, which lives in the token layer and differs per color mode.
      // Hardcoding a hex here would bypass DESIGN.md and be wrong in the dark.
      //
      // manifest.webmanifest's own `theme_color` is not the same decision
      // reversed. A manifest has no color mode either — same as a PNG — so it
      // isn't picking a light-vs-dark value out of the token layer; it's
      // reading DESIGN.md › Brand mark › Color roles (`manifest-theme`,
      // resolved at `bun run brand:generate` time, same pipeline as the
      // icons) the one time a fixed brand color is actually correct: the
      // launcher chrome Android paints once this is installed as an app.
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
      ],
    },
  },

  // NuxtHub — Cloudflare D1, KV, R2, and Blob bindings
  hub: {
    db: 'sqlite', // D1 SQLite via Drizzle (auto-imports `db` and `schema` in server routes)
    kv: true, // KV store
    blob: true, // R2 object storage
    cache: true, // Cache layer
  },

  // ─── Blog content (@nuxt/content v3) ───────────────────────────────────────
  //
  // Content v3 does not ship markdown to the client; it parses content/ at
  // build time into SQL and queries it at runtime. A Worker has no filesystem,
  // so on Cloudflare that store has to be D1.
  //
  // WHICH D1. This points at the app's own `DB` binding rather than a second
  // `CONTENT_DB`, and that is a deliberate trade:
  //
  //   * Cost of sharing: content creates its own `_content_info` and
  //     `_content_blog` tables inside the app's database. Drizzle never sees
  //     them — `drizzle-kit generate` diffs schema.ts against its own snapshot
  //     in server/db/migrations/meta, not against the live database, and
  //     `wrangler d1 migrations apply` only runs the files in that directory
  //     and records them in its own `d1_migrations` table. So `bun db:generate`
  //     will not try to drop these, and `bun db:migrate` will not try to create
  //     them. (`drizzle-kit push`, which DOES diff against a live database,
  //     is not wired up here — keep it that way, or exclude `_content_*`.)
  //   * Cost of not sharing: a second `[[d1_databases]]` block with a
  //     placeholder id, which every fork must replace with a real database
  //     before `wrangler deploy` will even accept the config. That is a second
  //     setup step, on the deploy path, to isolate three markdown files.
  //
  // Sharing wins at this size. If the blog ever grows into something with real
  // write traffic, split it: create the database, add the binding, and change
  // `bindingName` here — nothing else in the app reads these tables.
  //
  // NO MIGRATION STEP. Unlike the app's own schema (CLAUDE.md › Gotchas:
  // "Nothing applies migrations to production D1"), the content tables need no
  // `db:migrate:remote`. The build writes a compressed SQL dump into the
  // Worker's static assets, and the first request after a deploy compares its
  // checksum against `_content_info` and imports it if they differ. That is
  // content's `integrityCheck`, and it stays on precisely because we deploy
  // with wrangler: NuxtHub's own "apply queries during build" path is disabled
  // for the d1 driver, and it would not reach the remote database anyway.
  //
  // DEV AND BUILD both ignore the setting above: parsing content, and every
  // `nuxt dev` query, run against a local SQLite file in .data/ instead. Which
  // SQLite is the `sqliteConnector` below, and it is not optional here.
  //
  // The module's default is `better-sqlite3` — a native module this repo does
  // not have, which it tries to install by *prompting on stdin*. Under `bun
  // run` that is not a prompt, it is a crash: consola cannot open a TTY, and
  // `nuxt prepare` dies in postinstall with `uv_tty_init returned EINVAL`.
  // Observed on a clean install here, before this line existed.
  //
  // `native` is `node:sqlite` — nothing to install, nothing to compile, and
  // Node is the runtime that actually executes the build (`bun run dev` and
  // `bun run build` both shell out to the `nuxt` bin, which has a node shebang,
  // so `process.versions.bun` is undefined inside it and the module's own Bun
  // detection never fires).
  //
  // The floor is **22.13.0**, not the 22.5.0 that first shipped the module:
  // until 22.13 / 23.4 it was behind `--experimental-sqlite`, and this stack has
  // no way to pass that flag. On 22.5–22.12 the module's availability probe
  // simply returns false and falls back to the better-sqlite3 prompt above — so
  // the wrong Node here reads as the same confusing crash, not as a version
  // error. package.json's `engines` and the committed `.node-version` both
  // record it.
  content: {
    database: { type: 'd1', bindingName: 'DB' },
    experimental: { sqliteConnector: 'native' },
  },

  // NuxtUI v4 + Tailwind v4
  ui: {
    // Customize your design system here
    // colors: { primary: 'blue', neutral: 'slate' }
  },

  // TypeScript — follow Vite/Nuxt recommended defaults.
  //
  // typeCheck runs vue-tsc in-process on `nuxt dev`. The a11y suite's dev server
  // sets NUXT_TYPECHECK=false to skip it: `bun run ci` has already run
  // `bun run typecheck` by that point, so doing it again just puts vue-tsc in
  // competition with the cold Vite build for the same CI runner.
  typescript: {
    strict: true,
    typeCheck: process.env.NUXT_TYPECHECK !== 'false',
  },

  // Icons — DESIGN.md › Identity › Iconography. `scan` inlines only the
  // i-lucide-* icons actually used in source into the client bundle, so the
  // Worker never round-trips to the Iconify API to render them. The collection
  // itself comes from the @iconify-json/lucide devDependency.
  icon: {
    clientBundle: { scan: true },
  },

  // DevTools. Disabled when NUXT_DEVTOOLS=false, which the a11y suite sets:
  // the devtools panel injects its own markup into every page, and axe would
  // scan it and report violations that aren't in this app's code.
  devtools: { enabled: process.env.NUXT_DEVTOOLS !== 'false' },

  experimental: {
    // Teach Nuxt's build-time definePageMeta scanner about our own key, so the
    // `pages:resolved` hook below can read it. Without this the key is dropped
    // during extraction and every page looks private.
    extraPageMetaExtractionKeys: ['publicPage'],
  },

  hooks: {
    // /design-system is the dev-only style guide (app/pages/design-system.vue)
    // used to verify DESIGN.md changes actually landed. Strip it from the
    // production route table so it never ships to users.
    'pages:extend'(pages) {
      if (process.env.NODE_ENV !== 'production') return
      const index = pages.findIndex((page) => page.path === '/design-system')
      if (index !== -1) pages.splice(index, 1)
    },

    // Derive sitemap.xml and llms.txt from the route table rather than from
    // hand-kept lists inside the Nitro routes. Pages opt in with
    // `definePageMeta({ publicPage: … })` (app/types/seo.d.ts); anything
    // without that key is absent from both, which is the right default because
    // most pages added to an app are private.
    //
    // Three details this depends on, all of them easy to get subtly wrong:
    //
    //   * `pages:resolved`, not `pages:extend`. Nuxt statically extracts
    //     definePageMeta *between* the two hooks, so `page.meta` is still null
    //     in `pages:extend` — the earlier hook sees every page as unmarked.
    //   * `experimental.extraPageMetaExtractionKeys` above. Without it the
    //     extractor ignores `publicPage` and records only a "there was a
    //     dynamic key here" marker, so this hook silently collects nothing.
    //   * Nitro is already initialised by the time this runs, so setting
    //     `nuxt.options.runtimeConfig` alone is too late — the value is read
    //     from the Nitro instance. Both are set below.
    //
    // Each of those fails by producing an *empty* sitemap rather than an error,
    // which is why test/seo.test.ts asserts the rendering and `bun run ci`
    // builds. If the sitemap ever goes empty, start here.
    'pages:resolved'(pages) {
      const entries: PublicPage[] = []
      const collect = (list: typeof pages) => {
        for (const page of list) {
          const meta = page.meta?.publicPage
          // Dynamic segments have no single URL to publish — a route like
          // /posts/[id] is one pattern, not N pages. Those need a D1 query in
          // server/routes/sitemap.xml.get.ts, not a route-table entry.
          if (meta && page.path && !page.path.includes(':')) {
            entries.push({ path: page.path, ...meta })
          }
          if (page.children?.length) collect(page.children)
        }
      }
      collect(pages)
      entries.sort((a, b) => a.path.localeCompare(b.path))

      useNuxt().options.runtimeConfig.publicPages = entries
      useNitro().options.runtimeConfig.publicPages = entries
    },
  },

  // Runtime config — public vars go in public, secrets stay private
  runtimeConfig: {
    // Server-only secrets (access via useRuntimeConfig().mySecret)
    // Set via NUXT_SESSION_PASSWORD env var — Nuxt reads it automatically
    sessionPassword: '',
    // Filled by the `pages:resolved` hook above from
    // `definePageMeta({ publicPage })`. Server-only: sitemap.xml and llms.txt
    // are the only readers, so it stays out of the client bundle.
    publicPages: [] as PublicPage[],
    // Stamped at build time and used as <lastmod> for every sitemap URL.
    // Per-page dates would be better, but the honest source for those is git
    // history, which CI clones shallowly — a plausible-looking wrong date is
    // worse than a coarse right one, and crawlers discount lastmod that always
    // says "today", which is what `new Date()` at request time produces.
    buildDate: new Date().toISOString().slice(0, 10),
    // Paddle billing (sandbox-first) — set via NUXT_PADDLE_* env vars / secrets
    paddle: {
      // Endpoint secret from Paddle → Developer tools → Notifications
      webhookSecret: '',
      // Server-side API key (only needed if you call Paddle's API, not for webhooks)
      apiKey: '',
    },
    // OAuth providers, read by nuxt-auth-utils' defineOAuth*EventHandler.
    // Declared here (rather than left implicit) so /api/auth/providers can tell
    // the login page which buttons to render — an unconfigured provider dead-ends
    // in a "missing configuration" error instead of a sign-in.
    // Set via NUXT_OAUTH_GITHUB_CLIENT_ID etc.
    //
    // All of these are optional. The primary sign-in path is the magic link
    // (server/api/auth/magic-link.post.ts), which needs no provider at all —
    // only Resend, below. GitHub in particular ships unconfigured on purpose:
    // it is a developer credential, and a consumer sign-in page that leads with
    // it is telling most of its visitors the product isn't for them.
    oauth: {
      // Apple's client secret is an ES256 JWT signed per request, so the config
      // is four values rather than two: `clientId` is the Services ID, and
      // `privateKey` is the .p8 contents with literal newlines written as \n.
      // A real secret — `wrangler secret put`, never wrangler.toml [vars].
      //
      // `redirectURL` is the fifth, and it is REQUIRED for Apple specifically —
      // the only provider here that needs one. nuxt-auth-utils' Apple handler
      // puts the raw value into the token-exchange body instead of falling back
      // to the request's own origin the way the Google and GitHub handlers do,
      // so leaving it empty sends `redirect_uri=undefined` to Apple and the
      // sign-in dies with `invalid_grant` at the very last step. Set
      // NUXT_OAUTH_APPLE_REDIRECT_URL to exactly the Return URL registered with
      // Apple: https://<your-app>/api/auth/apple
      apple: { clientId: '', teamId: '', keyId: '', privateKey: '', redirectURL: '' },
      google: { clientId: '', clientSecret: '' },
      github: { clientId: '', clientSecret: '' },
    },
    // Cloudflare Turnstile (server/utils/turnstile.ts). Set via
    // NUXT_TURNSTILE_SECRET_KEY — the name @nuxtjs/turnstile reads, not one we
    // chose. Empty = requireTurnstile() skips verification, so the template runs
    // without a Turnstile account.
    //
    // Declared here rather than left to the module because the module's dev
    // default is Cloudflare's always-passing test secret, and a challenge that
    // always passes is worse than no challenge: it looks like protection in dev
    // and is not protection anywhere.
    turnstile: {
      secretKey: '',
    },
    // Transactional email (server/utils/email.ts). Empty key = no-op, so the
    // template runs without a Resend account.
    resend: {
      apiKey: '',
      // Must be an address on a domain you've verified in Resend, e.g.
      // "My App <hello@myapp.com>". Anything else is rejected at send time.
      from: '',
    },
    // Public vars (access via useRuntimeConfig().public.myVar)
    // NUXT_PUBLIC_APP_NAME in wrangler.toml [vars] overrides this at runtime
    public: {
      appName: 'My App',
      // One sentence describing the product. Used as the landing page's meta
      // description, as the blockquote in /llms.txt, and as the schema.org
      // description — so an answer engine reads the same claim everywhere
      // rather than three paraphrases it has to reconcile.
      appDescription:
        'A full-stack SaaS template on Nuxt 4 and Cloudflare Workers: auth, billing, email, and analytics already wired together.',
      // PostHog — paste your project's phc_… key here (or set
      // NUXT_PUBLIC_POSTHOG_KEY in env). Public-by-design; ships in the
      // client bundle. Empty key = plugin no-ops, nothing tracked.
      posthogKey: '',
      posthogHost: 'https://us.i.posthog.com',
      // Paddle client-side token (public by design) + environment. Empty
      // token = usePaddle() no-ops, so the template runs without a Paddle account.
      paddleClientToken: '',
      paddleEnv: 'sandbox',
      // Paddle price IDs (pri_…) for the plans on /pricing. Kept in config
      // rather than in app/utils/plans.ts so sandbox and production can point at
      // different prices without a code change. Empty = that plan's button is
      // disabled instead of opening a checkout that 400s.
      paddlePriceMonthly: '',
      paddlePriceYearly: '',
      paddlePricePass: '',
      // The app's canonical public origin, no trailing slash. Absolute links in
      // emails, sitemap.xml, robots.txt, and og: tags are built from this —
      // there is no request context in a webhook to infer it from.
      appUrl: 'http://localhost:3000',
      // Set false on preview deploys so robots.txt disallows everything, every
      // page renders `noindex`, and an ephemeral URL never competes with
      // production in the index.
      indexable: true,
      // Whether AI crawlers and answer-engine fetchers (GPTBot, ClaudeBot,
      // PerplexityBot, Google-Extended, …) may read the public pages.
      //
      // Default true, and deliberately so: for a SaaS marketing site, being
      // quotable by an answer engine is distribution, not theft — these are the
      // crawlers behind ChatGPT Search, Perplexity, and AI Overviews. Set false
      // (NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false) if your public content is the
      // product rather than an advert for it. Either way it is a decision you
      // made, which is the point of the flag.
      allowAiCrawlers: true,
      // Cloudflare Turnstile site key (public by design — it identifies the
      // widget, it does not authorise anything). Set via
      // NUXT_PUBLIC_TURNSTILE_SITE_KEY, the name @nuxtjs/turnstile reads.
      //
      // Empty = <NuxtTurnstile> is never rendered and no challenge script is
      // fetched. Components gate on this value, not on the module being
      // installed, so an unconfigured fork ships zero Turnstile bytes.
      turnstile: {
        siteKey: '',
      },
      // Shown on /terms and /privacy and used as the Reply-To on transactional
      // email. A legal page with no way to reach a human is not a legal page.
      supportEmail: 'support@example.com',
      // Legal entity named in /terms and /privacy. Your company, not your app.
      legalEntity: 'My Company Ltd',
    },
  },

  // Security headers on every response — see the block above nuxt.config's
  // default export for how each CSP source was verified.
  //
  // '/**' rather than a page-only pattern on purpose. The headers are inert on
  // JSON (a CSP does not apply to a fetch response body), so scoping would buy
  // nothing, while the two that DO matter off-document — nosniff on
  // /og.png and HSTS on every API call — are exactly the ones a narrower
  // pattern would drop. It also means a route added later is covered by
  // default rather than by remembering to come back here.
  routeRules: {
    '/**': { headers: securityHeaders },
  },

  // Nitro — Cloudflare Workers preset for production build
  nitro: {
    preset: 'cloudflare_module',
    experimental: {
      // Enable tasks for background jobs (e.g. cron via Cloudflare Workers)
      tasks: true,
    },
  },

  compatibilityDate: '2025-09-01',
})
