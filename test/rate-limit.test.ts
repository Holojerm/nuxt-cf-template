// The rate limiter: its window arithmetic, that its count is exact when
// requests arrive together, and that the native limiter can refuse a request
// but can never let one past the count.
//
// consumeRateLimit takes its store and its clock as arguments so this suite
// can test a window rolling over mid-attack without sleeping through real
// seconds. checkRateLimit takes the native bindings the same way.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import WRANGLER_TOML from '../wrangler.toml?raw'
import * as schema from '../server/db/schema'
import {
  checkRateLimit,
  clearNativeLimitersForTest,
  consumeRateLimit,
  d1RateLimitStore,
  getNativeLimiters,
  NATIVE_LIMITER,
  nativeFor,
  pruneRateLimits,
  registerNativeLimiter,
  type NativeRateLimiter,
  type RateLimitStore,
} from '../server/utils/rate-limit'

const db = drizzle(env.DB, { schema })

/** A counter in memory. One JavaScript statement per hit, so it is atomic too. */
function makeStore(): RateLimitStore & { buckets: () => string[]; hits: () => number } {
  const data = new Map<string, number>()
  let hits = 0
  return {
    async hit(bucket, _expiresAt, cost) {
      hits += 1
      const count = (data.get(bucket) ?? 0) + cost
      data.set(bucket, count)
      return count
    },
    buckets: () => [...data.keys()],
    hits: () => hits,
  }
}

const OPTS = { key: 'login:1.2.3.4', limit: 3, windowSeconds: 60 }

/** The shape wrangler.toml's `[[ratelimits]]` block is declared with. */
const MATCHED = { limit: NATIVE_LIMITER.limit, windowSeconds: NATIVE_LIMITER.windowSeconds }

/** Stand-in for `env.RATE_LIMITER`, recording what it was asked. */
function makeNative(verdicts: boolean[]): NativeRateLimiter & { keys: string[] } {
  const keys: string[] = []
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key)
      return { success: verdicts[keys.length - 1] ?? true }
    },
  }
}

/** The core binding resolved, as resolveNativeLimiters() would hand it over. */
const natives = (native: NativeRateLimiter) => ({ [NATIVE_LIMITER.binding]: native })

const THROWING_NATIVE: NativeRateLimiter = {
  limit: async () => {
    throw new Error('binding exploded')
  },
}

