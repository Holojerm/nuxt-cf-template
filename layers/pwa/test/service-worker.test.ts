// The worker's handlers against a fake scope. The real thing, in a real
// browser with the network cut, is test/e2e/pwa.spec.ts.

import { describe, expect, it } from 'vitest'

import {
  renderServiceWorker,
  serviceWorker,
  type ServiceWorkerScope,
} from '../server/utils/service-worker'

const CONFIG = {
  cachePrefix: 'pwa-offline-',
  version: 'b2',
  offlineUrl: '/offline',
  appName: 'My App',
  homeUrl: '/',
  iconUrl: '/icon-192.png',
}
const ORIGIN = 'https://app.example'

interface Shown {
  title: string
  options: { body: string; icon: string; badge: string; data: { url: string } }
}

type Listener = (event: never) => void

function fakeScope(
  options: { online?: boolean; caches?: Record<string, string[]>; windows?: string[] } = {},
) {
  const listeners = new Map<string, Listener>()
  const shown: Shown[] = []
  const focused: string[] = []
  const opened: string[] = []
  const caches = new Map(Object.entries(options.caches ?? {}).map(([k, v]) => [k, new Set(v)]))
  const calls: string[] = []
  const scope: ServiceWorkerScope = {
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
    caches: {
      open: async (name) => {
        const entries = caches.get(name) ?? caches.set(name, new Set()).get(name)!
        return {
          add: async (url) => void entries.add(url),
          match: async (url) => (entries.has(url) ? `cached:${url}` : undefined),
        }
      },
      keys: async () => [...caches.keys()],
      delete: async (name) => caches.delete(name),
    },
    fetch: async () => {
      if (options.online === false) throw new TypeError('Failed to fetch')
      return 'network'
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
  }
  serviceWorker(scope, CONFIG)

  /** Fire a lifecycle event and wait for what it handed to waitUntil. */
  const lifecycle = async (type: 'install' | 'activate') => {
    let work: Promise<unknown> = Promise.resolve()
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => (work = promise) } as never)
    await work
  }
  /** Fire a fetch; resolves to the response, or to `undefined` when the worker let it pass. */
  const fetch = (mode: string, preloadResponse?: Promise<unknown>) => {
    let response: Promise<unknown> | undefined
    listeners.get('fetch')!({
      request: { mode },
      preloadResponse,
      respondWith: (promise: Promise<unknown>) => (response = promise),
    } as never)
    return response
  }
  /** Fire a push carrying `data` (a string is sent as is, anything else as JSON; undefined = no payload). */
  const push = async (data?: unknown) => {
    let work: Promise<unknown> = Promise.resolve()
    listeners.get('push')!({
      data:
        data === undefined
          ? null
          : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
      waitUntil: (promise: Promise<unknown>) => (work = promise),
    } as never)
    await work
  }
  /** Click a notification whose data carries `url`; resolves to whether it was closed. */
  const click = async (url?: unknown) => {
    let work: Promise<unknown> = Promise.resolve()
    let closed = false
    listeners.get('notificationclick')!({
      notification: { close: () => (closed = true), data: url === undefined ? undefined : { url } },
      waitUntil: (promise: Promise<unknown>) => (work = promise),
    } as never)
    await work
    return closed
  }
  return { caches, calls, lifecycle, fetch, push, click, shown, focused, opened }
}

describe('install and activate', () => {
  it('caches the offline page under this deploy and takes over', async () => {
    const worker = fakeScope()
    await worker.lifecycle('install')
    expect([...worker.caches.get('pwa-offline-b2')!]).toEqual(['/offline'])
    expect(worker.calls).toEqual(['skipWaiting'])
  })

  it("deletes earlier deploys' caches and nobody else's", async () => {
    const worker = fakeScope({ caches: { 'pwa-offline-b1': ['/offline'], 'someone-else': ['/x'] } })
    await worker.lifecycle('install')
    await worker.lifecycle('activate')
    expect([...worker.caches.keys()].sort()).toEqual(['pwa-offline-b2', 'someone-else'])
    expect(worker.calls).toEqual(['skipWaiting', 'preload', 'claim'])
  })
})

