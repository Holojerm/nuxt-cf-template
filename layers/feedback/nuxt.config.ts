// The feedback layer: widget, admin queue, /api/feedback routes, and its
// contributions to core (server/plugins/feedback.ts). Expects the app to
// provide core server utils (hash, turnstile, audit, email, extensions) and
// the auth session. Auto-registered because it lives under layers/.
export default defineNuxtConfig({
  $meta: { name: 'feedback' },
})
