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

  // DevTools
  devtools: { enabled: true },

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
