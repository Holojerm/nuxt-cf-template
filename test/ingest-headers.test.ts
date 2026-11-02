// What server/routes/ingest/[...path].ts is allowed to forward upstream to
// PostHog.
//
// h3's `proxyRequest` copies every incoming header except an eight-entry
// ignore list that does NOT include `cookie` or `authorization` — and because
// the SDK is pointed at this same-origin proxy, the browser attaches this
// app's sealed session cookie to every analytics request. This suite pins the
// fix: the proxy builds its upstream headers from an explicit allowlist, so a
// request carrying a session cookie produces an upstream fetch without one.

import { describe, expect, it } from 'vitest'

import { forwardedIngestHeaders, refererWithoutQuery } from '../server/utils/ingest-headers'

describe('forwardedIngestHeaders', () => {
  it('never forwards Cookie or Authorization, no matter what the request carries', () => {
    const headers = forwardedIngestHeaders({
      cookie: 'nuxt-session=s%3Aabc123.signature',
      authorization: 'Bearer live-token',
      'content-type': 'application/json',
    })

    expect(headers).not.toHaveProperty('cookie')
    expect(headers).not.toHaveProperty('authorization')
    expect(JSON.stringify(headers)).not.toContain('nuxt-session')
    expect(JSON.stringify(headers)).not.toContain('live-token')
  })

  it('forwards the allowlisted headers that were present', () => {
    const headers = forwardedIngestHeaders({
      'content-type': 'application/json',
      'content-length': '128',
      'user-agent': 'Mozilla/5.0 (test)',
      'accept-language': 'en-US',
    })

    expect(headers).toEqual({
      'content-type': 'application/json',
      'content-length': '128',
      'user-agent': 'Mozilla/5.0 (test)',
      'accept-language': 'en-US',
    })
  })

  it('drops query and fragment from a parseable Referer', () => {
    const headers = forwardedIngestHeaders({
      referer: 'https://app.example.com/compare?from=branch-1&to=branch-2#section',
    })
    expect(headers.referer).toBe('https://app.example.com/compare')
  })

  it('omits Referer entirely when it cannot be parsed as a URL', () => {
    const headers = forwardedIngestHeaders({ referer: 'not a url' })
    expect(headers).not.toHaveProperty('referer')
  })

  it('omits Referer entirely when it is missing', () => {
    const headers = forwardedIngestHeaders({})
    expect(headers).not.toHaveProperty('referer')
  })

  it('omits any header not on the allowlist, even an unusual one', () => {
    const headers = forwardedIngestHeaders({
      'x-forwarded-for': '203.0.113.5',
      'x-real-ip': '203.0.113.5',
    })
    expect(headers).toEqual({})
  })

  it('ignores headers whose incoming value is undefined', () => {
    const headers = forwardedIngestHeaders({ 'content-type': undefined })
    expect(headers).toEqual({})
  })
})

describe('forwardedIngestHeaders › forwardClientIp', () => {
  it('sends no client address unless asked — the default', () => {
    const headers = forwardedIngestHeaders({
      'cf-connecting-ip': '203.0.113.5',
      'x-forwarded-for': '198.51.100.7',
    })
    expect(headers).toEqual({})
  })

  it('forwards cf-connecting-ip as the one x-forwarded-for when asked', () => {
    const headers = forwardedIngestHeaders(
      { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      { forwardClientIp: true },
    )
    expect(headers).toEqual({ 'x-forwarded-for': '203.0.113.5' })
  })

  it('falls back to the first x-forwarded-for entry, never the whole chain', () => {
    const headers = forwardedIngestHeaders(
      { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      { forwardClientIp: true },
    )
    expect(headers['x-forwarded-for']).toBe('198.51.100.7')
  })

  it('adds nothing when the request carries no address at all', () => {
    expect(forwardedIngestHeaders({}, { forwardClientIp: true })).toEqual({})
  })

  it('still never forwards Cookie or Authorization with the address on', () => {
    const headers = forwardedIngestHeaders(
      { cookie: 'nuxt-session=abc', authorization: 'Bearer t', 'cf-connecting-ip': '203.0.113.5' },
      { forwardClientIp: true },
    )
    expect(Object.keys(headers)).toEqual(['x-forwarded-for'])
  })
})

describe('refererWithoutQuery', () => {
  it('keeps origin and path, drops query and fragment', () => {
    expect(refererWithoutQuery('https://app.example.com/athletes/a1?tab=history#top')).toBe(
      'https://app.example.com/athletes/a1',
    )
  })

  it('returns undefined — drop, not preserve — for an unparseable value', () => {
    expect(refererWithoutQuery('not a url')).toBeUndefined()
  })

  it('returns undefined for a missing value', () => {
    expect(refererWithoutQuery(undefined)).toBeUndefined()
    expect(refererWithoutQuery('')).toBeUndefined()
  })
})
