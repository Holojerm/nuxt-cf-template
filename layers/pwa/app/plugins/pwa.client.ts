// Registers the service worker once the app is idle, or retires it when the
// layer is switched off: an installed worker outlives the code that put it
// there, so "off" has to reach the browsers that already have one. Also starts
// watching for the install prompt, drops this browser's push subscription once
// nobody is signed in, deletes every personal copy when the signed-in account
// changes, and sends the outbox when there is a connection to send it on.
import {
  PWA_CACHE_PREFIX,
  PWA_OUTBOX_TAG,
  PWA_PERSONAL_CACHE_PREFIX,
} from '../../shared/utils/pwa-cache'

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const scope = config.app.baseURL
  // Before the worker check: an embedded iOS browser has no service worker and
  // still needs to be told about the Home Screen.
  if (config.public.pwa.enabled) trackPwaInstall()

  // Not behind the worker check or the switch: the outbox is the page's own,
  // and what one account left on the device goes whether or not a worker runs.
  const { user } = useUserSession()
  const outbox = useOutbox()
  const owner = () => user.value?.id ?? null
  const settle = async (now: string | null, before: string | null) => {
    try {
      await settlePwaOwner(now, before)
      await outbox.refresh()
      if (now) await outbox.flush()
    } catch (error) {
      // IndexedDB or the caches refused. The owner was not recorded, so the
      // next load tries again.
      console.warn('[pwa] personal data not settled', error)
    }
  }
  watch(owner, (now, before) => void settle(now, before))
  onNuxtReady(() => {
    void settle(owner(), null)
    window.addEventListener('online', () => void outbox.flush().catch(() => {}))
    // Another tab, or the worker on a Background Sync, changed the queue.
    if (typeof BroadcastChannel !== 'undefined') {
      new BroadcastChannel(PWA_OUTBOX_TAG).onmessage = () => void outbox.refresh().catch(() => {})
    }
  })

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
        if (name.startsWith(PWA_CACHE_PREFIX) || name.startsWith(PWA_PERSONAL_CACHE_PREFIX)) {
          await caches.delete(name)
        }
      }
    } catch (error) {
      // Private windows and embedded browsers can refuse. The app works without it.
      console.warn('[pwa] service worker not registered', error)
    }
  })
})
