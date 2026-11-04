// The two primitives every token and IP hash in the app leans on.

import { describe, expect, it } from 'vitest'
import { saltedHash, timingSafeEqual } from '../server/utils/hash'

describe('timingSafeEqual', () => {
  it('is true for equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('is false for same-length strings that differ, at any position', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
    expect(timingSafeEqual('abc123', 'xbc123')).toBe(false)
  })

  it('is false for different lengths, including a prefix', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
  })

  it('treats two empty strings as equal and empty against non-empty as unequal', () => {
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('', 'a')).toBe(false)
  })
})

describe('saltedHash', () => {
  it('passes an absent or empty value through as null', async () => {
    expect(await saltedHash(null, 'salt')).toBeNull()
    expect(await saltedHash(undefined, 'salt')).toBeNull()
    expect(await saltedHash('', 'salt')).toBeNull()
  })

  it('is deterministic, hex, and never contains the value', async () => {
    const a = await saltedHash('203.0.113.5', 'salt')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await saltedHash('203.0.113.5', 'salt')).toBe(a)
    expect(a).not.toContain('203')
  })

  it('changes with the salt and with the value', async () => {
    const base = await saltedHash('203.0.113.5', 'salt-one')
    expect(await saltedHash('203.0.113.5', 'salt-two')).not.toBe(base)
    expect(await saltedHash('203.0.113.6', 'salt-one')).not.toBe(base)
  })
})
