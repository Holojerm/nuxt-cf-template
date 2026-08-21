// The transactional emails: escaping, and the plain-text alternative.
//
// Names come from OAuth providers, which means they're attacker-controllable —
// "Ada <script>" is a valid GitHub display name. These render into HTML that
// gets delivered to an inbox, so escaping is the security-relevant part.

import { describe, expect, it } from 'vitest'
import {
  accessEndedEmail,
  feedbackReplyEmail,
  paymentFailedEmail,
  purchaseEmail,
  welcomeEmail,
} from '../server/utils/email-templates'

const BRAND = { appName: 'My App', appUrl: 'https://example.com' }

describe('welcomeEmail', () => {
  it('addresses the person and links the app', () => {
    const email = welcomeEmail(BRAND, { name: 'Ada' })
    expect(email.subject).toContain('My App')
    expect(email.html).toContain('Ada')
    expect(email.html).toContain('https://example.com')
  })

  it('escapes a hostile display name', () => {
    const email = welcomeEmail(BRAND, { name: '<script>alert(1)</script>' })
    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
  })

  it('ships a plain-text alternative that is actually plain', () => {
    const email = welcomeEmail(BRAND, { name: 'Ada' })
    expect(email.text).not.toContain('<')
    expect(email.text.length).toBeGreaterThan(20)
  })
})

describe('purchaseEmail', () => {
  it('tells a subscriber it renews', () => {
    const email = purchaseEmail(BRAND, {
      name: 'Ada',
      kind: 'subscription',
      endsAt: new Date('2026-09-01T00:00:00Z'),
    })
    expect(email.subject).toContain('subscription')
    expect(email.html).toContain('September 1, 2026')
    expect(email.text).toContain('renews automatically')
  })

  it('tells a pass buyer it will not', () => {
    const email = purchaseEmail(BRAND, {
      name: 'Ada',
      kind: 'pass',
      endsAt: new Date('2026-09-20T00:00:00Z'),
    })
    expect(email.subject).toContain('pass')
    expect(email.text).toContain("won't renew")
  })

  it('omits the date when there is not one', () => {
    const email = purchaseEmail(BRAND, { name: 'Ada', kind: 'subscription', endsAt: null })
    expect(email.text).not.toContain('undefined')
    expect(email.text).not.toContain('null')
  })
})

describe('paymentFailedEmail', () => {
  it('links somewhere the card can actually be fixed', () => {
    const email = paymentFailedEmail(BRAND, { name: 'Ada' })
    expect(email.subject).toContain('Action needed')
    expect(email.html).toContain('https://example.com/account')
  })
})

describe('accessEndedEmail', () => {
  it('words a refund differently from a chargeback', () => {
    const refund = accessEndedEmail(BRAND, { name: 'Ada', reason: 'refunded' })
    const chargeback = accessEndedEmail(BRAND, { name: 'Ada', reason: 'chargeback' })

    expect(refund.text).toContain('refunded')
    expect(chargeback.text).toContain('chargeback')
    expect(refund.text).not.toBe(chargeback.text)
  })

  it('points at pricing, because coming back should be one click', () => {
    const email = accessEndedEmail(BRAND, { name: 'Ada', reason: 'canceled' })
    expect(email.html).toContain('https://example.com/pricing')
  })
})

describe('feedbackReplyEmail', () => {
  it('quotes back what the person originally wrote', () => {
    const email = feedbackReplyEmail(BRAND, {
      reply: 'Fixed in this morning\u2019s release \u2014 thanks for the report.',
      originalMessage: 'The export button does nothing on Safari',
    })
    expect(email.html).toContain('The export button does nothing on Safari')
    expect(email.subject).toContain('My App')
  })

  it('escapes the original message, which anyone on the internet can write', () => {
    // POST /api/feedback is public by design, so this string is genuinely
    // attacker-supplied — and it ends up in an email we send from our domain.
    const email = feedbackReplyEmail(BRAND, {
      reply: 'Thanks!',
      originalMessage: '<img src=x onerror="alert(1)">',
    })
    expect(email.html).not.toContain('<img')
    expect(email.html).toContain('&lt;img')
  })

  it('truncates a very long original rather than mailing the whole essay back', () => {
    const email = feedbackReplyEmail(BRAND, {
      reply: 'Noted.',
      originalMessage: 'x'.repeat(2000),
    })
    expect(email.html).toContain('\u2026')
    expect(email.html.length).toBeLessThan(4000)
  })

  it('ships a plain-text alternative', () => {
    const email = feedbackReplyEmail(BRAND, { reply: 'Thanks!', originalMessage: 'Hello' })
    expect(email.text).not.toContain('<')
    expect(email.text).toContain('Thanks!')
  })
})
