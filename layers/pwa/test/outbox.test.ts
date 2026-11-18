// The outbox against an in-memory IndexedDB (test/lib/fake-indexeddb.ts): what
// is stored, the order it is sent in, and what each kind of answer does to a
// write. The real IndexedDB, in a real browser, is test/e2e/offline.spec.ts.

import { describe, expect, it } from 'vitest'

import { outbox } from '../shared/utils/outbox'
import type { OutboxResponse, OutboxWrite } from '../shared/utils/outbox'
import { fakeIndexedDb } from './lib/fake-indexeddb'

const ADA = 'user-ada'
const GRACE = 'user-grace'

function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const made: OutboxResponse = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
  return made
}

const OFFLINE = () => {
  throw new TypeError('Failed to fetch')
}

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** An outbox whose server is `server`: called per request, in order. */
function setup(server: (request: Sent, index: number) => OutboxResponse = () => answer(200)) {
  const sent: Sent[] = []
  let changed = 0
  let serve = server
  const box = outbox({
    indexedDB: fakeIndexedDb(),
    fetch: async (url, init) => {
      const request = { url, ...init }
      sent.push(request)
      return serve(request, sent.length - 1)
    },
    changed: () => void changed++,
    now: () => 1_700_000_000_000,
  })
  return {
    box,
    sent,
    changes: () => changed,
    /** Swap the server, as when the connection comes back. */
    serve: (next: typeof server) => void (serve = next),
  }
}

const write = (id: string, extra: Partial<OutboxWrite> = {}): OutboxWrite => ({
  id,
  owner: ADA,
  url: '/api/sessions',
  method: 'POST',
  body: { set: id },
  ...extra,
})

