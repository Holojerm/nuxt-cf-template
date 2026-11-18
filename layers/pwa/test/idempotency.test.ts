// `idempotent()` against a real D1: a key answers once, for one account, and a
// replay is given the first answer back. Then the h3 wrapper with its globals
// replaced, the example route built on it, and the sweeps.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount } from '~~/server/utils/account'
import { clearExtensionsForTest, getPurgeContributors } from '~~/server/utils/extensions'
import { idempotent } from '../server/utils/idempotency'
import {
  IDEMPOTENCY_KEY_DAYS,
  IDEMPOTENCY_STALE_SECONDS,
  purgeIdempotencyKeys,
  runIdempotent,
} from '../server/utils/idempotency-keys'
import { registerPwaExtensions } from '../server/utils/pwa-extensions'

vi.mock('@nuxthub/db', async () => {
  const { drizzle } = await import('drizzle-orm/d1')
  const schema = await import('~~/server/db/schema')
  return { db: drizzle(env.DB, { schema }) }
})

const db = drizzle(env.DB, { schema })
const ADA = 'user-ada'
const GRACE = 'user-grace'
const KEY = '3f2b8c1e-0d4a-4a6f-9c57-1b2e3d4c5f60'
const NOW = 1_700_000_000_000

const rows = () =>
  db
    .select({
      userId: schema.idempotencyKeys.userId,
      key: schema.idempotencyKeys.key,
      status: schema.idempotencyKeys.status,
      response: schema.idempotencyKeys.response,
    })
    .from(schema.idempotencyKeys)

/** A write that counts how often it really ran. */
function counter() {
  let runs = 0
  const work = async () => ({ saved: ++runs })
  return { work, runs: () => runs }
}

beforeEach(async () => {
  clearExtensionsForTest()
  await db.delete(schema.idempotencyKeys)
  await db.delete(schema.auditLog)
  await db.delete(schema.users)
})

describe('runIdempotent', () => {
  it('runs the write once and records its answer', async () => {
    const { work, runs } = counter()
    const outcome = await runIdempotent(db, { userId: ADA, key: KEY }, work, () => 201)
    expect(outcome).toEqual({ state: 'ran', status: 201, value: { saved: 1 } })
    expect(runs()).toBe(1)
    expect(await rows()).toEqual([{ userId: ADA, key: KEY, status: 201, response: '{"saved":1}' }])
  })

  it('answers a replay with the first answer, and writes nothing', async () => {
    const { work, runs } = counter()
    await runIdempotent(db, { userId: ADA, key: KEY }, work, () => 201)
    const again = await runIdempotent(db, { userId: ADA, key: KEY }, work)
    expect(again).toEqual({ state: 'replayed', status: 201, value: { saved: 1 } })
    expect(runs()).toBe(1)
  })

  it('replays a write that returned nothing', async () => {
    await runIdempotent(db, { userId: ADA, key: KEY }, async () => undefined)
    expect(await runIdempotent(db, { userId: ADA, key: KEY }, async () => 'ran again')).toEqual({
      state: 'replayed',
      status: 200,
      value: null,
    })
  })

  it("keeps one account's key from answering for another's", async () => {
    const { work, runs } = counter()
    await runIdempotent(db, { userId: ADA, key: KEY }, work)
    const theirs = await runIdempotent(db, { userId: GRACE, key: KEY }, work)
    expect(theirs).toMatchObject({ state: 'ran', value: { saved: 2 } })
    expect(runs()).toBe(2)
  })

  it('leaves no record of a write that threw, so it can be tried again', async () => {
    const failing = runIdempotent(db, { userId: ADA, key: KEY }, async () => {
      throw new Error('constraint failed')
    })
    await expect(failing).rejects.toThrow('constraint failed')
    expect(await rows()).toEqual([])

    const { work, runs } = counter()
    expect(await runIdempotent(db, { userId: ADA, key: KEY }, work)).toMatchObject({ state: 'ran' })
    expect(runs()).toBe(1)
  })

  it('says busy while the first attempt is still running, and runs nothing', async () => {
    let finish!: () => void
    const { work, runs } = counter()
    const first = runIdempotent(db, { userId: ADA, key: KEY, now: NOW }, async () => {
      await new Promise<void>((resolve) => (finish = resolve))
      return 'first'
    })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))

    expect(await runIdempotent(db, { userId: ADA, key: KEY, now: NOW + 5000 }, work)).toEqual({
      state: 'busy',
    })
    expect(runs()).toBe(0)

    finish()
    expect(await first).toMatchObject({ state: 'ran', value: 'first' })
    expect(await runIdempotent(db, { userId: ADA, key: KEY, now: NOW + 6000 }, work)).toMatchObject(
      { state: 'replayed', value: 'first' },
    )
  })

  it('takes over an attempt that never finished, once, after the stale time', async () => {
    // A claim with no answer: the isolate died mid-request.
    await db
      .insert(schema.idempotencyKeys)
      .values({ userId: ADA, key: KEY, createdAt: new Date(NOW) })
    const { work, runs } = counter()
    const early = NOW + (IDEMPOTENCY_STALE_SECONDS - 1) * 1000
    expect(await runIdempotent(db, { userId: ADA, key: KEY, now: early }, work)).toEqual({
      state: 'busy',
    })

    const late = NOW + IDEMPOTENCY_STALE_SECONDS * 1000
    const [one, two] = await Promise.all([
      runIdempotent(db, { userId: ADA, key: KEY, now: late }, work),
      runIdempotent(db, { userId: ADA, key: KEY, now: late + 1000 }, work),
    ])
    expect([one.state, two.state].sort()).toEqual(['busy', 'ran'])
    expect(runs()).toBe(1)
  })

  it('replays an answer too large to store as an empty one, still without writing', async () => {
    const big = { text: 'x'.repeat(70_000) }
    const { work, runs } = counter()
    await runIdempotent(db, { userId: ADA, key: KEY }, async () => big)
    expect(await runIdempotent(db, { userId: ADA, key: KEY }, work)).toEqual({
      state: 'replayed',
      status: 200,
      value: null,
    })
    expect(runs()).toBe(0)
  })
})