describe('consumeRateLimit', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 30)

  it('allows up to the limit, then blocks, counting down what is left', async () => {
    const store = makeStore()
    expect(await consumeRateLimit(store, OPTS, now)).toMatchObject({ allowed: true, remaining: 2 })
    await consumeRateLimit(store, OPTS, now)
    expect(await consumeRateLimit(store, OPTS, now)).toMatchObject({ allowed: true, remaining: 0 })
    expect(await consumeRateLimit(store, OPTS, now)).toMatchObject({ allowed: false, remaining: 0 })
  })

  it('keeps counting a blocked caller, and stays blocked', async () => {
    const store = makeStore()
    for (let i = 0; i < 10; i++) await consumeRateLimit(store, OPTS, now)
    expect((await consumeRateLimit(store, OPTS, now)).allowed).toBe(false)
    expect(store.hits()).toBe(11)
  })

  it('reports the seconds left in the window, and starts again in the next one', async () => {
    const store = makeStore()
    for (let i = 0; i < 3; i++) await consumeRateLimit(store, OPTS, now)
    const blocked = await consumeRateLimit(store, OPTS, now)
    expect(blocked).toMatchObject({ allowed: false, resetSeconds: 30 })
    expect((await consumeRateLimit(store, OPTS, now + 30_000)).allowed).toBe(true)
  })

  it('counts each caller on their own', async () => {
    const store = makeStore()
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit(store, { ...OPTS, key: 'login:1.1.1.1' }, now)
    }
    expect((await consumeRateLimit(store, { ...OPTS, key: 'login:1.1.1.1' }, now)).allowed).toBe(
      false,
    )
    expect((await consumeRateLimit(store, { ...OPTS, key: 'login:2.2.2.2' }, now)).allowed).toBe(
      true,
    )
  })

  it('spends `cost` in one go, and refuses a batch that does not fit', async () => {
    const store = makeStore()
    const batch = { ...OPTS, limit: 10, cost: 4 }
    expect(await consumeRateLimit(store, batch, now)).toMatchObject({ allowed: true, remaining: 6 })
    expect(await consumeRateLimit(store, batch, now)).toMatchObject({ allowed: true, remaining: 2 })
    // Four more would make twelve: the whole batch is refused, not half of it.
    expect(await consumeRateLimit(store, batch, now)).toMatchObject({
      allowed: false,
      remaining: 0,
    })
  })

  it('never hands the store the address or mailbox in the key', async () => {
    const store = makeStore()
    await consumeRateLimit(store, { ...OPTS, key: 'login:ann@example.com' }, now)
    expect(store.buckets()).toHaveLength(1)
    expect(store.buckets()[0]).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the counter in D1', () => {
  beforeEach(async () => {
    await db.delete(schema.rateLimits)
  })

  // The whole reason this backend exists. A counter that reads and then writes
  // (KV) let 75 simultaneous requests through as 10.
  it('is exact when fifty requests arrive at once', async () => {
    const store = d1RateLimitStore(db)
    const opts = { key: 'sign-in:ann', limit: 5, windowSeconds: 60 }
    const verdicts = await Promise.all(
      Array.from({ length: 50 }, () => consumeRateLimit(store, opts)),
    )
    expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(5)
    const [row] = await db.select().from(schema.rateLimits)
    expect(row?.count).toBe(50)
  })

  it("adds a batch's cost in the same single statement", async () => {
    const store = d1RateLimitStore(db)
    const opts = { key: 'mcp:ann', limit: 100, windowSeconds: 60, cost: 7 }
    await Promise.all(Array.from({ length: 10 }, () => consumeRateLimit(store, opts)))
    const [row] = await db.select().from(schema.rateLimits)
    expect(row?.count).toBe(70)
  })

  it('keeps a hash, not the key, and one row per caller and window', async () => {
    const store = d1RateLimitStore(db)
    const now = Date.UTC(2026, 0, 1, 12, 0, 30)
    await consumeRateLimit(store, { ...OPTS, key: 'login:203.0.113.4' }, now)
    await consumeRateLimit(store, { ...OPTS, key: 'login:203.0.113.4' }, now)
    await consumeRateLimit(store, { ...OPTS, key: 'login:203.0.113.5' }, now)
    await consumeRateLimit(store, { ...OPTS, key: 'login:203.0.113.4' }, now + 60_000)
    const rows = await db.select().from(schema.rateLimits)
    expect(rows.map((row) => row.count).toSorted()).toEqual([1, 1, 2])
    expect(JSON.stringify(rows)).not.toContain('203.0.113')
  })

  it('is pruned once its window is over, and not before', async () => {
    const store = d1RateLimitStore(db)
    const now = Date.UTC(2026, 0, 1, 12, 0, 30)
    await consumeRateLimit(store, OPTS, now)
    expect(await pruneRateLimits(db, new Date(now + 20_000))).toBe(0)
    expect(await pruneRateLimits(db, new Date(now + 31_000))).toBe(1)
    expect(await db.select().from(schema.rateLimits)).toEqual([])
  })
})

describe('nativeFor', () => {
  it('gives a call site the native limiter only when both numbers match', () => {
    const native = makeNative([])
    expect(nativeFor(natives(native), MATCHED)).toBe(native)
    expect(nativeFor(natives(native), { limit: 20, windowSeconds: 60 })).toBeUndefined()
    expect(nativeFor(natives(native), { limit: 30, windowSeconds: 300 })).toBeUndefined()
  })

  it('gives none where the Worker has no binding', () => {
    expect(nativeFor(undefined, MATCHED)).toBeUndefined()
    expect(nativeFor({}, MATCHED)).toBeUndefined()
  })
})

