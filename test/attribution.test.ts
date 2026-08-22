// First-touch attribution: classification, and the fact that the cookie
// carrying it is written by the client and therefore hostile.
//
// The classification half is the kind of code that is silently wrong for
// months — nothing throws when every visitor gets filed under 'direct'. The
// cookie half is security-relevant: it flows into a database write on the code
// path that creates somebody's account.

import { describe, expect, it } from 'vitest'

import {
  nextAttributionCookie,
  parseAttribution,
  readAttributionCookie,
} from '../shared/utils/attribution'

const ORIGIN = 'https://example.com'

/** A structurally valid code — the generator's alphabet, the generator's length. */
const CODE = 'AB2CD3EF'

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

// ── ?ref= ───────────────────────────────────────────────────────────────────
// The one field here that eventually becomes money. It is validated to the
// exact alphabet and exact length the generator produces, because a code that
// is merely "capped at 8" would let a mistyped 9-character code be truncated
// into a valid one belonging to somebody else.

describe('parseAttribution with a referral code', () => {
  it('records the code, and files the visit under the referral program', () => {
    // The common shape by a distance: an invite pasted into a chat app, which
    // sends no referrer. Without the dedicated branch every referred signup
    // files itself under `direct` and the program becomes uncountable.
    const result = parseAttribution({ url: `${ORIGIN}/?ref=${CODE}`, referrer: '', origin: ORIGIN })
    expect(result).toMatchObject({ source: 'referral', medium: 'invite', referralCode: CODE })
  })

  it('accepts the lowercase spelling a mail client or a retype produces', () => {
    const result = parseAttribution({ url: `${ORIGIN}/?ref=${CODE.toLowerCase()}` })
    expect(result.referralCode).toBe(CODE)
  })

  it('keeps the code when an explicit UTM tag owns the channel', () => {
    // The tag wins the classification — the operator meant it — but the code is
    // a fact about the link, not a channel, and dropping it here would
    // un-credit anyone who shares through a tagged campaign.
    const result = parseAttribution({
      url: `${ORIGIN}/?utm_source=newsletter&utm_medium=email&ref=${CODE}`,
      origin: ORIGIN,
    })
    expect(result).toMatchObject({ source: 'newsletter', medium: 'email', referralCode: CODE })
  })

  it('keeps the code when the visit is a paid click, and when it is a referral', () => {
    expect(parseAttribution({ url: `${ORIGIN}/?gclid=abc&ref=${CODE}` })).toMatchObject({
      source: 'google',
      medium: 'paid',
      referralCode: CODE,
    })
    expect(
      parseAttribution({
        url: `${ORIGIN}/?ref=${CODE}`,
        referrer: 'https://news.ycombinator.com/item?id=1',
        origin: ORIGIN,
      }),
    ).toMatchObject({ source: 'referral', medium: 'invite', referralCode: CODE })
  })

  it('drops anything that is not exactly a code, rather than repairing it', () => {
    const bad = [
      'AB2CD3E', // one short
      'AB2CD3EFG', // one long — must NOT be truncated into a valid code
      'AB2CD3E!', // outside the alphabet
      'AB0CD1EF', // the confusable characters the alphabet excludes
      'x'.repeat(5000), // oversized
      '',
    ]
    for (const value of bad) {
      const result = parseAttribution({ url: `${ORIGIN}/?ref=${encodeURIComponent(value)}` })
      expect(result.referralCode).toBeUndefined()
      // …and an unusable code must not classify the visit as a referral either.
      expect(result.source).not.toBe('referral')
    }
  })
})

describe('nextAttributionCookie', () => {
  // The decision the client plugin makes on every landing. First touch owns the
  // channel; the referral code is the one field an existing cookie may be
  // missing rather than disagreeing about.
  const LANDING = { source: 'referral', medium: 'invite', referralCode: CODE }

  it('writes the whole first touch when there is no cookie', () => {
    expect(nextAttributionCookie(null, LANDING)).toEqual(LANDING)
  })

  it('leaves an ordinary return visit completely alone', () => {
    // Returning null rather than the existing value is what keeps the plugin
    // from rewriting the cookie — and therefore from extending its 90 days —
    // on every page view.
    const existing = { source: 'google.com', medium: 'organic' }
    expect(nextAttributionCookie(existing, { source: 'direct', medium: 'none' })).toBeNull()
  })

  it('fills a referral code into a cookie that has none', () => {
    // The case that was silently losing most invites: anybody who had read a
    // blog post in the last 90 days already had a cookie, so their friend's
    // link earned nothing.
    const existing = { source: 'google.com', medium: 'organic' }
    expect(nextAttributionCookie(existing, LANDING)).toEqual({
      // The channel that introduced them is untouched.
      source: 'google.com',
      medium: 'organic',
      referralCode: CODE,
    })
  })

  it('never re-credits a visitor who already arrived on another link', () => {
    const existing = { source: 'referral', medium: 'invite', referralCode: CODE }
    expect(nextAttributionCookie(existing, { ...LANDING, referralCode: 'ZZ9YY8XX' })).toBeNull()
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

  it('drops a hand-crafted referral code that is not exactly a code', () => {
    // The cookie is attacker-controlled and this field decides who gets paid,
    // so the schema is the boundary — not the page that wrote it.
    expect(
      readAttributionCookie(JSON.stringify({ source: 'direct', referralCode: 'nope' }))
        ?.referralCode,
    ).toBeUndefined()
    expect(
      readAttributionCookie(JSON.stringify({ source: 'direct', referralCode: CODE }))?.referralCode,
    ).toBe(CODE)
  })

  it('keeps a cookie that carries nothing but a referral code', () => {
    // The emptiness check has to include it, or the one field that matters is
    // the one field that can be alone and get thrown away.
    expect(readAttributionCookie(JSON.stringify({ referralCode: CODE }))).toMatchObject({
      referralCode: CODE,
    })
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
