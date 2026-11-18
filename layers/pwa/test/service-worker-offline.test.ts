// The worker once an app names offline routes: which requests it keeps a copy
// of, when a copy is the answer, how the caches are bounded and emptied, and
// the Background Sync that sends the outbox. Against a fake scope
// (test/lib/fake-worker-scope.ts); the real browser is test/e2e/offline.spec.ts.

import { describe, expect, it } from 'vitest'

import { outbox } from '../shared/utils/outbox'
import { pwaPrefixes } from '../shared/utils/pwa-cache'
import { fakeScope, ORIGIN, response } from './lib/fake-worker-scope'

const OFFLINE = { offlineRoutes: ['/training'], offlineApi: ['/api/training'] }

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A network the test can cut, and whose answers it can change. */
function network(answers: Record<string, () => unknown> = {}) {
  const state = { online: true, asked: [] as string[] }
  const handler = (url: string) => {
    const path = url.replace(ORIGIN, '')
    state.asked.push(path)
    if (!state.online) throw new TypeError('Failed to fetch')
    return answers[path]?.() ?? response(`network:${path}`)
  }
  return { state, handler }
}

describe('pages under an offline route', () => {
  it('come from the network, and a copy is kept', async () => {
    const worker = fakeScope({ config: OFFLINE })
    expect(await worker.navigate('/training/today')).toBe('network:/training/today')
    expect(worker.kept('pages')).toEqual(['/training/today'])
  })

  it('come from the copy when the network gives nothing, the newest one', async () => {
    let visit = 0
    const net = network({ '/training': () => response(`visit ${++visit}`) })
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    await worker.lifecycle('install')
    await worker.navigate('/training')
    await worker.navigate('/training')

    net.state.online = false
    expect(await worker.navigate('/training')).toBe('visit 2')
  })

  it('fall back to the offline page only when there is no copy', async () => {
    const net = network()
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    await worker.lifecycle('install')
    net.state.online = false
    expect(await worker.navigate('/training/never-opened')).toBe('cached:/offline')
  })

  it('match whole path segments, and only GET navigations on this origin', async () => {
    const worker = fakeScope({ config: OFFLINE })
    await worker.navigate('/trainings')
    await worker.navigate('/dashboard')
    await worker.fetch('/training', { mode: 'navigate', method: 'POST' })
    await worker.navigate('https://elsewhere.example/training')
    expect(worker.kept('pages')).toEqual([])
  })

  it.each([
    ['a redirect to sign in', 0],
    ['a 403', 403],
    ['a 404', 404],
  ])('drop the copy when the server now answers with %s', async (_name, status) => {
    let answer = response('the page')
    const net = network({ '/training': () => answer })
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    await worker.navigate('/training')
    await worker.navigate('/training/other')

    answer = response('', status)
    await worker.navigate('/training')
    expect(worker.kept('pages')).toEqual(['/training/other'])
  })

  it('keep the copy through a server error, and still pass the error on', async () => {
    let answer = response('the page')
    const net = network({ '/training': () => answer })
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    await worker.navigate('/training')

    answer = response('broken', 500)
    expect(await worker.navigate('/training')).toBe('broken')
    expect(worker.kept('pages')).toEqual(['/training'])
  })
})

describe('data under an offline API path', () => {
  it('is kept on a GET and served when the network gives nothing', async () => {
    const net = network()
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    expect(await worker.fetch('/api/training/plan?week=2')).toBe(
      'network:/api/training/plan?week=2',
    )

    net.state.online = false
    expect(await worker.fetch('/api/training/plan?week=2')).toBe(
      'network:/api/training/plan?week=2',
    )
    await expect(worker.fetch('/api/training/plan?week=3')).rejects.toThrow('Failed to fetch')
  })

  it('is never a write, another API, or another origin', async () => {
    const worker = fakeScope({ config: OFFLINE })
    expect(await worker.fetch('/api/training/sessions', { method: 'POST' })).toBeUndefined()
    expect(await worker.fetch('/api/billing/entitlement')).toBeUndefined()
    expect(await worker.fetch('https://elsewhere.example/api/training/plan')).toBeUndefined()
    expect(worker.caches.size).toBe(0)
  })

  it('goes, all of it, when the server answers 401: the session is over', async () => {
    let answer = response('{"plan":1}')
    const net = network({ '/api/training/plan': () => answer })
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    await worker.navigate('/training')
    await worker.fetch('/_nuxt/entry.abc123.js')
    await worker.fetch('/api/training/plan')

    answer = response('', 401)
    await worker.fetch('/api/training/plan')
    expect([...worker.caches.keys()]).toEqual([])
  })
})

