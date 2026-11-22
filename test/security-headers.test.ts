// The policy-text half of test/csp/csp.spec.ts: what the shipped Content-Security-Policy
// allows and refuses. These are string assertions against the policy that
// nuxt.config.ts hands to routeRules, so they need no browser or server. The
// browser half (no violations on real pages, Blob worker, headers on the wire)
// stays in Playwright.

import { describe, expect, it } from 'vitest'

import { contentSecurityPolicy, securityHeaders } from '../shared/security-headers'

// What production serves; dev differs by one frame-src source.
const csp = contentSecurityPolicy(false)
const directive = (name: string): string =>
  new RegExp(`(?:^|; )${name} ([^;]+)`).exec(csp)?.[1] ?? ''

describe('the policy still permits what the vendors need', () => {
  it('names no payment host, with or without the billing layer', () => {
    // Stripe's hosted Checkout and customer portal are full-page navigations,
    // which CSP does not govern. An entry nothing needs is a silently
    // over-permissive policy; embedding a checkout is the day to add one.
    expect(csp).not.toMatch(/stripe|link\.com/)
  })

  it('has both directives Turnstile needs, before anyone configures it', () => {
    // script-src for the api.js loader, frame-src for the challenge iframe.
    // Getting only the first fails after the script loads, so it looks like a
    // Turnstile bug rather than a policy one.
    expect(directive('script-src')).toContain('https://challenges.cloudflare.com')
    expect(directive('frame-src')).toContain('https://challenges.cloudflare.com')
  })

  it('allows the edge-injected Web Analytics beacon', () => {
    expect(directive('script-src')).toContain('https://static.cloudflareinsights.com')
    expect(directive('connect-src')).toContain('https://cloudflareinsights.com')
  })

  it('keeps PostHog on the first-party proxy', () => {
    // A posthog.com origin means someone "fixed" a violation by punching
    // through /ingest, which ad blockers then defeat for a third of users.
    expect(csp).not.toContain('posthog.com')
    expect(directive('connect-src')).toContain("'self'")
  })
})

describe('the directives that make the policy worth having', () => {
  it('locks down the anti-bypass directives', () => {
    // script-src carries 'unsafe-inline'; these keep that from being a blank cheque.
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("default-src 'self'")
  })

  it("keeps eval blocked — 'unsafe-eval' must never be added", () => {
    expect(csp).not.toContain('unsafe-eval')
  })

  it('lets no external origin into script-src beyond the ones we chose', () => {
    // Adding a tag manager or chat widget means adding a host here, and that
    // should be a decision someone makes on purpose.
    const externalHosts = directive('script-src')
      .split(/\s+/)
      .filter((source) => source.startsWith('http') || source.startsWith('//'))

    expect(externalHosts.sort()).toEqual(
      ['https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com'].sort(),
    )
  })

  it('differs between dev and production by the DevTools frame source only', () => {
    expect(contentSecurityPolicy(true).replace(" 'self'; worker-src", '; worker-src')).toBe(csp)
  })
})

describe('the other security headers', () => {
  const headers = securityHeaders(false)

  it('sets HSTS without preload (a registry submission is the owner’s call)', () => {
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains')
  })

  it('sets the framing, referrer and sniffing headers', () => {
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })
})
