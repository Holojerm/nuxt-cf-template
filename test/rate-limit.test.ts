// The rate limiter: its window arithmetic, and which of its two backends runs.
//
// consumeRateLimit takes its store and its clock as arguments precisely so this
// suite can test the boundary behaviour that matters — a window rolling over
// mid-attack — without sleeping through real seconds. consumeRateLimitWithFallback
// takes the native binding the same way, for the same reason.

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  chooseBackend,
  consumeRateLimit,
  consumeRateLimitWithFallback,
  NATIVE_LIMITER,
  type NativeRateLimiter,
  type RateLimitStore,
} from '../server/utils/rate-limit'

/** Map-backed stand-in for unstorage. TTL is recorded, not enforced — the keys
 *  are window-scoped, so expiry is housekeeping rather than correctness. */
function makeStore(): RateLimitStore & { size: () => number } {
  const data = new Map<string, unknown>()
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => data.set(key, value),
    size: () => data.size,
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

const THROWING_NATIVE: NativeRateLimiter = {
  limit: async () => {
    throw new Error('binding exploded')
  },
}

describe('consumeRateLimit', () => {
  it('allows up to the limit and then blocks', async () => {
    const store = makeStore()
    const now = 1_000_000_000_000

    const first = await consumeRateLimit(store, OPTS, now)
    expect(first).toMatchObject({ allowed: true, remaining: 2 })

    await consumeRateLimit(store, OPTS, now)
    const third = await consumeRateLimit(store, OPTS, now)
    expect(third).toMatchObject({ allowed: true, remaining: 0 })

    const fourth = await consumeRateLimit(store, OPTS, now)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
  })

  it('does not consume budget once blocked', async () => {
    // A blocked request must not write, or a client that keeps hammering keeps
    // pushing the counter up and never recovers within the window.
    const store = makeStore()
    const now = 1_000_000_000_000
    for (let i = 0; i < 5; i++) await consumeRateLimit(store, OPTS, now)

    expect(store.size()).toBe(1)
    expect(await store.get('ratelimit:login:1.2.3.4:16666666')).toBe(3)
  })

  it('resets when the window rolls over', async () => {
    const store = makeStore()
    const now = 1_000_000_000_000

    for (let i = 0; i < 3; i++) await consumeRateLimit(store, OPTS, now)
    expect((await consumeRateLimit(store, OPTS, now)).allowed).toBe(false)

    const nextWindow = now + 60_000
    expect((await consumeRateLimit(store, OPTS, nextWindow)).allowed).toBe(true)
  })

  it('reports seconds until reset, for Retry-After', async () => {
    const store = makeStore()
    // Windows are aligned to absolute epoch time, not to first contact:
    // 1_000_000_020s is a multiple of 60, so this is 15 seconds in → 45 left.
    const now = 1_000_000_035_000
    const result = await consumeRateLimit(store, OPTS, now)
    expect(result.resetSeconds).toBe(45)
  })

  it('keeps separate callers in separate buckets', async () => {
    const store = makeStore()
    const now = 1_000_000_000_000

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

  it('coerces a stringified count rather than producing NaN', async () => {
    // KV can hand back a string for a value written by another runtime; NaN >= 3
    // is false, which would silently disable the limit.
    const store = makeStore()
    const now = 1_000_000_000_000
    await store.set('ratelimit:login:1.2.3.4:16666666', '3')

    expect((await consumeRateLimit(store, OPTS, now)).allowed).toBe(false)
  })
})

describe('chooseBackend', () => {
  it('picks the native binding when both numbers match what it was deployed with', () => {
    const native = makeNative([])
    expect(chooseBackend(native, MATCHED)).toEqual({ backend: 'native', native })
  })

  it('falls back to KV when there is no binding', () => {
    // The `nuxt build` output on a non-Cloudflare preset, a trimmed
    // wrangler.toml, a wrangler too old to know the binding. None of them throw.
    expect(chooseBackend(undefined, MATCHED)).toEqual({
      backend: 'kv',
      reason: 'binding-absent',
    })
  })

  it('falls back to KV for a window the binding was not deployed for', () => {
    // The real case: mcp-connect-code wants 10 per 300s. The platform only
    // permits periods of 10 or 60, so no binding could serve this one.
    expect(chooseBackend(makeNative([]), { limit: 10, windowSeconds: 300 })).toEqual({
      backend: 'kv',
      reason: 'window-mismatch',
    })
  })

  it('falls back to KV when the limit differs, rather than enforcing the wrong one', () => {
    // /api/auth/dev asks for 20/60s. The binding is 30/60s and cannot be told
    // otherwise at call time, so delegating would enforce 30 while the response
    // header promised 20. This is the case the exact-match rule exists for.
    expect(chooseBackend(makeNative([]), { limit: 20, windowSeconds: 60 })).toEqual({
      backend: 'kv',
      reason: 'limit-mismatch',
    })
  })
})

describe('consumeRateLimitWithFallback', () => {
  it('spends the request against the native binding, keyed the same way', async () => {
    const native = makeNative([true])
    const store = makeStore()

    const verdict = await consumeRateLimitWithFallback(
      { native, store },
      { ...MATCHED, key: 'auth:1.2.3.4' },
    )

    expect(verdict.backend).toBe('native')
    expect(verdict.allowed).toBe(true)
    expect(native.keys).toEqual(['auth:1.2.3.4'])
    // Nothing was written to KV — the two backends do not double-count.
    expect(store.size()).toBe(0)
  })

  it('reports remaining as unknown when the binding allows, and 0 when it blocks', async () => {
    // The binding answers `{ success }` and nothing else. `null` is what makes
    // rateLimit() omit X-RateLimit-Remaining rather than invent a number for it;
    // 0 on a block is the one count the boolean does tell us.
    const native = makeNative([true, false])
    const store = makeStore()
    const opts = { ...MATCHED, key: 'auth:1.2.3.4' }

    expect((await consumeRateLimitWithFallback({ native, store }, opts)).remaining).toBeNull()

    const blocked = await consumeRateLimitWithFallback({ native, store }, opts)
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 })
    // No reset clock is exposed, so Retry-After is the whole period: an upper
    // bound, which is the safe direction to be wrong in.
    expect(blocked.resetSeconds).toBe(NATIVE_LIMITER.windowSeconds)
  })

  it('gives the KV path results identical to calling consumeRateLimit directly', async () => {
    const opts = { key: 'mcp:user_1', limit: 3, windowSeconds: 300 }
    const now = 1_000_000_035_000

    const direct = makeStore()
    const viaFallback = makeStore()

    for (let i = 0; i < 4; i++) {
      const a = await consumeRateLimit(direct, opts, now)
      const b = await consumeRateLimitWithFallback(
        { native: makeNative([]), store: viaFallback },
        opts,
        now,
      )
      expect(b).toMatchObject({ ...a, backend: 'kv', reason: 'window-mismatch' })
    }
  })

  it('fails open when the binding throws', async () => {
    // An outage in the abuse-control layer must not take the product down. It
    // also must not quietly fall through to KV: one broken backend paying two
    // backends' latency is worse, and a binding that never gets used is a
    // binding whose breakage nobody notices.
    const store = makeStore()

    const verdict = await consumeRateLimitWithFallback(
      { native: THROWING_NATIVE, store },
      { ...MATCHED, key: 'auth:1.2.3.4' },
    )

    expect(verdict).toMatchObject({ allowed: true, backend: 'unavailable', remaining: null })
    expect(verdict.error).toContain('binding exploded')
    expect(store.size()).toBe(0)
  })

  it('fails open when the KV store throws', async () => {
    const exploding: RateLimitStore = {
      get: async () => {
        throw new Error('kv is not defined')
      },
      set: async () => undefined,
    }

    const verdict = await consumeRateLimitWithFallback({ store: exploding }, OPTS)
    expect(verdict).toMatchObject({ allowed: true, backend: 'unavailable' })
  })
})

describe('the deployed binding', () => {
  // vitest.config.ts points the workers pool at the real wrangler.toml, so
  // `env` here holds the same bindings production gets. These two facts cannot
  // be asserted from the TypeScript side alone, and both fail silently in
  // production: a missing binding means every call site quietly uses KV, and a
  // limit that no longer matches NATIVE_LIMITER means the one endpoint the
  // binding was sized for quietly uses KV too.

  it('exists under the name server/utils/rate-limit.ts looks for', () => {
    const binding = (env as unknown as Record<string, unknown>)[NATIVE_LIMITER.binding]
    expect(
      binding,
      `no [[ratelimits]] block named ${NATIVE_LIMITER.binding} in wrangler.toml`,
    ).toBeDefined()
    expect(typeof (binding as NativeRateLimiter | undefined)?.limit).toBe('function')
  })

  it('enforces exactly the limit NATIVE_LIMITER claims it does', async () => {
    const limiter = (env as unknown as Record<string, NativeRateLimiter>)[NATIVE_LIMITER.binding]
    // Unique per run: the binding's counters are keyed globally within the
    // miniflare instance and outlive an individual `it`.
    const key = `drift-check:${crypto.randomUUID()}`

    for (let i = 0; i < NATIVE_LIMITER.limit; i++) {
      expect(
        (await limiter.limit({ key })).success,
        `request ${i + 1} was refused, so wrangler.toml permits fewer than ${NATIVE_LIMITER.limit}`,
      ).toBe(true)
    }

    expect(
      (await limiter.limit({ key })).success,
      `request ${NATIVE_LIMITER.limit + 1} was allowed — wrangler.toml's simple.limit is higher ` +
        'than NATIVE_LIMITER.limit, so the auth surface is enforcing a number nobody wrote down',
    ).toBe(false)
  })
})