describe('storing a write', () => {
  it('keeps it as it was made, waiting, in the order it arrived', async () => {
    const { box } = setup()
    await box.add(write('a'))
    await box.add(write('b', { method: 'PATCH', url: '/api/sessions/7' }))
    expect(await box.list()).toEqual([
      {
        seq: 1,
        id: 'a',
        owner: ADA,
        url: '/api/sessions',
        method: 'POST',
        body: { set: 'a' },
        createdAt: 1_700_000_000_000,
        attempts: 0,
        state: 'waiting',
      },
      expect.objectContaining({ seq: 2, id: 'b', method: 'PATCH', url: '/api/sessions/7' }),
    ])
  })

  it("lists one account's writes when asked for them", async () => {
    const { box } = setup()
    await box.add(write('a'))
    await box.add(write('b', { owner: GRACE }))
    expect((await box.list(ADA)).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('replay', () => {
  it('sends in order, each with its key and owner, and removes what was accepted', async () => {
    const { box, sent, changes } = setup()
    await box.add(write('a'))
    await box.add(write('b'))
    await box.add(write('c'))

    expect(await box.replay(ADA)).toEqual({ sent: 3, failed: 0, waiting: 0 })
    expect(sent.map((request) => request.body)).toEqual([
      '{"set":"a"}',
      '{"set":"b"}',
      '{"set":"c"}',
    ])
    expect(sent[0]).toMatchObject({
      url: '/api/sessions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a',
        'X-Outbox-Owner': ADA,
      },
    })
    expect(await box.list()).toEqual([])
    expect(changes()).toBe(1)
  })

  it('stops at the first write that finds no connection, and keeps the order', async () => {
    const { box, sent, serve, changes } = setup((_request, index) => {
      if (index === 0) return answer(200)
      return OFFLINE()
    })
    await box.add(write('a'))
    await box.add(write('b'))
    await box.add(write('c'))

    expect(await box.replay(ADA)).toEqual({ sent: 1, failed: 0, waiting: 2 })
    expect(sent).toHaveLength(2)
    // Not counted against the write: nothing answered.
    expect((await box.list()).map((entry) => [entry.id, entry.attempts])).toEqual([
      ['b', 0],
      ['c', 0],
    ])

    serve(() => answer(200))
    expect(await box.replay(ADA)).toEqual({ sent: 2, failed: 0, waiting: 0 })
    expect(sent.slice(2).map((request) => request.headers['Idempotency-Key'])).toEqual(['b', 'c'])
    expect(changes()).toBe(2)
  })

  it('repeats the same key on every attempt, so a lost answer is not a second write', async () => {
    const { box, sent, serve } = setup(OFFLINE)
    await box.add(write('a'))
    await box.replay(ADA)
    await box.replay(ADA)
    serve(() => answer(200))
    await box.replay(ADA)
    expect(sent.map((request) => request.headers['Idempotency-Key'])).toEqual(['a', 'a', 'a'])
  })

  it('keeps a write the server rejects, with the reason, and goes on to the next', async () => {
    const { box, sent } = setup((request) =>
      request.body.includes('"b"')
        ? answer(422, { message: 'Reps must be a number' })
        : answer(200),
    )
    await box.add(write('a'))
    await box.add(write('b'))
    await box.add(write('c'))

    expect(await box.replay(ADA)).toEqual({ sent: 2, failed: 1, waiting: 0 })
    expect(await box.list()).toEqual([
      expect.objectContaining({
        id: 'b',
        state: 'failed',
        attempts: 1,
        error: { status: 422, message: 'Reps must be a number' },
      }),
    ])

    // A failed write is not sent again until someone asks.
    await box.replay(ADA)
    expect(sent).toHaveLength(3)
  })

  it.each([
    ['a 500', () => answer(500, 'Internal Server Error')],
    ['a 429', () => answer(429)],
    ['a 408', () => answer(408)],
    ['an answer with Retry-After', () => answer(409, {}, { 'Retry-After': '2' })],
  ])('waits and stops on %s, which is not a rejection', async (_name, later) => {
    const { box, sent } = setup(later)
    await box.add(write('a'))
    await box.add(write('b'))

    expect(await box.replay(ADA)).toEqual({ sent: 0, failed: 0, waiting: 2 })
    expect(sent).toHaveLength(1)
    expect(await box.list()).toEqual([
      expect.objectContaining({ id: 'a', state: 'waiting', attempts: 1 }),
      expect.objectContaining({ id: 'b', state: 'waiting', attempts: 0 }),
    ])
  })

  it('gives up on a write after five such answers, so it stops blocking the rest', async () => {
    const { box } = setup((request) =>
      request.body.includes('"a"') ? answer(503, { message: 'Down' }) : answer(200),
    )
    await box.add(write('a'))
    await box.add(write('b'))

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await box.replay(ADA)).toEqual({ sent: 0, failed: 0, waiting: 2 })
    }
    expect(await box.replay(ADA)).toEqual({ sent: 1, failed: 1, waiting: 0 })
    expect(await box.list()).toEqual([
      expect.objectContaining({
        id: 'a',
        state: 'failed',
        attempts: 5,
        // A 5xx's text is the server's business, not the person's.
        error: { status: 503, message: '' },
      }),
    ])
  })

  it('stops on a 401 without counting it: the session ended, the write did not fail', async () => {
    const { box } = setup(() => answer(401, { message: 'Unauthorized' }))
    await box.add(write('a'))
    expect(await box.replay(ADA)).toEqual({ sent: 0, failed: 0, waiting: 1 })
    expect(await box.list()).toEqual([
      expect.objectContaining({ id: 'a', state: 'waiting', attempts: 0 }),
    ])
  })

  it("deletes another account's writes unsent when told who is signed in", async () => {
    const { box, sent } = setup()
    await box.add(write('theirs', { owner: GRACE }))
    await box.add(write('mine'))

    expect(await box.replay(ADA)).toEqual({ sent: 1, failed: 0, waiting: 0 })
    expect(sent.map((request) => request.headers['Idempotency-Key'])).toEqual(['mine'])
    expect(await box.list()).toEqual([])
  })

  it('sends everything, each under its own owner, when not told (the worker)', async () => {
    const { box, sent } = setup()
    await box.add(write('theirs', { owner: GRACE }))
    await box.add(write('mine'))
    await box.replay()
    expect(sent.map((request) => request.headers['X-Outbox-Owner'])).toEqual([GRACE, ADA])
  })

  it('runs under the browser lock when there is one', async () => {
    const held: string[] = []
    const box = outbox({
      indexedDB: fakeIndexedDb(),
      fetch: async () => answer(200),
      locks: {
        request: async (name, work) => {
          held.push(name)
          return work()
        },
      },
    })
    await box.add(write('a'))
    expect(await box.replay(ADA)).toEqual({ sent: 1, failed: 0, waiting: 0 })
    expect(held).toEqual(['pwa-outbox'])
  })
})

describe('what a person can do with a failed write', () => {
  async function withFailure() {
    const made = setup(() => answer(400, { statusMessage: 'Too long' }))
    await made.box.add(write('a'))
    await made.box.replay(ADA)
    const [failed] = await made.box.list()
    return { ...made, failed: failed! }
  }

  it('retry: back in line, at its place, and sent on the next replay', async () => {
    const { box, failed, serve } = await withFailure()
    expect(failed).toMatchObject({ state: 'failed', error: { status: 400, message: 'Too long' } })
    await box.add(write('b'))

    await box.retry(failed.seq)
    expect((await box.list()).map((entry) => [entry.id, entry.state, entry.attempts])).toEqual([
      ['a', 'waiting', 0],
      ['b', 'waiting', 0],
    ])
    serve(() => answer(200))
    expect(await box.replay(ADA)).toEqual({ sent: 2, failed: 0, waiting: 0 })
  })

  it('discard: gone', async () => {
    const { box, failed } = await withFailure()
    await box.discard(failed.seq)
    expect(await box.list()).toEqual([])
  })
})

describe('clear', () => {
  it('removes everything, waiting and failed, whoever made it', async () => {
    const { box } = setup(() => answer(400))
    await box.add(write('a'))
    await box.replay(ADA)
    await box.add(write('b'))
    await box.add(write('c', { owner: GRACE }))

    await box.clear()
    expect(await box.list()).toEqual([])
  })
})
