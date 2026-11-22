// The landing path is stored on the account and reported, grouped, to another
// app's database, so what matters is what it refuses to carry.

import { describe, expect, it } from 'vitest'

import { LANDING_PATTERN, landingPath } from '../shared/utils/landing-path'

const at = (path: string) => landingPath(`https://example.com${path}`)

describe('landingPath', () => {
  it('keeps the route and drops the query string, fragment and trailing slash', () => {
    expect(at('/')).toBe('/')
    expect(at('/pricing')).toBe('/pricing')
    expect(at('/Blog/Rate-Limits/?utm_source=x&email=ada@example.com#top')).toBe(
      '/blog/rate-limits',
    )
    expect(at('/blog/2026/how-to-design-a-rate-limiter')).toBe(
      '/blog/2026/how-to-design-a-rate-limiter',
    )
  })

  it('collapses ids and tokens to :id', () => {
    expect(at('/orders/18234')).toBe('/orders/:id')
    expect(at('/u/550e8400-e29b-41d4-a716-446655440000')).toBe('/u/:id')
    expect(at('/invite/k3J9xQ2mZp')).toBe('/invite/:id')
    expect(at('/g/3f9a1c7e5b2d4f6a8c0e')).toBe('/g/:id')
    expect(at('/share/ada%40example.com')).toBe('/share/:id')
    expect(at(`/t/${'a'.repeat(49)}`)).toBe('/t/:id')
  })

  it('bounds the depth and always matches the stored pattern', () => {
    const deep = at('/a/b/c/d/e/f/g/h/i/j')
    expect(deep).toBe('/a/b/c/d/e/f/g/h')
    for (const path of ['/', '/pricing', '/orders/18234', '/a/b/c/d/e/f/g/h/i/j']) {
      expect(at(path)).toMatch(LANDING_PATTERN)
    }
  })

  it('returns undefined for a URL that does not parse', () => {
    expect(landingPath('not a url')).toBeUndefined()
  })
})
