// https://nuxt.com/docs/api/configuration/nuxt-config
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
    // Public vars (access via useRuntimeConfig().public.myVar)
    // NUXT_PUBLIC_APP_NAME in wrangler.toml [vars] overrides this at runtime
    public: {
      appName: 'My App',
      // PostHog — paste your project's phc_… key here (or set
      // NUXT_PUBLIC_POSTHOG_KEY in env). Public-by-design; ships in the
      // client bundle. Empty key = plugin no-ops, nothing tracked.
      posthogKey: '',
      posthogHost: 'https://us.i.posthog.com',
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
