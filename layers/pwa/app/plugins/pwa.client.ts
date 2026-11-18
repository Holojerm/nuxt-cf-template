// Registers the service worker once the app is idle, or retires it when the
// layer is switched off: an installed worker outlives the code that put it
// there, so "off" has to reach the browsers that already have one.
import { PWA_CACHE_PREFIX } from '../../shared/utils/pwa-cache'

export default defineNuxtPlugin(() => {
  if (!('serviceWorker' in navigator)) return
  const config = useRuntimeConfig()
  const scope = config.app.baseURL

  onNuxtReady(async () => {
    try {
      if (config.public.pwa.enabled) {
        await navigator.serviceWorker.register(`${scope}sw.js`, { scope })
        return
      }
      const registration = await navigator.serviceWorker.getRegistration(scope)
      if (!registration) return
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
