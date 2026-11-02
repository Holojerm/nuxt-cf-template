// The feedback layer: widget, admin queue, /api/feedback routes, and its
// contributions to core (server/plugins/feedback.ts). Expects the app to
// provide core server utils (hash, turnstile, audit, email, extensions) and
// the auth session. Auto-registered because it lives under layers/.
//
// Options live in runtimeConfig so an app sets them in its own nuxt.config
// instead of editing this vendored layer (see feedback-extensions.ts).
export default defineNuxtConfig({
  $meta: { name: 'feedback' },
  runtimeConfig: {
    feedback: {
      anonymiseUserId: false,
      deletionCountKey: '',
    },
  },
})
