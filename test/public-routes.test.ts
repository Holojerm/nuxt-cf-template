// The auth middleware's allowlist, as data. server/middleware/auth.ts only
// asks these functions; what it must let through is pinned here so that moving
// the list out of the middleware cannot have widened or narrowed it.

import { afterEach, describe, expect, it } from 'vitest'

import {
  clearPublicRoutesForTest,
  isPublicApiRequest,
  isSessionGatedPath,
  registerPublicApiRoutes,
  registerSessionGatedPrefixes,
} from '../server/utils/public-routes'

afterEach(() => clearPublicRoutesForTest())

describe('core public routes (nothing registered)', () => {
  it('lets through exactly what the middleware allowlisted before the registry', () => {
    for (const [path, method] of [
      ['/api/health', 'GET'],
      ['/api/status', 'GET'],
      ['/api/fleet', 'GET'],
      ['/api/ops/events', 'GET'],
      ['/api/auth/providers', 'GET'],
      ['/api/auth/magic-link', 'POST'],
      ['/api/_auth/session', 'GET'],
      ['/api/blog', 'GET'],
      ['/api/blog/hello', 'GET'],
      ['/api/email/unsubscribe', 'GET'],
      ['/api/email/unsubscribe', 'POST'],
      ['/api/_nuxt_icon/lucide.json', 'GET'],
    ] as const) {
      expect(isPublicApiRequest(path, method), `${method} ${path}`).toBe(true)
    }
  })

  it('matches health, status and fleet exactly, so a look-alike route is not public', () => {
    for (const path of [
      '/api/healthz',
      '/api/health/deep',
      '/api/status-page',
      '/api/status/internal',
      '/api/fleets',
      '/api/fleet/export',
    ]) {
      expect(isPublicApiRequest(path, 'GET'), path).toBe(false)
    }
    expect(isPublicApiRequest('/api/status', 'POST')).toBe(false)
    expect(isPublicApiRequest('/api/fleet', 'DELETE')).toBe(false)
  })

  it('keeps everything else behind the session', () => {
    for (const [path, method] of [
      ['/api/account', 'GET'],
      ['/api/admin/users', 'GET'],
      ['/api/billing/entitlement', 'GET'],
      ['/api/feedback', 'POST'], // public only once the feedback layer registers it
      ['/api/blog', 'POST'],
      ['/api/blog/hello', 'DELETE'],
      ['/api/email/unsubscribe', 'PUT'],
      ['/api/authorize', 'GET'], // `/api/auth/` has a trailing slash on purpose
      ['/api/blogger', 'GET'],
    ] as const) {
      expect(isPublicApiRequest(path, method), `${method} ${path}`).toBe(false)
    }
  })

  it('gates /api/ and nothing else', () => {
    expect(isSessionGatedPath('/api/account')).toBe(true)
    expect(isSessionGatedPath('/pricing')).toBe(false)
    expect(isSessionGatedPath('/posters/a.jpg')).toBe(false)
  })
})

describe('registerPublicApiRoutes', () => {
  it('adds a method-scoped exact route', () => {
    registerPublicApiRoutes([{ path: '/api/join/code', methods: ['POST'] }])
    expect(isPublicApiRequest('/api/join/code', 'POST')).toBe(true)
    expect(isPublicApiRequest('/api/join/code', 'GET')).toBe(false)
    expect(isPublicApiRequest('/api/join/code/x', 'POST')).toBe(false)
  })

  it('adds a prefix route for every method when none is given', () => {
    registerPublicApiRoutes([{ path: '/api/problems', match: 'prefix' }])
    expect(isPublicApiRequest('/api/problems', 'GET')).toBe(true)
    expect(isPublicApiRequest('/api/problems/url-shortener', 'GET')).toBe(true)
  })

  it('is idempotent, and clearing returns to core', () => {
    const rule = { path: '/api/x', methods: ['GET'] }
    registerPublicApiRoutes([rule])
    registerPublicApiRoutes([rule])
    expect(isPublicApiRequest('/api/x', 'GET')).toBe(true)
    clearPublicRoutesForTest()
    expect(isPublicApiRequest('/api/x', 'GET')).toBe(false)
  })

  it('refuses a rule outside /api/ rather than silently never matching', () => {
    expect(() => registerPublicApiRoutes([{ path: '/posters/' }])).toThrow(/not under \/api\//)
  })
})

describe('registerSessionGatedPrefixes', () => {
  it('gates a non-API prefix once registered', () => {
    registerSessionGatedPrefixes(['/posters/', '/_scripts/'])
    expect(isSessionGatedPath('/posters/a.jpg')).toBe(true)
    expect(isSessionGatedPath('/_scripts/x.js')).toBe(true)
    expect(isSessionGatedPath('/pricing')).toBe(false)
  })

  it('refuses an /api/ prefix, which is gated already', () => {
    expect(() => registerSessionGatedPrefixes(['/api/foo/'])).toThrow(/already gated/)
  })
})
