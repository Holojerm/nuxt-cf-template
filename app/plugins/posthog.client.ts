// PostHog product analytics + session replay + exception tracking + heatmaps
// + web vitals + dead-click detection. Client-only — `.client.ts` suffix
// prevents this from running on the server.
//
// Configure via runtime config (see nuxt.config.ts):
//   - public.posthogKey    → NUXT_PUBLIC_POSTHOG_KEY
//   - public.posthogHost   → NUXT_PUBLIC_POSTHOG_HOST (used by the server-side
//                            capture util only; the browser SDK talks to
//                            `/ingest` which is reverse-proxied to PostHog by
//                            server/routes/ingest/[...path].ts).
//
// The project API key (phc_…) is designed to be public — safe to ship in the
// client bundle and to commit to wrangler.toml [vars]. Do NOT use the personal
// API key here; that one is server-side only.
//
// To enable: set posthogKey in nuxt.config.ts (or NUXT_PUBLIC_POSTHOG_KEY env)
// to your project's phc_… key. With an empty key the plugin no-ops cleanly.

import posthog from 'posthog-js'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const key = config.public.posthogKey

  if (!key) return

  posthog.init(key, {
    // Same-origin reverse proxy — defeats ad blockers that drop *.posthog.com.
    // The /ingest/* route in server/routes proxies to us.i.posthog.com.
    api_host: '/ingest',
    // ui_host is where "view in PostHog" links resolve to (the dashboard).
    ui_host: 'https://us.posthog.com',

    person_profiles: 'identified_only',

    // Manual pageview capture below — Nuxt's SPA router doesn't emit the
    // navigation events posthog-js listens for by default.
    capture_pageview: false,
    capture_pageleave: true,

    // Maximum-feedback toggles. Each one is independently useful:
    autocapture: true, // every click, form submit, change event
    capture_exceptions: true, // window.onerror + unhandled rejections
    capture_performance: true, // web vitals (LCP, CLS, INP) + resource timing
    capture_dead_clicks: true, // clicks that produced no DOM change (UX signal)
    enable_heatmaps: true, // mouse-position heatmap data on every page

    // Surveys (NPS, CSAT, "why did you cancel?") are on by default and fetch
    // their config + surveys.js through the same /ingest proxy — create one in
    // the PostHog dashboard and it appears with no deploy. Surveys are the
    // *asking* half of feedback; app/components/Feedback/FeedbackWidget.vue →
    // POST /api/feedback is the *telling* half, and lands in your own D1.

    session_recording: {
      maskAllInputs: true,
      // Add `data-private` to any element whose text shouldn't be recorded.
      maskTextSelector: '[data-private]',
      recordCrossOriginIframes: false,
    },
    enable_recording_console_log: true, // include console.* in replays

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

  // Vue runtime errors → PostHog. window.onerror (covered by
  // `capture_exceptions`) misses errors swallowed by Vue's error boundary, so
  // we hook the Vue handler too.
  nuxtApp.vueApp.config.errorHandler = (err, instance, info) => {
    const error = err instanceof Error ? err : new Error(String(err))
    posthog.captureException(error, {
      vue_component: instance?.$options?.name || instance?.$options?.__name,
      vue_info: info,
    })
    if (import.meta.dev) console.error(err)
  }

  // Tie events to the authenticated user when a session exists; reset on
  // logout. Sign-in/sign-out *events* are best fired server-side from your
  // auth callbacks (see server/utils/posthog.ts) so they can attach the auth
  // method (`google_oauth`, etc.).
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
