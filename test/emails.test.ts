// Every compiled email, filled in from its sample — the contract the Maizzle
// build and renderEmail() share. Runs in workerd, which has no filesystem, so it
// imports the generated module rather than reading templates; a template edited
// without `bun run email:build` is caught by `bun run email:check`, not here.
//
// Per-email wording lives in test/email-templates.test.ts and test/ops.test.ts.
// This file is what must hold for ALL of them, including the ones added later.

import { describe, expect, it } from 'vitest'

import { SAMPLES } from '../emails/samples'
import { EMAILS } from '../server/emails/generated'
import { renderEmail, type EmailName } from '../server/utils/render-email'

const NAMES = Object.keys(EMAILS) as EmailName[]

/** The link each email exists to put in front of someone, as the sample builds it. */
const ACTION_URL: Record<EmailName, (data: Record<string, unknown>) => string> = {
  'access-ended': (d) => `${d.appUrl}/pricing`,
  'account-deleted': (d) => `${d.appUrl}`,
  'activation-nudge': (d) => `${d.appUrl}/dashboard`,
  'feedback-reply': (d) => `${d.appUrl}`,
  'magic-link': (d) => String(d.url),
  'ops-digest': (d) => String(d.logsUrl),
  'pass-expiring': (d) => `${d.appUrl}/account`,
  'payment-failed': (d) => `${d.appUrl}/account`,
  purchase: (d) => `${d.appUrl}/account`,
  welcome: (d) => `${d.appUrl}`,
}

/** The HTML as a client sees it: Mustache's `/` and `=` entities undone. */
const readable = (html: string) => html.replaceAll('&#x2F;', '/').replaceAll('&#x3D;', '=')

/** Every string in a sample replaced by markup that would break out of its context. */
function hostile(value: unknown): unknown {
  if (typeof value === 'string') return '"><b id=pwn onmouseover=alert(1)>'
  if (Array.isArray(value)) return value.map(hostile)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hostile(v)]))
  }
  return value
}

describe('the email set', () => {
  it('has a sample for every template and a template for every sample', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...NAMES].sort())
  })
})

describe.each(NAMES)('%s', (name) => {
  const data = SAMPLES[name]!
  const { html, text } = renderEmail(name, data)

  it('renders with its sample data and leaves no tag unfilled', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).not.toContain('{{')
    expect(html).not.toContain('}}')
    expect(text).not.toContain('{{')
    expect(text).not.toContain('}}')
    expect(html).not.toContain('undefined')
    expect(text).not.toContain('undefined')
  })

  it('links the logo from the app origin, with the app name as its alt text', () => {
    expect(readable(html)).toContain(`src="${data.appUrl}/email-logo.png"`)
    expect(html).toContain(`alt="${data.appName}"`)
  })

  it('ships a plain-text alternative with the action URL in it', () => {
    expect(text.trim().length).toBeGreaterThan(40)
    expect(text).toContain(ACTION_URL[name](data))
    expect(readable(html)).toContain(ACTION_URL[name](data))
  })

  it('keeps the plain text plain — no markup, entities or stray whitespace', () => {
    expect(text).not.toMatch(/<\/?[a-z]/i)
    expect(text).not.toMatch(/&(#\w+|[a-z]+);/i)
    expect(text).not.toMatch(/\n{3,}/)
    expect(text).not.toMatch(/[ \t]+\n/)
  })

  it('escapes whatever data it is handed', () => {
    const attack = renderEmail(name, hostile(data) as Record<string, unknown>)
    expect(attack.html).not.toContain('<b id=pwn')
    expect(attack.html).not.toContain('onmouseover=alert')
    expect(attack.html).not.toMatch(/"\s*onmouseover/)
    expect(attack.html).toContain('&lt;b id&#x3D;pwn')
  })
})

describe('renderEmail', () => {
  it('escapes data in the HTML but not in the text, which has no markup to break', () => {
    const { html, text } = renderEmail('welcome', {
      ...SAMPLES.welcome,
      name: `Ada & "Grace" <3`,
    })
    expect(html).toContain('Ada &amp; &quot;Grace&quot; &lt;3')
    expect(text).toContain('Hi Ada & "Grace" <3')
  })

  it('drops a section whose value is missing, rather than printing around it', () => {
    const base = { ...SAMPLES.purchase, isPass: true }
    expect(renderEmail('purchase', { ...base, ends: 'May 1' }).text).toContain('good through May 1')
    const none = renderEmail('purchase', { ...base, ends: null }).text
    expect(none).toContain('one-time pass. It')
    expect(none).not.toContain('null')
  })
})
