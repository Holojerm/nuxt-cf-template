// The pwa layer: a service worker (GET /sw.js), the page it shows when a
// navigation fails for want of a network (GET /offline), and the client plugin
// that registers it. Core already serves the manifest and the icons.
//
// Expects the app to provide core's `withBase` (server/utils/manifest.ts) and
// the generated brand colours. Auto-registered because it lives under layers/.
// Docs: .claude/docs/pwa.md.
//
// Set in the app's own nuxt.config, or by env, never by editing this file:
//   NUXT_PUBLIC_PWA_ENABLED         false retires the worker on each visitor's next visit
//   NUXT_PUBLIC_PWA_OFFLINE_TITLE   the offline page's heading
//   NUXT_PUBLIC_PWA_OFFLINE_BODY    the sentence under it
//   NUXT_PUBLIC_PWA_OFFLINE_RETRY   the link that loads the page again
export default defineNuxtConfig({
  $meta: { name: 'pwa' },
  runtimeConfig: {
    public: {
      pwa: {
        enabled: true,
        offlineTitle: 'You are offline',
        offlineBody: 'This page needs a connection. Check yours, then try again.',
        offlineRetry: 'Try again',
      },
    },
  },
})
