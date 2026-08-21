// Types for the runtime config keys the SEO layer adds.
//
// Nuxt infers runtime-config types from the *values* in nuxt.config.ts, and
// `publicPages` starts life as an empty array — which infers as `{}[]` and makes
// every field access on a sitemap entry a type error. The `as PublicPage[]`
// annotation in nuxt.config.ts types the config object, not the generated
// `RuntimeConfig` interface, so the augmentation has to be stated here.
//
// Lives in shared/ because both generated tsconfigs include `shared/**/*.d.ts`,
// and both halves of the app read this config.

import type { PublicPage } from '../utils/site'

declare module 'nuxt/schema' {
  interface RuntimeConfig {
    /** Filled at build time by the `pages:resolved` hook in nuxt.config.ts. */
    publicPages: PublicPage[]
    /** Build stamp used as <lastmod> in sitemap.xml. */
    buildDate: string
  }
}

export {}
