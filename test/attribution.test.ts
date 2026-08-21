// First-touch attribution: classification, and the fact that the cookie
// carrying it is written by the client and therefore hostile.
//
// The classification half is the kind of code that is silently wrong for
// months — nothing throws when every visitor gets filed under 'direct'. The
// cookie half is security-relevant: it flows into a database write on the code
// path that creates somebody's account.

import { describe, expect, it } from 'vitest'

import { parseAttribution, readAttributionCookie } from '../shared/utils/attribution'

const ORIGIN = 'https://example.com'

describe('parseAttribution', () => {
  it('prefers explicit UTM tags over the referrer', () => {
    const result = parseAttribution({
      url: `${ORIGIN}/?utm_source=newsletter&utm_medium=email&utm_campaign=launch`,
      referrer: 'https://news.ycombinator.com/item?id=1',
      origin: ORIGIN,
    })
    expect(result.source).toBe('newsletter')
    expect(result.medium).toBe('email')
    expect(result.campaign).toBe('launch')
  })

  it('recognises an ad click id with no utm_source', () => {
    const result = parseAttribution({ url: `${ORIGIN}/?gclid=abc123`, origin: ORIGIN })
    expect(result).toMatchObject({ source: 'google', medium: 'paid' })
  })

  it('classifies a search engine as organic, not a plain referral', () => {
    const result = parseAttribution({
      url: `${ORIGIN}/`,
      referrer: 'https://www.google.com/search?q=thing',
      origin: ORIGIN,
    })
    expect(result).toMatchObject({ source: 'google.com', medium: 'organic' })
  })

  it('separates answer engines from ordinary referrals', () => {
    const result = parseAttribution({
      url: `${ORIGIN}/`,
      referrer: 'https://chatgpt.com/c/abc',
      origin: ORIGIN,
    })
    expect(result).toMatchObject({ source: 'chatgpt.com', medium: 'ai' })
  })

  it('treats an unknown site as a referral and keeps the full URL', () => {
    const result = parseAttribution({
      url: `${ORIGIN}/`,
      referrer: 'https://news.ycombinator.com/item?id=1',
      origin: ORIGIN,
    })
    expect(result).toMatchObject({ source: 'news.ycombinator.com', medium: 'referral' })
    expect(result.referrer).toBe('https://news.ycombinator.com/item?id=1')
  })

  it('does not count an internal navigation as an arrival', () => {
    const result = parseAttribution({
      url: `${ORIGIN}/pricing`,
      referrer: `${ORIGIN}/`,
      origin: ORIGIN,
    })
    expect(result).toMatchObject({ source: 'direct', medium: 'none' })
    expect(result.referrer).toBeUndefined()
  })

  it('records a bare visit as direct rather than as nothing', () => {
    const result = parseAttribution({ url: `${ORIGIN}/`, referrer: '', origin: ORIGIN })
    expect(result).toMatchObject({ source: 'direct', medium: 'none' })
  })

  it('survives junk instead of throwing on the signup path', () => {
    expect(() =>
      parseAttribution({ url: 'not a url', referrer: 'also not', origin: ORIGIN }),
    ).not.toThrow()
    expect(parseAttribution({ url: 'not a url', origin: ORIGIN }).source).toBe('direct')
  })
})

describe('readAttributionCookie', () => {
  it('reads back what the plugin wrote', () => {
    const written = encodeURIComponent(
      JSON.stringify({ source: 'newsletter', medium: 'email', campaign: 'launch' }),
    )
    expect(readAttributionCookie(written)).toMatchObject({ source: 'newsletter', medium: 'email' })
  })

  it('returns null for an absent or unparseable cookie', () => {
    expect(readAttributionCookie(undefined)).toBeNull()
    expect(readAttributionCookie('{{{')).toBeNull()
    expect(readAttributionCookie('"a string"')).toBeNull()
  })

  it('returns null when there is nothing to record', () => {
    expect(readAttributionCookie(JSON.stringify({}))).toBeNull()
  })

  it('drops an oversized field rather than storing it', () => {
    const parsed = readAttributionCookie(
      JSON.stringify({ source: 'x'.repeat(5000), medium: 'email' }),
    )
    // The whole object must not be rejected — the usable half survives.
    expect(parsed).toMatchObject({ medium: 'email' })
    expect(parsed?.source).toBeUndefined()
  })

  it('ignores unexpected properties instead of passing them through', () => {
    const parsed = readAttributionCookie(
      JSON.stringify({ source: 'newsletter', role: 'admin', userId: 'somebody-else' }),
    )
    expect(parsed).toEqual({
      source: 'newsletter',
      medium: undefined,
      campaign: undefined,
      referrer: undefined,
    })
  })
})
