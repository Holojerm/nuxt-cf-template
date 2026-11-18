// The service worker, as a function. GET /sw.js sends its source with the
// config filled in (renderServiceWorker), and the tests call it with a fake
// scope. So `serviceWorker` must read nothing outside its own body: whatever
// it closed over would be missing in the browser. Its third argument, the
// outbox, is sent the same way and lives by the same rule.
//
// Navigations go to the network, and the offline page is the answer when the
// network gives none. That is all it does until an app names `offlineRoutes`.
// Then pages under those routes, the build files they load and the GET
// responses under `offlineApi` are also kept, and a kept copy is what a failed
// fetch gets. Every copy is personal: the page deletes them all on sign-out
// (`pwa:forget`), and each deploy starts again.
//
// It also shows the notifications `sendPush` sends (server/utils/push.ts),
// takes a click on one to the page it is about, and sends the outbox on a
// Background Sync where the browser has one.

import { outbox as outboxSource } from '../../shared/utils/outbox'
import {
  PWA_CACHE_PREFIX,
  PWA_OUTBOX_TAG,
  PWA_PERSONAL_CACHE_PREFIX,
} from '../../shared/utils/pwa-cache'
import type {
  PwaPersonalCache,
  ServiceWorkerConfig,
  ServiceWorkerScope,
  WorkerFetchEvent,
  WorkerResponse,
} from './service-worker-scope'

