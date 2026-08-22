// Log lines must not contain credentials.
//
// Two routes in this app carry one in their query string because the specs they
// implement require it there: RFC 8058's one-click unsubscribe URL, and a
// legacy or hand-assembled /auth/verify link. `event.path` includes the query,
// and the error plugin writes it to Cloudflare Logs and to PostHog's
// `$exception` — at the one moment the token is both logged and unspent.

import { describe, expect, it } from 'vitest'

import { pathForLog } from '../server/utils/log'

describe('pathForLog', () => {
  it('drops a signed unsubscribe token', () => {
    expect(pathForLog('/api/email/unsubscribe?u=user-1&e=welcome&t=signed-token')).toBe(
      '/api/email/unsubscribe',
    )
  })

  it('drops a sign-in token', () => {
    expect(pathForLog('/auth/verify?token=RVZuBk3ZbgpqJcT-nBcmLfU0TnUUxBCGblIsSLBPxB8')).toBe(
      '/auth/verify',
    )
  })

  it('drops a fragment too', () => {
    // The fragment is where real sign-in links put the token. A server rarely
    // sees one — but `event.path` is a string from a request line, and a
    // handful of clients do send it.
    expect(pathForLog('/auth/verify#token=abc')).toBe('/auth/verify')
    expect(pathForLog('/auth/verify?a=1#token=abc')).toBe('/auth/verify')
  })

  it('leaves an ordinary path alone, because that is the whole diagnostic value', () => {
    expect(pathForLog('/api/billing/entitlement')).toBe('/api/billing/entitlement')
    expect(pathForLog('/')).toBe('/')
  })

  it('passes undefined straight through for a JSON payload', () => {
    expect(pathForLog(undefined)).toBeUndefined()
    expect(pathForLog('')).toBeUndefined()
  })
})
