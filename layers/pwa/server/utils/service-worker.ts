// The service worker, as a function. GET /sw.js sends its source with the
// config filled in (renderServiceWorker), and the tests call it with a fake
// scope. So `serviceWorker` must read nothing outside its own body: whatever
// it closed over would be missing in the browser.
//
// It answers navigations only. Each goes to the network, and the offline page
// is the answer when the network gives none. Nothing a signed-in person sees is
// ever written to a cache.
//
// It also shows the notifications `sendPush` sends (server/utils/push.ts) and
// takes a click on one to the page it is about.

import { PWA_CACHE_PREFIX } from '../../shared/utils/pwa-cache'

/** What the worker uses of `ServiceWorkerGlobalScope`. Neither the DOM nor the Workers types have it. */
export interface ServiceWorkerScope {
  addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationClickEvent) => void,
  ): void
  caches: {
    open(name: string): Promise<{
      add(url: string): Promise<void>
      match(url: string): Promise<unknown>
    }>
    keys(): Promise<string[]>
    delete(name: string): Promise<boolean>
  }
  fetch(request: unknown): Promise<unknown>
  skipWaiting(): Promise<void>
  clients: {
    claim(): Promise<void>
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>
    openWindow(url: string): Promise<unknown>
  }
  registration: {
    navigationPreload?: { enable(): Promise<void> }
    showNotification(
      title: string,
      options: { body: string; icon: string; badge: string; data: { url: string } },
    ): Promise<void>
  }
  /** The worker's own URL, which every notification link is resolved against. */
  location: { href: string; origin: string }
}

interface WindowClient {
  url: string
  focus(): Promise<unknown>
}

interface LifecycleEvent {
  waitUntil(work: Promise<unknown>): void
}

interface FetchEvent {
  request: { mode: string }
  /** Set once navigation preload is on; resolves to nothing where it is not supported. */
  preloadResponse?: Promise<unknown>
  respondWith(response: Promise<unknown>): void
}

interface PushEvent extends LifecycleEvent {
  /** Null for a push with no payload. */
  data: { json(): unknown } | null
}

interface NotificationClickEvent extends LifecycleEvent {
  notification: { close(): void; data?: { url?: unknown } }
}

export interface ServiceWorkerConfig {
  /** One cache per deploy, named with this prefix; the rest are deleted on activate. */
  cachePrefix: string
  /** Differs per deploy, so each one installs a new worker and a fresh offline page. */
  version: string
  /** The offline page's URL, `app.baseURL` included. */
  offlineUrl: string
  /** The title of a notification whose message carried none. */
  appName: string
  /** Where a notification with no usable link goes: `app.baseURL`. */
  homeUrl: string
  /** The icon on every notification, `app.baseURL` included. */
  iconUrl: string
}

export function serviceWorker(scope: ServiceWorkerScope, config: ServiceWorkerConfig): void {
  const cacheName = config.cachePrefix + config.version

  scope.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(cacheName)
        await cache.add(config.offlineUrl)
        // Safe to take over at once: pages come from the network, so an old
        // page never meets a new worker's cache.
        await scope.skipWaiting()
      })(),
    )
  })

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await scope.caches.keys()) {
          if (name.startsWith(config.cachePrefix) && name !== cacheName) {
            await scope.caches.delete(name)
          }
        }
        // Without preload every navigation waits for this worker to start.
        await scope.registration.navigationPreload?.enable()
        await scope.clients.claim()
      })(),
    )
  })

  scope.addEventListener('fetch', (event) => {
    if (event.request.mode !== 'navigate') return
    event.respondWith(
      (async () => {
        try {
          return (await event.preloadResponse) ?? (await scope.fetch(event.request))
        } catch (error) {
          // Only a failed fetch lands here. A 404 or 500 is an answer and goes through.
          const cache = await scope.caches.open(cacheName)
          const offline = await cache.match(config.offlineUrl)
          if (offline) return offline
          throw error
        }
      })(),
    )
  })

  // A push must end in a notification: browsers revoke the subscription of a
  // worker that receives pushes and shows nothing. So a message that cannot be
  // read still shows one, under the app's name.
  scope.addEventListener('push', (event) => {
    let message: { title?: unknown; body?: unknown; url?: unknown } = {}
    try {
      const data: unknown = event.data?.json()
      if (data && typeof data === 'object') message = data
    } catch {
      // Not JSON. Fall through to the bare notification.
    }
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    event.waitUntil(
      scope.registration.showNotification(text(message.title) || config.appName, {
        body: text(message.body),
        icon: config.iconUrl,
        badge: config.iconUrl,
        data: { url: text(message.url) || config.homeUrl },
      }),
    )
  })

  scope.addEventListener('notificationclick', (event) => {
    event.notification.close()
    event.waitUntil(
      (async () => {
        // The link came from our own server, but a notification is still not
        // allowed to take anyone off this site.
        let target = new URL(config.homeUrl, scope.location.href)
        const link = event.notification.data?.url
        if (typeof link === 'string' && link) {
          try {
            const asked = new URL(link, scope.location.href)
            if (asked.origin === scope.location.origin) target = asked
          } catch {
            // Unparseable: home it is.
          }
        }
        const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const open = windows.find((client) => client.url === target.href)
        if (open) await open.focus()
        else await scope.clients.openWindow(target.href)
      })(),
    )
  })
}

/** The script GET /sw.js sends. */
export function renderServiceWorker(config: Omit<ServiceWorkerConfig, 'cachePrefix'>): string {
  const filled: ServiceWorkerConfig = { cachePrefix: PWA_CACHE_PREFIX, ...config }
  // Wrangler bundles with esbuild's keepNames, which wraps a named inner
  // function in `__name(…)`: a helper that exists in the Worker's bundle and
  // not in the browser. Defined here so such a function cannot break the script.
  return `const __name = (fn) => fn;\n(${serviceWorker.toString()})(self, ${JSON.stringify(filled)})\n`
}