describe('fetch', () => {
  it('leaves everything that is not a navigation alone', () => {
    const worker = fakeScope()
    expect(worker.fetch('cors')).toBeUndefined()
    expect(worker.fetch('no-cors')).toBeUndefined()
  })

  it('answers a navigation from the network', async () => {
    const worker = fakeScope()
    await expect(worker.fetch('navigate')).resolves.toBe('network')
  })

  it('prefers the preloaded response', async () => {
    const worker = fakeScope()
    await expect(worker.fetch('navigate', Promise.resolve('preloaded'))).resolves.toBe('preloaded')
  })

  it('answers with the offline page when the network gives nothing', async () => {
    const worker = fakeScope({ online: false })
    await worker.lifecycle('install')
    await expect(worker.fetch('navigate')).resolves.toBe('cached:/offline')
    await expect(
      worker.fetch('navigate', Promise.reject(new TypeError('Failed to fetch'))),
    ).resolves.toBe('cached:/offline')
  })

  it('fails as the browser would when there is no offline page to show', async () => {
    const worker = fakeScope({ online: false })
    await expect(worker.fetch('navigate')).rejects.toThrow('Failed to fetch')
  })
})

describe('push', () => {
  it('shows the message it was sent, with the app icon and the link kept for the click', async () => {
    const worker = fakeScope()
    await worker.push({ title: 'Your plan changed', body: 'Coach moved Thursday.', url: '/plan' })
    expect(worker.shown).toEqual([
      {
        title: 'Your plan changed',
        options: {
          body: 'Coach moved Thursday.',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          data: { url: '/plan' },
        },
      },
    ])
  })

  it.each([
    ['no payload', undefined],
    ['a payload that is not JSON', 'not json'],
    ['JSON that is not a message', [1, 2]],
    ['fields of the wrong type', { title: 7, body: {}, url: null }],
  ])('still shows a notification for %s, under the app name', async (_name, data) => {
    const worker = fakeScope()
    await worker.push(data)
    expect(worker.shown).toHaveLength(1)
    expect(worker.shown[0]).toMatchObject({
      title: 'My App',
      options: { body: '', data: { url: '/' } },
    })
  })
})

describe('notificationclick', () => {
  it('closes the notification and focuses a window already on the page', async () => {
    const worker = fakeScope({ windows: [`${ORIGIN}/dashboard`, `${ORIGIN}/plan`] })
    expect(await worker.click('/plan')).toBe(true)
    expect(worker.focused).toEqual([`${ORIGIN}/plan`])
    expect(worker.opened).toEqual([])
  })

  it('opens the page when no window is on it', async () => {
    const worker = fakeScope({ windows: [`${ORIGIN}/dashboard`] })
    await worker.click('/plan?week=2')
    expect(worker.focused).toEqual([])
    expect(worker.opened).toEqual([`${ORIGIN}/plan?week=2`])
  })

  it.each([
    ['another site', 'https://evil.example/login'],
    ['a protocol-relative link', '//evil.example/login'],
    ['a script URL', 'javascript:alert(1)'],
    ['nothing', undefined],
    ['something that is not a URL', 'https://'],
  ])('goes home when the link is %s', async (_name, url) => {
    const worker = fakeScope()
    await worker.click(url)
    expect(worker.opened).toEqual([`${ORIGIN}/`])
  })
})

describe('renderServiceWorker', () => {
  it('calls the worker with the scope and the filled-in config', () => {
    const script = renderServiceWorker({
      version: 'b2',
      offlineUrl: '/app/offline',
      appName: 'My App',
      homeUrl: '/app/',
      iconUrl: '/app/icon-192.png',
    })
    expect(script.startsWith('const __name = (fn) => fn;\n(function serviceWorker(')).toBe(true)
    expect(script).toContain(
      '(self, {"cachePrefix":"pwa-offline-","version":"b2","offlineUrl":"/app/offline","appName":"My App","homeUrl":"/app/","iconUrl":"/app/icon-192.png"})',
    )
  })

  it('evaluates as a script with nothing but `self` in reach', () => {
    const script = renderServiceWorker({
      version: 'b2',
      offlineUrl: '/offline',
      appName: 'My App',
      homeUrl: '/',
      iconUrl: '/icon-192.png',
    })
    const registered: string[] = []
    const self = { addEventListener: (type: string) => void registered.push(type) }
    // eslint-disable-next-line no-new-func -- the browser does the same with this string
    new Function('self', script)(self)
    expect(registered).toEqual(['install', 'activate', 'fetch', 'push', 'notificationclick'])
  })
})