describe('build files', () => {
  it('are kept, and a hashed file is answered from its copy without the network', async () => {
    const net = network()
    const worker = fakeScope({ config: OFFLINE, network: net.handler })
    expect(await worker.fetch('/_nuxt/entry.abc123.js', { mode: 'no-cors' })).toBe(
      'network:/_nuxt/entry.abc123.js',
    )
    expect(await worker.fetch('/_nuxt/entry.abc123.js')).toBe('network:/_nuxt/entry.abc123.js')
    expect(net.state.asked).toEqual(['/_nuxt/entry.abc123.js'])
  })

  it("leave a hashed build's polls alone: a query, or the bare prefix", async () => {
    const worker = fakeScope({ config: OFFLINE })
    expect(await worker.fetch('/_nuxt/builds/latest.json?1731900000')).toBeUndefined()
    expect(await worker.fetch('/_nuxt/')).toBeUndefined()
    expect(await worker.fetch('/images/photo.jpg')).toBeUndefined()
  })

  it('go to the network first under `nuxt dev`, where a name says nothing about the contents', async () => {
    let edit = 0
    const net = network({ '/_nuxt/pages/training.vue?v=1': () => response(`edit ${++edit}`) })
    const worker = fakeScope({
      config: { ...OFFLINE, assetsHashed: false },
      network: net.handler,
    })
    await worker.fetch('/_nuxt/pages/training.vue?v=1')
    expect(await worker.fetch('/_nuxt/pages/training.vue?v=1')).toBe('edit 2')

    net.state.online = false
    expect(await worker.fetch('/_nuxt/pages/training.vue?v=1')).toBe('edit 2')
    expect(await worker.fetch('/_nuxt/')).toBeUndefined()
  })
})

describe('the caches', () => {
  it('are bounded: past the limit the oldest copies go', async () => {
    const worker = fakeScope({
      config: { ...OFFLINE, cacheLimits: { pages: 3, data: 100, assets: 400 } },
    })
    // Trimmed on the 1st and 21st put, so 21 pages leave the newest three.
    for (let page = 1; page <= 21; page++) await worker.navigate(`/training/${page}`)
    expect(worker.kept('pages')).toEqual(['/training/19', '/training/20', '/training/21'])
  })

  it('count a page opened again as new', async () => {
    const worker = fakeScope({ config: OFFLINE })
    await worker.navigate('/training/a')
    await worker.navigate('/training/b')
    await worker.navigate('/training/a')
    expect(worker.kept('pages')).toEqual(['/training/b', '/training/a'])
  })

  it("are per deploy: activate deletes an earlier deploy's, and nobody else's", async () => {
    const worker = fakeScope({
      config: OFFLINE,
      caches: {
        'pwa-offline-b1': ['/offline'],
        'pwa-personal-pages-b1': ['/training'],
        'pwa-personal-data-b1': ['/api/training/plan'],
        'pwa-personal-pages-b2': ['/training'],
        'someone-else': ['/x'],
      },
    })
    await worker.lifecycle('install')
    await worker.lifecycle('activate')
    expect([...worker.caches.keys()].sort()).toEqual([
      'pwa-offline-b2',
      'pwa-personal-pages-b2',
      'someone-else',
    ])
  })
})

