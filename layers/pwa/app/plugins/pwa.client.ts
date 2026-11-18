// Registers the service worker once the app is idle, or retires it when the
// layer is switched off: an installed worker outlives the code that put it
// there, so "off" has to reach the browsers that already have one. Also starts
// watching for the install prompt, and drops this browser's push subscription
// once nobody is signed in.
import { PWA_CACHE_PREFIX } from '../../shared/utils/pwa-cache'

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const scope = config.app.baseURL
  // Before the worker check: an embedded iOS browser has no service worker and
  // still needs to be told about the Home Screen.
  if (config.public.pwa.enabled) trackPwaInstall()
  if (!('serviceWorker' in navigator)) return

  if (config.public.pwa.enabled) {
    const { loggedIn } = useUserSession()
    watch(loggedIn, (signedIn) => {
      if (!signedIn) void releasePushSubscriptionIfSignedOut(scope)
    })
    onNuxtReady(() => {
      if (!loggedIn.value) void releasePushSubscriptionIfSignedOut(scope)
    })
  }

  onNuxtReady(async () => {
    try {
      if (config.public.pwa.enabled) {
        await navigator.serviceWorker.register(`${scope}sw.js`, { scope })
        return
      }
      const registration = await navigator.serviceWorker.getRegistration(scope)
      if (!registration) return
      // Unregistering ends its push subscription too.
      await registration.unregister()
      for (const name of await caches.keys()) {
        if (name.startsWith(PWA_CACHE_PREFIX)) await caches.delete(name)
      }
    } catch (error) {
      // Private windows and embedded browsers can refuse. The app works without it.
      console.warn('[pwa] service worker not registered', error)
    }
  })
})
