// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // Nuxt 4 compatibility
  future: {
    compatibilityVersion: 4,
  },

  // DESIGN.md › Accessibility. Neither of these is expressible as a design token,
  // so /design-sync doesn't own them — they live here.
  //   lang:        without it a screen reader guesses the document language (WCAG 3.1.1).
  //   viewport-fit: what makes env(safe-area-inset-*) resolve to anything but 0 on
  //                iOS. The `bottom-safe` / `right-safe` utilities in main.css are
  //                inert without it.
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
    },
  },

  modules: ['@nuxt/ui', '@nuxthub/core', 'nuxt-auth-utils', 'nuxt-mcp'],

  // NuxtUI v4 requires this CSS entry — without it, Tailwind utilities and
  // NuxtUI semantic tokens (text-foreground, bg-background, etc.) won't apply
  // and pages render unstyled. See app/assets/css/main.css.
  css: ['~/assets/css/main.css'],

  // NuxtHub — Cloudflare D1, KV, R2, and Blob bindings
  hub: {
    db: 'sqlite', // D1 SQLite via Drizzle (auto-imports `db` and `schema` in server routes)
    kv: true, // KV store
    blob: true, // R2 object storage
    cache: true, // Cache layer
  },

  // NuxtUI v4 + Tailwind v4
  ui: {
    // Customize your design system here
    // colors: { primary: 'blue', neutral: 'slate' }
  },

  // TypeScript — follow Vite/Nuxt recommended defaults
  typescript: {
    strict: true,
    typeCheck: true,
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

  hooks: {
    // /design-system is the dev-only style guide (app/pages/design-system.vue)
    // used to verify DESIGN.md changes actually landed. Strip it from the
    // production route table so it never ships to users.
    'pages:extend'(pages) {
      if (process.env.NODE_ENV !== 'production') return
      const index = pages.findIndex((page) => page.path === '/design-system')
      if (index !== -1) pages.splice(index, 1)
    },
  },

  // Runtime config — public vars go in public, secrets stay private
  runtimeConfig: {
    // Server-only secrets (access via useRuntimeConfig().mySecret)
    // Set via NUXT_SESSION_PASSWORD env var — Nuxt reads it automatically
    sessionPassword: '',
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
    oauth: {
      github: { clientId: '', clientSecret: '' },
      google: { clientId: '', clientSecret: '' },
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
      // Set false on preview deploys so robots.txt disallows everything and an
      // ephemeral URL never competes with production in the index.
      indexable: true,
      // Shown on /terms and /privacy and used as the Reply-To on transactional
      // email. A legal page with no way to reach a human is not a legal page.
      supportEmail: 'support@example.com',
      // Legal entity named in /terms and /privacy. Your company, not your app.
      legalEntity: 'My Company Ltd',
    },
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