export function serviceWorker(
  scope: ServiceWorkerScope,
  config: ServiceWorkerConfig,
  outbox: typeof outboxSource,
): void {
  const cacheName = config.cachePrefix + config.version
  const personal = (kind: PwaPersonalCache) => `${config.personalPrefix}${kind}-${config.version}`
  const current = [cacheName, personal('pages'), personal('data'), personal('assets')]

  // Goes up each time the page says the person is gone. A response that was
  // already on its way then is theirs, and is not kept.
  let epoch = 0
  const puts: Partial<Record<PwaPersonalCache, number>> = {}

  const under = (path: string, prefixes: string[]) =>
    prefixes.some(
      (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
    )

  const forget = async () => {
    epoch += 1
    for (const name of await scope.caches.keys()) {
      if (name.startsWith(config.personalPrefix)) await scope.caches.delete(name)
    }
  }

  const keep = async (kind: PwaPersonalCache, url: string, copy: WorkerResponse, asked: number) => {
    if (asked !== epoch) return
    try {
      const cache = await scope.caches.open(personal(kind))
      await cache.put(url, copy)
      // Trimmed on the first put and every twentieth after it, so the bound is
      // near enough without listing the cache on every response.
      const count = (puts[kind] = (puts[kind] ?? 0) + 1)
      if (count % 20 !== 1) return
      const keys = await cache.keys()
      for (const old of keys.slice(0, Math.max(0, keys.length - config.cacheLimits[kind]))) {
        await cache.delete(old.url)
      }
    } catch {
      // Out of quota, or a response that cannot be stored (`Vary: *`). The
      // page already has its answer.
    }
  }

  const copyOf = async (kind: PwaPersonalCache, url: string) =>
    (await scope.caches.open(personal(kind))).match(url, { ignoreVary: true })

  /**
   * The network's answer, kept under `kind` when it is a good one. When the
   * network gives none: the kept copy, then the offline page for a navigation.
   */
  const answer = async (
    event: WorkerFetchEvent,
    kind: PwaPersonalCache | null,
    navigation: boolean,
  ): Promise<WorkerResponse> => {
    const asked = epoch
    const url = event.request.url
    let response: WorkerResponse
    try {
      response = (await event.preloadResponse) ?? (await scope.fetch(event.request))
    } catch (error) {
      // Only a failed fetch lands here. A 404 or 500 is an answer and goes through.
      const copy = kind && (await copyOf(kind, url))
      if (copy) return copy
      const offline =
        navigation && (await (await scope.caches.open(cacheName)).match(config.offlineUrl))
      if (offline) return offline
      throw error
    }
    if (!kind) return response
    if (response.ok) {
      event.waitUntil(keep(kind, url, response.clone(), asked))
    } else if (response.status === 401 && kind !== 'assets') {
      // The session is over, so nothing kept for it may be shown again.
      event.waitUntil(forget())
    } else if (response.status < 500) {
      // A redirect, a 403, a 404: the copy is no longer what the server says.
      event.waitUntil(scope.caches.open(personal(kind)).then((cache) => cache.delete(url)))
    }
    return response
  }

  scope.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(cacheName)
        await cache.add(config.offlineUrl)
        // Safe to take over at once: every cache is per deploy, so an old page
        // never meets a new worker's copies.
        await scope.skipWaiting()
      })(),
    )
  })

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await scope.caches.keys()) {
          const ours = name.startsWith(config.cachePrefix) || name.startsWith(config.personalPrefix)
          if (ours && !current.includes(name)) await scope.caches.delete(name)
        }
        // Without preload every navigation waits for this worker to start.
        await scope.registration.navigationPreload?.enable()
        await scope.clients.claim()
      })(),
    )
  })

  scope.addEventListener('fetch', (event) => {
    const { request } = event
    const url = new URL(request.url)
    const kept =
      config.offlineRoutes.length > 0 &&
      request.method === 'GET' &&
      url.origin === scope.location.origin
    if (request.mode === 'navigate') {
      const page = kept && under(url.pathname, config.offlineRoutes)
      event.respondWith(answer(event, page ? 'pages' : null, true))
      return
    }
    if (!kept) return
    if (under(url.pathname, config.offlineApi)) {
      event.respondWith(answer(event, 'data', false))
      return
    }
    // A bare prefix is not a file (Vite's dev client pings it to ask whether
    // the server is back, and must not be told yes from a cache).
    const prefix = config.assetPrefixes.find((entry) => url.pathname.startsWith(entry))
    if (!prefix || url.pathname === prefix) return
    if (!config.assetsHashed) {
      event.respondWith(answer(event, 'assets', false))
      return
    }
    // A hashed file never changes, so its copy is the answer. One with a query
    // is not such a file (Nuxt polls `builds/latest.json?<time>`): left alone.
    if (url.search) return
    event.respondWith(
      copyOf('assets', request.url).then((copy) => copy ?? answer(event, 'assets', false)),
    )
  })

  scope.addEventListener('message', (event) => {
    if (event.data !== 'pwa:forget') return
    event.waitUntil(forget().then(() => event.ports[0]?.postMessage('done')))
  })

  // Background Sync (Chromium only): the browser fires this once it is back
  // online, even with the app closed. Everywhere else the page sends the
  // outbox itself, on `online` and on its next load.
  scope.addEventListener('sync', (event) => {
    if (event.tag !== config.outboxTag) return
    event.waitUntil(
      (async () => {
        const result = await outbox({
          indexedDB: scope.indexedDB,
          fetch: (url, init) => scope.fetch(url, init),
          locks: scope.navigator?.locks,
          changed: () => {
            if (!scope.BroadcastChannel) return
            const channel = new scope.BroadcastChannel(config.outboxTag)
            channel.postMessage('changed')
            channel.close()
          },
        }).replay()
        // Rejecting makes the browser try the sync again later.
        if (result.waiting) throw new Error('outbox: writes still waiting')
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

/** What GET /sw.js knows; the cache names and the sync tag are the layer's own. */
export type ServiceWorkerOptions = Omit<
  ServiceWorkerConfig,
  'cachePrefix' | 'personalPrefix' | 'outboxTag'
>

/** The script GET /sw.js sends. */
export function renderServiceWorker(options: ServiceWorkerOptions): string {
  const filled: ServiceWorkerConfig = {
    cachePrefix: PWA_CACHE_PREFIX,
    personalPrefix: PWA_PERSONAL_CACHE_PREFIX,
    outboxTag: PWA_OUTBOX_TAG,
    ...options,
  }
  // Wrangler bundles with esbuild's keepNames, which wraps a named inner
  // function in `__name(…)`: a helper that exists in the Worker's bundle and
  // not in the browser. Defined here so such a function cannot break the script.
  return (
    'const __name = (fn) => fn;\n' +
    `(${serviceWorker.toString()})(self, ${JSON.stringify(filled)}, ${outboxSource.toString()})\n`
  )
}
