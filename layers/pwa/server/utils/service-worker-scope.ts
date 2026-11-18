// What the worker uses of `ServiceWorkerGlobalScope`, and the config GET /sw.js
// fills in. Neither the DOM nor the Workers types describe a service worker, and
// the unit tests build a fake from these.

import type { OutboxEnv, OutboxResponse } from '../../shared/utils/outbox'

export interface WorkerResponse extends OutboxResponse {
  clone(): WorkerResponse
}

export interface WorkerCache {
  add(url: string): Promise<void>
  put(url: string, response: WorkerResponse): Promise<void>
  match(url: string, options?: { ignoreVary: boolean }): Promise<WorkerResponse | undefined>
  delete(url: string): Promise<boolean>
  /** Oldest first: a `put` of a URL already there moves it to the end. */
  keys(): Promise<Array<{ url: string }>>
}

export interface ServiceWorkerScope {
  addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: WorkerFetchEvent) => void): void
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationClickEvent) => void,
  ): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(type: 'sync', listener: (event: SyncEvent) => void): void
  caches: {
    open(name: string): Promise<WorkerCache>
    keys(): Promise<string[]>
    delete(name: string): Promise<boolean>
  }
  fetch(request: unknown, init?: unknown): Promise<WorkerResponse>
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
  indexedDB: OutboxEnv['indexedDB']
  navigator?: { locks?: OutboxEnv['locks'] }
  BroadcastChannel?: new (name: string) => { postMessage(message: unknown): void; close(): void }
}

interface WindowClient {
  url: string
  focus(): Promise<unknown>
}

interface LifecycleEvent {
  waitUntil(work: Promise<unknown>): void
}

export interface WorkerFetchEvent extends LifecycleEvent {
  request: { mode: string; method: string; url: string }
  /** Set once navigation preload is on; resolves to nothing where it is not supported. */
  preloadResponse?: Promise<WorkerResponse | undefined>
  respondWith(response: Promise<WorkerResponse>): void
}

interface PushEvent extends LifecycleEvent {
  /** Null for a push with no payload. */
  data: { json(): unknown } | null
}

interface NotificationClickEvent extends LifecycleEvent {
  notification: { close(): void; data?: { url?: unknown } }
}

interface MessageEvent extends LifecycleEvent {
  data: unknown
  /** The page's end of a MessageChannel, when it wants to know the work is done. */
  ports: ReadonlyArray<{ postMessage(message: unknown): void }>
}

interface SyncEvent extends LifecycleEvent {
  tag: string
}

/** The three caches of personal copies. Each has its own bound. */
export type PwaPersonalCache = 'pages' | 'data' | 'assets'

export interface ServiceWorkerConfig {
  /** The offline page's cache, one per deploy; the rest are deleted on activate. */
  cachePrefix: string
  /** Caches of what a signed-in person loaded. Per deploy too, and emptied on sign-out. */
  personalPrefix: string
  /** Differs per deploy, so each one installs a new worker and starts its caches again. */
  version: string
  /** The offline page's URL, `app.baseURL` included. */
  offlineUrl: string
  /** The title of a notification whose message carried none. */
  appName: string
  /** Where a notification with no usable link goes: `app.baseURL`. */
  homeUrl: string
  /** The icon on every notification, `app.baseURL` included. */
  iconUrl: string
  /** Paths whose pages open from a copy when there is no network. Empty = nothing below is on. */
  offlineRoutes: string[]
  /** Paths whose GET responses are kept for those pages. */
  offlineApi: string[]
  /** Paths the build's own files are served under (`/_nuxt/`). */
  assetPrefixes: string[]
  /** A build: a file's name carries its hash, so a copy is always current. False under `nuxt dev`. */
  assetsHashed: boolean
  /** Entries each personal cache may hold before the oldest go. */
  cacheLimits: Record<PwaPersonalCache, number>
  /** The Background Sync tag that means "send the outbox", and the channel to announce it on. */
  outboxTag: string
}
