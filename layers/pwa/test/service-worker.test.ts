// The worker's handlers against a fake scope (test/lib/fake-worker-scope.ts),
// as they are with no offline routes named. What an app that names some gets
// is service-worker-offline.test.ts; the real thing, in a real browser with
// the network cut, is test/e2e/.

import { describe, expect, it } from 'vitest'

import { renderServiceWorker } from '../server/utils/service-worker'
import { fakeIndexedDb } from './lib/fake-indexeddb'
import { fakeScope, ORIGIN, response } from './lib/fake-worker-scope'

const OPTIONS = {
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
}

describe('install and activate', () => {
  it('caches the offline page under this deploy and takes over', async () => {
    const worker = fakeScope()
    await worker.lifecycle('install')
    expect([...worker.caches.get('pwa-offline-b2')!.keys()]).toEqual(['/offline'])
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

describe('fetch, with no offline routes named', () => {
  it('leaves everything that is not a navigation alone', async () => {
    const worker = fakeScope()
    expect(await worker.fetch('/api/thing')).toBeUndefined()
    expect(await worker.fetch('/_nuxt/entry.js', { mode: 'no-cors' })).toBeUndefined()
    expect(worker.caches.size).toBe(0)
  })

  it('answers a navigation from the network and keeps nothing', async () => {
    const worker = fakeScope()
    expect(await worker.navigate('/dashboard')).toBe('network:/dashboard')
    expect(worker.caches.size).toBe(0)
  })

  it('prefers the preloaded response', async () => {
    const worker = fakeScope()
    expect(await worker.navigate('/dashboard', Promise.resolve(response('preloaded')))).toBe(
      'preloaded',
    )
  })

  it('answers with the offline page when the network gives nothing', async () => {
    const worker = fakeScope({
      network: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await worker.lifecycle('install')
    expect(await worker.navigate('/dashboard')).toBe('cached:/offline')
    expect(
      await worker.navigate('/dashboard', Promise.reject(new TypeError('Failed to fetch'))),
    ).toBe('cached:/offline')
  })

  it('fails as the browser would when there is no offline page to show', async () => {
    const worker = fakeScope({
      network: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(worker.navigate('/dashboard')).rejects.toThrow('Failed to fetch')
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
  it('calls the worker with the scope, the filled-in config and the outbox', () => {
    const script = renderServiceWorker({ ...OPTIONS, offlineUrl: '/app/offline', homeUrl: '/app/' })
    expect(script.startsWith('const __name = (fn) => fn;\n(function serviceWorker(')).toBe(true)
    expect(script).toContain(
      '(self, {"cachePrefix":"pwa-offline-","personalPrefix":"pwa-personal-","outboxTag":"pwa-outbox","version":"b2","offlineUrl":"/app/offline","appName":"My App","homeUrl":"/app/",',
    )
    expect(script.trimEnd().endsWith('})')).toBe(true)
    expect(script).toContain(', function outbox(')
  })

  // `new Function` gives the script no scope but the global one, as the
  // browser does: anything either function closed over is a ReferenceError here.
  it('evaluates as a script with nothing but `self` in reach, the outbox included', async () => {
    const script = renderServiceWorker(OPTIONS)
    const listeners = new Map<string, (event: never) => void>()
    const sent: string[] = []
    const indexedDB = fakeIndexedDb()
    const self = {
      addEventListener: (type: string, listener: (event: never) => void) =>
        void listeners.set(type, listener),
      location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
      indexedDB,
      fetch: async (url: string) => {
        sent.push(url)
        return response('{}')
      },
    }
    // eslint-disable-next-line no-new-func -- the browser does the same with this string
    new Function('self', script)(self)
    expect([...listeners.keys()]).toEqual([
      'install',
      'activate',
      'fetch',
      'message',
      'sync',
      'push',
      'notificationclick',
    ])

    // The serialised outbox, run by the serialised worker.
    const { outbox } = await import('../shared/utils/outbox')
    await outbox({ indexedDB, fetch: self.fetch as never }).add({
      id: 'key-1',
      owner: 'user-ada',
      url: '/api/sessions',
      method: 'POST',
      body: { reps: 5 },
    })
    let work: Promise<unknown> = Promise.resolve()
    listeners.get('sync')!({
      tag: 'pwa-outbox',
      waitUntil: (promise: Promise<unknown>) => (work = promise),
    } as never)
    await work
    expect(sent).toEqual(['/api/sessions'])
  })
})
