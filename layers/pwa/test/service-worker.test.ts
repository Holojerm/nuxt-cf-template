// The worker's three handlers against a fake scope. The real thing, in a real
// browser with the network cut, is test/e2e/pwa.spec.ts.

import { describe, expect, it } from 'vitest'

import {
  renderServiceWorker,
  serviceWorker,
  type ServiceWorkerScope,
} from '../server/utils/service-worker'

const CONFIG = { cachePrefix: 'pwa-offline-', version: 'b2', offlineUrl: '/offline' }

type Listener = (event: never) => void

function fakeScope(options: { online?: boolean; caches?: Record<string, string[]> } = {}) {
  const listeners = new Map<string, Listener>()
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
    clients: { claim: async () => void calls.push('claim') },
    registration: { navigationPreload: { enable: async () => void calls.push('preload') } },
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
  return { caches, calls, lifecycle, fetch }
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

describe('renderServiceWorker', () => {
  it('calls the worker with the scope and the filled-in config', () => {
    const script = renderServiceWorker({ version: 'b2', offlineUrl: '/app/offline' })
    expect(script.startsWith('const __name = (fn) => fn;\n(function serviceWorker(')).toBe(true)
    expect(script).toContain(
      '(self, {"cachePrefix":"pwa-offline-","version":"b2","offlineUrl":"/app/offline"})',
    )
  })
})
