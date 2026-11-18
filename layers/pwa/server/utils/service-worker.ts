// The service worker, as a function. GET /sw.js sends its source with the
// config filled in (renderServiceWorker), and the tests call it with a fake
// scope. So `serviceWorker` must read nothing outside its own body: whatever
// it closed over would be missing in the browser.
//
// It answers navigations only. Each goes to the network, and the offline page
// is the answer when the network gives none. Nothing a signed-in person sees is
// ever written to a cache.

import { PWA_CACHE_PREFIX } from '../../shared/utils/pwa-cache'

/** What the worker uses of `ServiceWorkerGlobalScope`. Neither the DOM nor the Workers types have it. */
export interface ServiceWorkerScope {
  addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void
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
  clients: { claim(): Promise<void> }
  registration: { navigationPreload?: { enable(): Promise<void> } }
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

export interface ServiceWorkerConfig {
  /** One cache per deploy, named with this prefix; the rest are deleted on activate. */
  cachePrefix: string
  /** Differs per deploy, so each one installs a new worker and a fresh offline page. */
  version: string
  /** The offline page's URL, `app.baseURL` included. */
  offlineUrl: string
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
}

/** The script GET /sw.js sends. */
export function renderServiceWorker(config: Omit<ServiceWorkerConfig, 'cachePrefix'>): string {
  const filled: ServiceWorkerConfig = { cachePrefix: PWA_CACHE_PREFIX, ...config }
  // Wrangler bundles with esbuild's keepNames, which wraps a named inner
  // function in `__name(…)`: a helper that exists in the Worker's bundle and
  // not in the browser. Defined here so such a function cannot break the script.
  return `const __name = (fn) => fn;\n(${serviceWorker.toString()})(self, ${JSON.stringify(filled)})\n`
}
