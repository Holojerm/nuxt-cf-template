// The pwa layer: a service worker (GET /sw.js), the page it shows when a
// navigation fails for want of a network (GET /offline), Web Push sent from
// the Worker (`sendPush`), and the install and notification settings for one
// device. Core already serves the manifest and the icons.
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
//   NUXT_PUBLIC_PWA_VAPID_PUBLIC_KEY   push: the key browsers subscribe with
//   NUXT_PWA_VAPID_PRIVATE_KEY         push: its private half, a secret
//   NUXT_PWA_VAPID_SUBJECT             push: who a push service contacts; defaults to appUrl
export default defineNuxtConfig({
  $meta: { name: 'pwa' },
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
        vapidPublicKey: '',
      },
    },
  },
})