describe('checkRateLimit', () => {
  const opts = { key: 'auth:1.2.3.4', ...MATCHED }

  it('is refused by the native limiter without spending a count', async () => {
    const store = makeStore()
    const native = makeNative([false])
    expect(await checkRateLimit({ natives: natives(native), store }, opts)).toEqual({
      allowed: false,
      backend: 'native',
      remaining: 0,
      resetSeconds: opts.windowSeconds,
    })
    expect(store.hits()).toBe(0)
  })

  // What production did in November 2026: the binding answered "success" to
  // every request on a fresh connection. The count has to stop them anyway.
  it('is stopped by the count however long the native limiter keeps saying yes', async () => {
    const store = makeStore()
    const native = makeNative([])
    const backends = { natives: natives(native), store }
    const verdicts = []
    for (let i = 0; i < opts.limit + 5; i++) verdicts.push(await checkRateLimit(backends, opts))
    expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(opts.limit)
    expect(verdicts.at(-1)).toMatchObject({ allowed: false, backend: 'd1', remaining: 0 })
    expect(native.keys).toHaveLength(opts.limit + 5)
  })

  it('lets the native limiter decide alone for a call site that asked for a loose limit', async () => {
    const store = makeStore()
    const native = makeNative([true, false])
    const backends = { natives: natives(native), store }
    expect(await checkRateLimit(backends, { ...opts, exact: false })).toEqual({
      allowed: true,
      backend: 'native',
      remaining: null,
      resetSeconds: opts.windowSeconds,
    })
    expect(await checkRateLimit(backends, { ...opts, exact: false })).toMatchObject({
      allowed: false,
      backend: 'native',
    })
    expect(store.hits()).toBe(0)
  })

  it('still counts a loose call site that no native limiter matches, or whose binding throws', async () => {
    const store = makeStore()
    expect(
      await checkRateLimit({ natives: natives(makeNative([])), store }, { ...OPTS, exact: false }),
    ).toMatchObject({ allowed: true, backend: 'd1' })
    expect(
      await checkRateLimit({ natives: natives(THROWING_NATIVE), store }, { ...opts, exact: false }),
    ).toMatchObject({ allowed: true, backend: 'd1' })
    expect(store.hits()).toBe(2)
  })

  it('goes straight to the count for a call site with no native limiter', async () => {
    const store = makeStore()
    const native = makeNative([false])
    const verdict = await checkRateLimit({ natives: natives(native), store }, OPTS)
    expect(verdict).toMatchObject({ allowed: true, backend: 'd1', remaining: 2 })
    expect(native.keys).toEqual([])
  })

  it('still counts when the native binding throws', async () => {
    const store = makeStore()
    const verdict = await checkRateLimit({ natives: natives(THROWING_NATIVE), store }, opts)
    expect(verdict).toMatchObject({ allowed: true, backend: 'd1' })
    expect(store.hits()).toBe(1)
  })

  it('fails open, and says so, when the count cannot be taken', async () => {
    const exploding: RateLimitStore = {
      hit: async () => {
        throw new Error('D1 is down')
      },
    }
    expect(await checkRateLimit({ store: exploding }, OPTS)).toEqual({
      allowed: true,
      backend: 'unavailable',
      remaining: null,
      resetSeconds: 0,
      error: 'Error: D1 is down',
    })
  })
})

