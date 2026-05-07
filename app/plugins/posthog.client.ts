// PostHog product analytics + session replay + exception tracking.
// Client-only — `.client.ts` suffix prevents this from running on the server.
//
// Configure via runtime config (see nuxt.config.ts):
//   - public.posthogKey    → NUXT_PUBLIC_POSTHOG_KEY
//   - public.posthogHost   → NUXT_PUBLIC_POSTHOG_HOST (default: https://us.i.posthog.com)
//
// The project API key (phc_…) is designed to be public — safe to ship in the
// client bundle and to commit to wrangler.toml [vars]. Do NOT use the personal
// API key here; that one is server-side only.
//
// To enable: set posthogKey in nuxt.config.ts (or NUXT_PUBLIC_POSTHOG_KEY env)
// to your project's phc_… key. With an empty key the plugin no-ops cleanly.

import posthog from 'posthog-js'

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const key = config.public.posthogKey
  const host = config.public.posthogHost || 'https://us.i.posthog.com'

  if (!key) return

  posthog.init(key, {
    api_host: host,
    person_profiles: 'identified_only',
    // Manual pageview capture below — Nuxt's SPA router doesn't emit the
    // navigation events posthog-js listens for by default.
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: true,
    capture_exceptions: true,
    session_recording: {
      maskAllInputs: true,
      // Add `data-private` to any element whose text shouldn't be recorded.
      maskTextSelector: '[data-private]',
    },
    loaded: (ph) => {
      // Don't pollute production analytics with dev traffic.
      if (import.meta.dev) ph.opt_out_capturing()
    },
  })

  const router = useRouter()
  router.afterEach((to) => {
    nextTick(() => {
      posthog.capture('$pageview', { $current_url: to.fullPath })
    })
  })

  // Tie events to the authenticated user when a session exists; reset on logout.
  const { user } = useUserSession()
  watch(
    () => user.value,
    (u) => {
      if (u && 'id' in u && u.id != null) {
        posthog.identify(String(u.id), {
          email: 'email' in u ? u.email : undefined,
          name: 'name' in u ? u.name : undefined,
          role: 'role' in u ? u.role : undefined,
        })
      } else {
        posthog.reset()
      }
    },
    { immediate: true },
  )

  return {
    provide: { posthog },
  }
})
