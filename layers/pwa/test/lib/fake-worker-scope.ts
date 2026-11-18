// A fake `ServiceWorkerGlobalScope` for the worker's unit tests: caches that
// keep insertion order, a network that answers what the test says, and one
// function per event the worker listens for.

import { outbox } from '../../shared/utils/outbox'
import { serviceWorker } from '../../server/utils/service-worker'
import type {
  ServiceWorkerConfig,
  ServiceWorkerScope,
  WorkerResponse,
} from '../../server/utils/service-worker-scope'
import { fakeIndexedDb } from './fake-indexeddb'

export const ORIGIN = 'https://app.example'

export const CONFIG: ServiceWorkerConfig = {
  cachePrefix: 'pwa-offline-',
  personalPrefix: 'pwa-personal-',
  version: 'b2',
  offlineUrl: '/offline',
  appName: 'My App',
  homeUrl: '/',
  iconUrl: '/icon-192.png',
  offlineRoutes: [],
  offlineApi: [],
  assetPrefixes: ['/_nuxt/'],
  assetsHashed: true,
  cacheLimits: { pages: 30, data: 100, assets: 400 },
  outboxTag: 'pwa-outbox',
}

export interface FakeResponse extends WorkerResponse {
  body: string
}

export function response(body: string, status = 200, headers: Record<string, string> = {}) {
  const made: FakeResponse = {
    body,
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => body,
    clone: () => response(body, status, headers),
  }
  return made
}

export interface Shown {
  title: string
  options: { body: string; icon: string; badge: string; data: { url: string } }
}

export interface FakeScopeOptions {
  config?: Partial<ServiceWorkerConfig>
  /** The network. Throw for "no connection". Default: 200 with `network:<url>`. */
  network?: (url: string, init?: { method?: string; headers?: Record<string, string> }) => unknown
  /** Cache name → URLs already in it. */
  caches?: Record<string, string[]>
  windows?: string[]
}

type Listener = (event: never) => void

export function fakeScope(options: FakeScopeOptions = {}) {
  const config = { ...CONFIG, ...options.config }
  const listeners = new Map<string, Listener>()
  const shown: Shown[] = []
  const focused: string[] = []
  const opened: string[] = []
  const calls: string[] = []
  const announced: string[] = []
  const caches = new Map(
    Object.entries(options.caches ?? {}).map(([name, urls]) => [
      name,
      new Map(urls.map((url) => [url, response(`cached:${url}`)])),
    ]),
  )
  const indexedDB = fakeIndexedDb()
  const network =
    options.network ?? ((url: string) => response(`network:${url.replace(ORIGIN, '')}`))

  const scope: ServiceWorkerScope = {
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
    caches: {
      open: async (name) => {
        const entries = caches.get(name) ?? caches.set(name, new Map()).get(name)!
        return {
          add: async (url) => void entries.set(url, response(`cached:${url}`)),
          put: async (url, copy) => {
            entries.delete(url)
            entries.set(url, copy as FakeResponse)
          },
          match: async (url) => entries.get(url),
          delete: async (url) => entries.delete(url),
          keys: async () => [...entries.keys()].map((url) => ({ url })),
        }
      },
      keys: async () => [...caches.keys()],
      delete: async (name) => caches.delete(name),
    },
    fetch: async (request, init) => {
      const url = typeof request === 'string' ? request : (request as { url: string }).url
      return network(url, init as never) as WorkerResponse
    },
    skipWaiting: async () => void calls.push('skipWaiting'),
    clients: {
      claim: async () => void calls.push('claim'),
      matchAll: async () =>
        (options.windows ?? []).map((url) => ({ url, focus: async () => void focused.push(url) })),
      openWindow: async (url) => void opened.push(url),
    },
    registration: {
      navigationPreload: { enable: async () => void calls.push('preload') },
      showNotification: async (title, shownOptions) =>
        void shown.push({ title, options: shownOptions }),
    },
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    indexedDB,
    BroadcastChannel: class {
      constructor(private name: string) {}
      postMessage(message: unknown) {
        announced.push(`${this.name}:${String(message)}`)
      }
      close() {}
    },
  }
  serviceWorker(scope, config, outbox)

  /** Fire an event that only extends its life, and wait for what it handed to waitUntil. */
  const extend = async (type: string, fields: Record<string, unknown> = {}) => {
    const work: Promise<unknown>[] = []
    listeners.get(type)!({
      ...fields,
      waitUntil: (promise: Promise<unknown>) => void work.push(promise),
    } as never)
    await Promise.all(work)
  }

  /**
   * Fire a fetch. Resolves to the response's body once everything the worker
   * handed to waitUntil has settled, or to `undefined` when it let the request pass.
   */
  const fetch = async (
    path: string,
    request: { mode?: string; method?: string; preload?: Promise<WorkerResponse> } = {},
  ) => {
    let answered: Promise<WorkerResponse> | undefined
    const work: Promise<unknown>[] = []
    listeners.get('fetch')!({
      request: {
        url: path.startsWith('http') ? path : ORIGIN + path,
        mode: request.mode ?? 'cors',
        method: request.method ?? 'GET',
      },
      preloadResponse: request.preload,
      respondWith: (promise: Promise<WorkerResponse>) => (answered = promise),
      waitUntil: (promise: Promise<unknown>) => void work.push(promise),
    } as never)
    if (!answered) return undefined
    const result = (await answered) as FakeResponse
    await Promise.all(work)
    return result.body
  }

  return {
    caches,
    calls,
    shown,
    focused,
    opened,
    announced,
    indexedDB,
    fetch,
    navigate: (path: string, preload?: Promise<WorkerResponse>) =>
      fetch(path, { mode: 'navigate', preload }),
    lifecycle: (type: 'install' | 'activate') => extend(type),
    /** What a personal cache holds, oldest first, as paths. */
    kept: (kind: 'pages' | 'data' | 'assets') =>
      [...(caches.get(`pwa-personal-${kind}-${config.version}`)?.keys() ?? [])].map((url) =>
        url.replace(ORIGIN, ''),
      ),
    /** Post a message; resolves to what the worker answered on the port. */
    message: async (data: unknown) => {
      const replies: unknown[] = []
      await extend('message', {
        data,
        ports: [{ postMessage: (reply: unknown) => replies.push(reply) }],
      })
      return replies
    },
    sync: (tag: string) => extend('sync', { tag }),
    /** Fire a push carrying `data` (a string is sent as is, anything else as JSON; undefined = no payload). */
    push: (data?: unknown) =>
      extend('push', {
        data:
          data === undefined
            ? null
            : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
      }),
    /** Click a notification whose data carries `url`; resolves to whether it was closed. */
    click: async (url?: unknown) => {
      let closed = false
      await extend('notificationclick', {
        notification: {
          close: () => (closed = true),
          data: url === undefined ? undefined : { url },
        },
      })
      return closed
    },
  }
}