describe('the RATE_LIMITER binding', () => {
  // vitest.config.ts points the workers pool at the real wrangler.toml, so
  // `env` here holds the same bindings production gets. Neither fact can be
  // asserted from the TypeScript side alone, and both fail silently: without
  // the binding, or with numbers NATIVE_LIMITER does not claim, the auth
  // surface loses its first check and every flood costs a D1 write.

  it('exists under the name server/utils/rate-limit.ts looks for', () => {
    const binding = (env as unknown as Record<string, unknown>)[NATIVE_LIMITER.binding]
    expect(
      binding,
      `no [[ratelimits]] block named ${NATIVE_LIMITER.binding} in wrangler.toml`,
    ).toBeDefined()
    expect(typeof (binding as NativeRateLimiter | undefined)?.limit).toBe('function')
  })

  // The limit itself is read from wrangler.toml rather than by exhausting the binding: its
  // windows are aligned to the wall clock, so a run that straddled a boundary let the extra
  // call through and failed a fork's Workers Build, and a retry loop only made that rarer.
  // miniflare builds the binding from this same file, so the text is the deployed number.
  it('is declared with exactly the numbers NATIVE_LIMITER claims, in every environment', () => {
    const blocks = [
      ...WRANGLER_TOML.matchAll(/^\[\[(?:env\.(\w+)\.)?ratelimits\]\]\n((?:(?!\[).*\n?)*)/gm),
    ]
      .map(([, envName, body]) => ({
        env: envName ?? 'production',
        name: /^name\s*=\s*"([^"]+)"/m.exec(body!)?.[1],
        limit: Number(/limit\s*=\s*(\d+)/.exec(body!)?.[1]),
        period: Number(/period\s*=\s*(\d+)/.exec(body!)?.[1]),
      }))
      .filter((block) => block.name === NATIVE_LIMITER.binding)

    expect(
      blocks.map((b) => b.env),
      `no [[ratelimits]] block named ${NATIVE_LIMITER.binding}`,
    ).toContain('production')
    for (const block of blocks) {
      expect(
        { limit: block.limit, period: block.period },
        `wrangler.toml (${block.env}) declares numbers NATIVE_LIMITER does not claim, so the ` +
          'auth surface would lose its first check',
      ).toEqual({ limit: NATIVE_LIMITER.limit, period: NATIVE_LIMITER.windowSeconds })
    }
  })
})

describe('registerNativeLimiter', () => {
  const GAME_CREATE = { binding: 'GAME_CREATE_LIMITER', limit: 5, windowSeconds: 60 } as const

  afterEach(() => clearNativeLimitersForTest())

  it("starts with core's limiter only, so nothing changes until an app registers", () => {
    expect(getNativeLimiters()).toEqual([NATIVE_LIMITER])
  })

  it('gives a call site matching the registered budget its own binding', () => {
    registerNativeLimiter(GAME_CREATE)
    const auth = makeNative([])
    const create = makeNative([])
    const both = { [NATIVE_LIMITER.binding]: auth, [GAME_CREATE.binding]: create }

    expect(nativeFor(both, MATCHED)).toBe(auth)
    expect(nativeFor(both, { limit: 5, windowSeconds: 60 })).toBe(create)
  })

  it('gives none for a budget no binding was deployed for', () => {
    registerNativeLimiter(GAME_CREATE)
    const only = { [NATIVE_LIMITER.binding]: makeNative([]) }
    expect(nativeFor(only, { limit: 20, windowSeconds: 60 })).toBeUndefined()
    // Registered by the app, but its wrangler.toml block is missing (a preview
    // env that forgot to repeat it): no first check, and no TypeError.
    expect(nativeFor(only, { limit: 5, windowSeconds: 60 })).toBeUndefined()
  })

  it('asks the binding that matches, and no other', async () => {
    registerNativeLimiter(GAME_CREATE)
    const auth = makeNative([])
    const create = makeNative([true, false])
    const backends = {
      natives: { [NATIVE_LIMITER.binding]: auth, [GAME_CREATE.binding]: create },
      store: makeStore(),
    }
    const opts = { key: 'game-create:1.2.3.4', limit: 5, windowSeconds: 60 }

    expect((await checkRateLimit(backends, opts)).allowed).toBe(true)
    expect(await checkRateLimit(backends, opts)).toMatchObject({
      allowed: false,
      backend: 'native',
      remaining: 0,
    })
    expect(create.keys).toEqual([opts.key, opts.key])
    expect(auth.keys).toEqual([])
  })

  it("refuses core's binding and a duplicate budget under another name", () => {
    expect(() => registerNativeLimiter({ ...GAME_CREATE, binding: 'RATE_LIMITER' })).toThrow(
      /core's own/,
    )
    expect(() =>
      registerNativeLimiter({
        binding: 'ANOTHER',
        limit: NATIVE_LIMITER.limit,
        windowSeconds: NATIVE_LIMITER.windowSeconds,
      }),
    ).toThrow(/duplicates RATE_LIMITER/)
  })

  it('replaces rather than duplicates a spec registered twice', () => {
    registerNativeLimiter(GAME_CREATE)
    registerNativeLimiter(GAME_CREATE)
    expect(getNativeLimiters()).toHaveLength(2)
  })
})
