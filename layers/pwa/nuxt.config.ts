// The pwa layer: a service worker (GET /sw.js), the page it shows when a
// navigation fails for want of a network (GET /offline), Web Push sent from
// the Worker (`sendPush`), the install and notification settings for one
// device, and, for an app that names routes, pages that open offline and an
// outbox for writes made there (`useOutbox`, `idempotent`). Core already
// serves the manifest and the icons.
//
// Expects the app to provide core's `withBase` (server/utils/manifest.ts), the
// generated brand colours, sessions, rate limiting and the extension seams.
// Auto-registered because it lives under layers/. Docs: .claude/docs/pwa.md.
//
// Set in the app's own nuxt.config, or by env, never by editing this file:
//   NUXT_PUBLIC_PWA_ENABLED            false retires the worker on each visitor's next visit
//   NUXT_PUBLIC_PWA_OFFLINE_TITLE      the offline page's heading
//   NUXT_PUBLIC_PWA_OFFLINE_BODY       the sentence under it
//   NUXT_PUBLIC_PWA_OFFLINE_RETRY      the link that loads the page again
//   NUXT_PUBLIC_PWA_OFFLINE_ROUTES     paths whose pages open offline, e.g. ["/training"]
//   NUXT_PUBLIC_PWA_OFFLINE_API        paths whose GET responses those pages need
//   NUXT_PUBLIC_PWA_VAPID_PUBLIC_KEY   push: the key browsers subscribe with
//   NUXT_PWA_VAPID_PRIVATE_KEY         push: its private half, a secret
//   NUXT_PWA_VAPID_SUBJECT             push: who a push service contacts; defaults to appUrl
export default defineNuxtConfig({
  $meta: { name: 'pwa' },
  hooks: {
    // /pwa-example is the dev-only worked example of an offline route and the
    // outbox (app/pages/pwa-example.vue), and what the layer's browser spec
    // drives. Its API routes answer 404 outside `nuxt dev` on their own.
    'pages:extend'(pages) {
      if (process.env.NODE_ENV !== 'production') return
      const index = pages.findIndex((page) => page.path === '/pwa-example')
      if (index !== -1) pages.splice(index, 1)
    },
  },
  runtimeConfig: {
    pwa: {
      // Both VAPID keys or neither. With either missing, nobody can subscribe
      // and sendPush() does nothing.
      vapidPrivateKey: '',
      vapidSubject: '',
    },
    public: {
      pwa: {
        enabled: true,
        offlineTitle: 'You are offline',
        offlineBody: 'This page needs a connection. Check yours, then try again.',
        offlineRetry: 'Try again',
        // Both empty = the worker keeps nothing but the offline page.
        offlineRoutes: [] as string[],
        offlineApi: [] as string[],
        vapidPublicKey: '',
      },
    },
  },
})
