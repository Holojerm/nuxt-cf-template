// The rate limiter's window arithmetic.
//
// consumeRateLimit takes its store and its clock as arguments precisely so this
// suite can test the boundary behaviour that matters — a window rolling over
// mid-attack — without sleeping through real seconds.

import { describe, expect, it } from 'vitest'
import { consumeRateLimit, type RateLimitStore } from '../server/utils/rate-limit'

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
