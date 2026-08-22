// List-Unsubscribe wiring on outbound mail.
//
// buildResendEmailRequest() is pure (no network, no runtime config), so most
// of this is direct assertions on its output — matching how
// test/billing-notifications.test.ts tests decideNotification() rather than
// the network-touching function that calls it. One test at the bottom drives
// sendEmail() itself, with fetch and useRuntimeConfig stubbed, to prove the
// wiring from options to the actual POST body is intact end to end.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildResendEmailRequest, sendEmail } from '../server/utils/email'
import type { SendEmailOptions } from '../server/utils/email'

const BASE: SendEmailOptions = {
  to: 'ada@example.com',
  subject: 'Hello',
  html: '<!doctype html><html><body><p>Hi</p></body></html>',
  text: 'Hi',
}

describe('buildResendEmailRequest — no unsubscribe option', () => {
  it('carries no headers field at all', () => {
    const body = buildResendEmailRequest(BASE, 'App <hello@example.com>')
    expect(body.headers).toBeUndefined()
    expect(body.html).toBe(BASE.html)
    expect(body.text).toBe(BASE.text)
  })
})

describe('buildResendEmailRequest — optional event type', () => {
  const url = 'https://example.com/api/email/unsubscribe?u=user-1&e=welcome&t=abc'

  it('attaches List-Unsubscribe and List-Unsubscribe-Post', () => {
    const body = buildResendEmailRequest(
      { ...BASE, unsubscribe: { eventType: 'welcome', url } },
      'App <hello@example.com>',
    )
    expect(body.headers).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })

  it('appends a footer line to both html and text bodies', () => {
    const body = buildResendEmailRequest(
      { ...BASE, unsubscribe: { eventType: 'welcome', url } },
      'App <hello@example.com>',
    )
    expect(body.html).toContain(url)
    expect(body.html).toContain('</body>')
    // Inserted before the closing tag, not appended after it.
    expect(body.html.indexOf(url)).toBeLessThan(body.html.lastIndexOf('</body>'))
    expect(body.text).toContain(url)
    expect(body.text).toContain('Unsubscribe')
  })
})

describe('buildResendEmailRequest — mandatory event types never get the header', () => {
  it.each([
    'billing.payment_failed',
    'billing.purchase',
    'security.new_sign_in',
    'account.deletion_confirmed',
  ])('refuses "%s"', (eventType) => {
    const url = 'https://example.com/api/email/unsubscribe?u=user-1&e=x&t=abc'
    const body = buildResendEmailRequest(
      { ...BASE, unsubscribe: { eventType, url } },
      'App <hello@example.com>',
    )
    expect(body.headers).toBeUndefined()
    expect(body.html).toBe(BASE.html)
    expect(body.text).toBe(BASE.text)
    expect(body.html).not.toContain(url)
  })

  it('logs a warning when a mandatory type is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildResendEmailRequest(
      { ...BASE, unsubscribe: { eventType: 'billing.payment_failed', url: 'https://x/y' } },
      'App <hello@example.com>',
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('unsubscribe_header_blocked_mandatory')
    warn.mockRestore()
  })
})

describe('sendEmail — end to end with fetch and runtime config stubbed', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the built request body, including the unsubscribe headers', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'email_123' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => ({
      resend: { apiKey: 'test-key', from: 'App <hello@example.com>' },
    }))

    const url = 'https://example.com/api/email/unsubscribe?u=user-1&e=welcome&t=abc'
    const result = await sendEmail({ ...BASE, unsubscribe: { eventType: 'welcome', url } })

    expect(result).toEqual({ sent: true, id: 'email_123' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    const sentBody = JSON.parse((init as RequestInit).body as string)
    expect(sentBody.headers).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })

  it('never sends a network request when unconfigured, unsubscribe option or not', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => ({ resend: { apiKey: '', from: '' } }))

    const result = await sendEmail({
      ...BASE,
      unsubscribe: { eventType: 'welcome', url: 'https://example.com/x' },
    })

    expect(result).toEqual({ sent: false, reason: 'unconfigured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