// ── The h3 wrapper ───────────────────────────────────────────────────────────
interface FakeEvent {
  headers: Record<string, string>
  status: number
  sent: Record<string, unknown>
  body?: unknown
}
const event = (headers: Record<string, string> = {}, body?: unknown): FakeEvent => ({
  headers,
  status: 200,
  sent: {},
  body,
})
const run = <T>(request: FakeEvent, userId: string, work: () => Promise<T>) =>
  idempotent(request as never, userId, work)

beforeAll(() => {
  vi.stubGlobal('getRequestHeader', (request: FakeEvent, name: string) => request.headers[name])
  vi.stubGlobal('getResponseStatus', (request: FakeEvent) => request.status)
  vi.stubGlobal('setResponseStatus', (request: FakeEvent, status: number) => {
    request.status = status
  })
  vi.stubGlobal('setResponseHeader', (request: FakeEvent, name: string, value: unknown) => {
    request.sent[name] = value
  })
  vi.stubGlobal('createError', (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
  )
})

describe('idempotent', () => {
  it('runs a request with no key as it always did, every time', async () => {
    const { work, runs } = counter()
    await run(event(), ADA, work)
    await run(event(), ADA, work)
    expect(runs()).toBe(2)
    expect(await rows()).toEqual([])
  })

  it("replays the first attempt's body and status, and marks the answer", async () => {
    const { work, runs } = counter()
    const first = event({ 'idempotency-key': KEY })
    const created = await run(first, ADA, async () => {
      first.status = 201
      return work()
    })
    expect(created).toEqual({ saved: 1 })

    const second = event({ 'idempotency-key': KEY })
    expect(await run(second, ADA, work)).toEqual({ saved: 1 })
    expect(second.status).toBe(201)
    expect(second.sent).toEqual({ 'Idempotent-Replayed': 'true' })
    expect(first.sent).toEqual({})
    expect(runs()).toBe(1)
  })

  it('answers 409 with Retry-After while the first attempt runs', async () => {
    await db.insert(schema.idempotencyKeys).values({ userId: ADA, key: KEY, createdAt: new Date() })
    const { work, runs } = counter()
    const request = event({ 'idempotency-key': KEY })
    await expect(run(request, ADA, work)).rejects.toMatchObject({ statusCode: 409 })
    expect(request.sent).toEqual({ 'Retry-After': 2 })
    expect(runs()).toBe(0)
  })

  it.each(['short', 'has spaces in the key', 'x'.repeat(65), '../../etc/passwd'])(
    'refuses the key %j',
    async (key) => {
      const { work, runs } = counter()
      await expect(run(event({ 'idempotency-key': key }), ADA, work)).rejects.toMatchObject({
        statusCode: 400,
      })
      expect(runs()).toBe(0)
    },
  )

  it('refuses a queued write made under another account, before anything else', async () => {
    const { work, runs } = counter()
    const request = event({ 'idempotency-key': KEY, 'x-outbox-owner': GRACE })
    await expect(run(request, ADA, work)).rejects.toMatchObject({ statusCode: 403 })
    expect(runs()).toBe(0)
    expect(await rows()).toEqual([])

    await run(event({ 'idempotency-key': KEY, 'x-outbox-owner': ADA }), ADA, work)
    expect(runs()).toBe(1)
  })
})

describe('the example route', () => {
  let post: (request: FakeEvent) => Promise<unknown>
  let list: (request: FakeEvent) => Promise<{ notes: Array<{ text: string }> }>
  let signedInAs = ADA

  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('requireUserSession', async () => ({ user: { id: signedInAs } }))
    vi.stubGlobal('readBody', async (request: FakeEvent) => request.body)
    post = (await import('../server/api/pwa/example/notes.post')).default as never
    list = (await import('../server/api/pwa/example/notes.get')).default as never
  })

  // Vitest runs with `import.meta.dev` unset, which is what a build has.
  it('is a 404 outside `nuxt dev`, before it reads the session', async () => {
    await expect(post(event({}, { text: 'hello' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(list(event())).rejects.toMatchObject({ statusCode: 404 })
  })

  it('adds a note once however often the same write arrives', async () => {
    // The guard reads `import.meta.dev`, which only `nuxt dev` sets.
    const example = await import('../server/utils/pwa-example')
    const guard = vi.spyOn(example, 'requirePwaExample').mockImplementation(() => {})
    signedInAs = `${ADA}-notes`
    try {
      const headers = { 'idempotency-key': KEY }
      await post(event(headers, { text: 'Squat 5x5' }))
      await post(event(headers, { text: 'Squat 5x5' }))
      await post(event({ 'idempotency-key': `${KEY}-2` }, { text: 'Row 3x8' }))
      expect((await list(event())).notes.map((note) => note.text)).toEqual(['Squat 5x5', 'Row 3x8'])
      await expect(post(event({}, { text: 'x'.repeat(61) }))).rejects.toMatchObject({
        statusCode: 400,
        message: 'A note is 1 to 60 characters long',
      })
    } finally {
      guard.mockRestore()
      signedInAs = ADA
    }
  })
})

describe('retention', () => {
  it('sweeps keys past their life, through the purge task, and no others', async () => {
    const day = 24 * 60 * 60 * 1000
    await db.insert(schema.idempotencyKeys).values([
      {
        userId: ADA,
        key: 'old-key-0001',
        createdAt: new Date(NOW - (IDEMPOTENCY_KEY_DAYS + 1) * day),
      },
      {
        userId: ADA,
        key: 'new-key-0001',
        createdAt: new Date(NOW - (IDEMPOTENCY_KEY_DAYS - 1) * day),
      },
    ])
    registerPwaExtensions()
    const sweep = getPurgeContributors().find((entry) => entry.key === 'idempotencyKeys')!
    expect(await sweep.run(db, { now: NOW })).toEqual({ count: 1, truncated: false })
    expect((await rows()).map((row) => row.key)).toEqual(['new-key-0001'])
  })

  it('is bounded per run, and says when there is more', async () => {
    await db.insert(schema.idempotencyKeys).values(
      ['a', 'b', 'c'].map((name) => ({
        userId: ADA,
        key: `old-key-${name}`,
        createdAt: new Date(0),
      })),
    )
    expect(await purgeIdempotencyKeys(db, { now: NOW, limit: 2 })).toEqual({
      count: 2,
      truncated: true,
    })
  })

  it("deletes an account's keys with the account, and nobody else's", async () => {
    await db.insert(schema.users).values([
      { id: ADA, email: 'ada@example.com', name: 'Ada' },
      { id: GRACE, email: 'grace@example.com', name: 'Grace' },
    ])
    await runIdempotent(db, { userId: ADA, key: KEY }, async () => 'a')
    await runIdempotent(db, { userId: GRACE, key: KEY }, async () => 'g')
    registerPwaExtensions()

    await deleteAccount(db, ADA)
    expect((await rows()).map((row) => row.userId)).toEqual([GRACE])
  })
})
