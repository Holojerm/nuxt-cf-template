// The open-redirect guard on sign-in.
//
// After OAuth we send the browser wherever the pre-login cookie said. That value
// starts life in a URL the user clicked, so it's attacker-controlled: a link to
// OUR /login that bounces to a pixel-perfect copy of it is a credible phishing
// flow, and the address bar looks right until the redirect fires.
//
// Everything below is a real bypass that has worked on real login pages.

import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '../server/utils/auth'

describe('safeRedirectPath', () => {
  it('allows an ordinary in-app path', () => {
    expect(safeRedirectPath('/dashboard')).toBe('/dashboard')
    expect(safeRedirectPath('/account?tab=billing')).toBe('/account?tab=billing')
  })

  it('falls back when nothing was requested', () => {
    expect(safeRedirectPath(undefined)).toBe('/')
    expect(safeRedirectPath('', '/dashboard')).toBe('/dashboard')
  })

  it('rejects an absolute URL', () => {
    expect(safeRedirectPath('https://evil.example')).toBe('/')
    expect(safeRedirectPath('http://evil.example')).toBe('/')
  })

  it('rejects a protocol-relative URL', () => {
    // The one a `startsWith('/')` check waves through. Browsers read this as
    // https://evil.example — same origin as nothing.
    expect(safeRedirectPath('//evil.example')).toBe('/')
    expect(safeRedirectPath('//evil.example/login')).toBe('/')
  })

  it('rejects the backslash variant', () => {
    // Several browsers normalize \ to / during URL parsing, so this leaves as
    // //evil.example.
    expect(safeRedirectPath('/\\evil.example')).toBe('/')
    expect(safeRedirectPath('\\\\evil.example')).toBe('/')
  })

  it('rejects a scheme smuggled behind whitespace or control characters', () => {
    expect(safeRedirectPath('/\tjavascript:alert(1)')).toBe('/')
    expect(safeRedirectPath('/\njavascript:alert(1)')).toBe('/')
    expect(safeRedirectPath('/ /evil.example')).toBe('/')
  })

  it('rejects a javascript: URL outright', () => {
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/')
  })

  it('rejects a scheme-relative path that does not start with a slash', () => {
    expect(safeRedirectPath('evil.example/login')).toBe('/')
  })
})
