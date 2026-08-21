// https://nuxt.com/docs/api/configuration/nuxt-config
import { useNitro, useNuxt } from '@nuxt/kit'

import type { PublicPage } from './shared/utils/site'

export default defineNuxtConfig({
  // Nuxt 4 compatibility
  future: {
    compatibilityVersion: 4,
  },

  modules: ['@nuxt/ui', '@nuxthub/core', 'nuxt-auth-utils', 'nuxt-mcp'],

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
      // Deliberately no `theme-color`: the correct value is the page
      // background, which lives in the token layer and differs per color mode.
      // Hardcoding a hex here would bypass DESIGN.md and be wrong in the dark.
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
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

  // DevTools
  devtools: { enabled: true },

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