describe('forgetting a person', () => {
  it('deletes every personal cache, keeps the offline page, and says when it is done', async () => {
    const worker = fakeScope({ config: OFFLINE })
    await worker.lifecycle('install')
    await worker.navigate('/training')
    await worker.fetch('/api/training/plan')
    await worker.fetch('/_nuxt/entry.abc123.js')

    expect(await worker.message('pwa:forget')).toEqual(['done'])
    expect([...worker.caches.keys()]).toEqual(['pwa-offline-b2'])
  })

  it('ignores any other message', async () => {
    const worker = fakeScope({ config: OFFLINE })
    await worker.navigate('/training')
    expect(await worker.message({ type: 'pwa:forget' })).toEqual([])
    expect(worker.kept('pages')).toEqual(['/training'])
  })

  it('does not keep a response that was already on its way', async () => {
    let arrive!: (answer: unknown) => void
    const worker = fakeScope({
      config: OFFLINE,
      network: () => new Promise((resolve) => (arrive = resolve)),
    })
    const asked = worker.fetch('/api/training/plan')
    await tick()
    await worker.message('pwa:forget')

    arrive(response("the last person's plan"))
    expect(await asked).toBe("the last person's plan")
    expect(worker.kept('data')).toEqual([])

    // The next person's own requests are kept as usual.
    const mine = worker.fetch('/api/training/plan')
    await tick()
    arrive(response('my plan'))
    await mine
    expect(worker.kept('data')).toEqual(['/api/training/plan'])
  })
})

describe('Background Sync', () => {
  const write = { id: 'key-1', owner: 'user-ada', url: '/api/training/sessions', method: 'POST' }

  it('sends the outbox, in order, and tells the open tabs', async () => {
    const sent: Array<{ url: string; key?: string }> = []
    const worker = fakeScope({
      network: (url, init) => {
        sent.push({ url, key: init?.headers?.['Idempotency-Key'] })
        return response('{}')
      },
    })
    const box = outbox({ indexedDB: worker.indexedDB, fetch: async () => response('{}') })
    await box.add({ ...write, method: 'POST', body: { reps: 5 } })
    await box.add({ ...write, id: 'key-2', method: 'POST', body: { reps: 8 } })

    await worker.sync('pwa-outbox')
    expect(sent).toEqual([
      { url: '/api/training/sessions', key: 'key-1' },
      { url: '/api/training/sessions', key: 'key-2' },
    ])
    expect(await box.list()).toEqual([])
    expect(worker.announced).toEqual(['pwa-outbox:changed'])
  })

  it('fails the sync while writes are still waiting, so the browser tries again', async () => {
    const worker = fakeScope({
      network: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const box = outbox({ indexedDB: worker.indexedDB, fetch: async () => response('{}') })
    await box.add({ ...write, method: 'POST' })
    await expect(worker.sync('pwa-outbox')).rejects.toThrow('still waiting')
    expect(await box.list()).toHaveLength(1)
  })

  it('ignores a sync with another tag', async () => {
    const worker = fakeScope({
      network: () => {
        throw new Error('nothing should be sent')
      },
    })
    const box = outbox({ indexedDB: worker.indexedDB, fetch: async () => response('{}') })
    await box.add({ ...write, method: 'POST' })
    await worker.sync('someone-elses-tag')
    expect(await box.list()).toHaveLength(1)
  })
})

describe('pwaPrefixes', () => {
  it.each([
    ['an array from nuxt.config', ['/training', '/api/training'], ['/training', '/api/training']],
    ['a comma-separated env value', '/training, /plan', ['/training', '/plan']],
    ['a single path', '/training', ['/training']],
    ['duplicates', ['/training', '/training'], ['/training']],
    ['nothing', undefined, []],
    ['an empty string', '', []],
  ])('reads %s', (_name, value, expected) => {
    expect(pwaPrefixes(value)).toEqual(expected)
  })

  it('drops what is not a path on this site, and `/`, which would be all of it', () => {
    expect(pwaPrefixes(['/', 'training', '//evil.example/x', 7, null, ' /ok '])).toEqual(['/ok'])
  })
})
