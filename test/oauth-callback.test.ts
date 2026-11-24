// The routes around linking a sign-in method, with Nitro's globals stubbed and
// a real D1 behind them: starting a link (POST /api/account/identities/link),
// the shared provider callback (server/utils/oauth-callback.ts), and Apple's
// handler fed a faked, already-verified provider result, since the template has
// no Apple credentials to make a live call with.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { IDENTITY_LINK_COOKIE, signLinkIntent } from '../server/utils/identity-link'
import { findIdentityOwner, linkIdentity } from '../server/utils/user-identities'

const completeOAuthSignIn = vi.fn(async (_event: unknown, _opts: unknown) => 'signed-in')
vi.mock('../server/utils/auth', () => ({
  completeOAuthSignIn: (event: unknown, opts: unknown) => completeOAuthSignIn(event, opts),
  redirectToLoginError: (_event: unknown, code: string) => ({ redirect: `/login?error=${code}` }),
  afterSignIn: async (_label: string, work: () => Promise<void>) => work(),
}))

const db = drizzle(env.DB, { schema })
const PASSWORD = 'test-session-password-of-reasonable-length'

interface FakeEvent {
  method: string
  query: Record<string, string>
  cookies: Record<string, string>
  set: Record<string, { value: string; opts: Record<string, unknown> }>
  session: { user?: { id: string }; issuedAt?: number }
  body?: unknown
}

const fakeEvent = (over: Partial<FakeEvent> = {}): FakeEvent => ({
  method: 'GET',
  query: {},
  cookies: {},
  set: {},
  session: {},
  ...over,
})

let oauthConfig: Record<string, unknown> = {}
type Handler = (event: unknown) => Promise<unknown>
let linkStart: Handler
let callback: typeof import('../server/utils/oauth-callback')
let appleOptions: {
  onSuccess: (
    event: unknown,
    result: { user: unknown; payload: Record<string, unknown> },
  ) => unknown
}

beforeAll(async () => {
  vi.stubGlobal('db', db)
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('useRuntimeConfig', () => ({ sessionPassword: PASSWORD, oauth: oauthConfig }))
  vi.stubGlobal('getQuery', (e: FakeEvent) => e.query)
  vi.stubGlobal('getCookie', (e: FakeEvent, name: string) => e.cookies[name])
  vi.stubGlobal('setCookie', (e: FakeEvent, name: string, value: string, opts = {}) => {
    e.set[name] = { value, opts }
  })
  vi.stubGlobal('deleteCookie', (e: FakeEvent, name: string) => {
    delete e.cookies[name]
    e.set[name] = { value: '', opts: { deleted: true } }
  })
  vi.stubGlobal('sendRedirect', (_e: FakeEvent, url: string) => ({ redirect: url }))
  vi.stubGlobal('getUserSession', async (e: FakeEvent) => e.session)
  vi.stubGlobal('requireUserSession', async (e: FakeEvent) => {
    if (!e.session.user) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    return e.session
  })
  vi.stubGlobal('readValidatedBody', async (e: FakeEvent, parse: (b: unknown) => unknown) =>
    parse(e.body),
  )
  vi.stubGlobal('createError', (opts: { message: string }) =>
    Object.assign(new Error(opts.message), opts),
  )
  vi.stubGlobal('defineOAuthAppleEventHandler', (opts: typeof appleOptions) => {
    appleOptions = opts
    return () => undefined
  })

  linkStart = (await import('../server/api/account/identities/link.post'))
    .default as unknown as Handler
  callback = await import('../server/utils/oauth-callback')
  await import('../server/api/auth/apple')
})

beforeEach(async () => {
  completeOAuthSignIn.mockClear()
  oauthConfig = {
    apple: { clientId: 'c', teamId: 't', keyId: 'k', privateKey: 'p', redirectURL: 'https://x/a' },
  }
  await env.DB.exec('DELETE FROM user_identities')
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values([
    { id: 'u1', email: 'ada@example.com', name: 'Ada' },
    { id: 'u2', email: 'grace@example.com', name: 'Grace' },
  ])
})

async function intentCookie(userId: string, provider = 'apple') {
  const now = Math.floor(Date.now() / 1000)
  return signLinkIntent(PASSWORD, { userId, provider, issuedAt: now, expiresAt: now + 600 })
}

const appleProfile = {
  provider: 'apple',
  subject: 'apple-001',
  email: 'x7k2@privaterelay.appleid.com',
}

describe('POST /api/account/identities/link', () => {
  it('cannot be started signed out', async () => {
    const event = fakeEvent({ method: 'POST', body: { provider: 'apple' } })
    await expect(linkStart(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(event.set[IDENTITY_LINK_COOKIE]).toBeUndefined()
  })

  it('refuses a provider that is not configured', async () => {
    const event = fakeEvent({
      method: 'POST',
      body: { provider: 'google' },
      session: { user: { id: 'u1' } },
    })
    await expect(linkStart(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('sets a cookie that survives Apple’s cross-site POST and names the session user', async () => {
    const event = fakeEvent({
      method: 'POST',
      body: { provider: 'apple' },
      session: { user: { id: 'u1' }, issuedAt: 123 },
    })
    expect(await linkStart(event)).toEqual({ url: '/api/auth/apple?link=1' })
    const cookie = event.set[IDENTITY_LINK_COOKIE]
    expect(cookie?.opts).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/api/auth/',
    })
  })
})

describe('the provider callback', () => {
  it('signs in as usual when no link intent came back', async () => {
    const event = fakeEvent({ method: 'POST' })
    expect(
      await callback.finishOAuth(event as never, { profile: appleProfile, emailVerified: true }),
    ).toBe('signed-in')
    expect(completeOAuthSignIn).toHaveBeenCalledTimes(1)
  })

  it('links to the intent user with no session cookie (Apple), whatever the address', async () => {
    const event = fakeEvent({
      method: 'POST',
      cookies: { [IDENTITY_LINK_COOKIE]: await intentCookie('u1') },
    })
    const result = await callback.finishOAuth(event as never, {
      profile: appleProfile,
      emailVerified: false,
    })
    expect(result).toEqual({ redirect: '/account?linked=apple' })
    expect(completeOAuthSignIn).not.toHaveBeenCalled()
    expect(await findIdentityOwner(db, 'apple', 'apple-001')).toBe('u1')
    expect(event.set[IDENTITY_LINK_COOKIE]?.opts).toMatchObject({ deleted: true })
  })

  it('refuses when the identity already belongs to another account', async () => {
    await linkIdentity(db, 'u2', { provider: 'apple', subject: 'apple-001' })
    const event = fakeEvent({
      method: 'POST',
      cookies: { [IDENTITY_LINK_COOKIE]: await intentCookie('u1') },
    })
    const result = await callback.finishOAuth(event as never, {
      profile: appleProfile,
      emailVerified: true,
    })
    expect(result).toEqual({ redirect: '/account?link_error=taken' })
    expect(await findIdentityOwner(db, 'apple', 'apple-001')).toBe('u2')
  })

  it('ignores an intent for a different provider and signs in instead', async () => {
    const event = fakeEvent({
      cookies: { [IDENTITY_LINK_COOKIE]: await intentCookie('u1', 'google') },
    })
    await callback.finishOAuth(event as never, { profile: appleProfile, emailVerified: true })
    expect(completeOAuthSignIn).toHaveBeenCalledTimes(1)
    expect(await findIdentityOwner(db, 'apple', 'apple-001')).toBeNull()
  })

  it('drops a pending link when a plain sign-in starts, and keeps it for ?link=1', async () => {
    const inner = vi.fn(() => 'started')
    const wrapped = callback.withLinkAwareStart(inner)

    const plain = fakeEvent({ cookies: { [IDENTITY_LINK_COOKIE]: 'x' } })
    wrapped(plain as never)
    expect(plain.cookies[IDENTITY_LINK_COOKIE]).toBeUndefined()

    const link = fakeEvent({ query: { link: '1' }, cookies: { [IDENTITY_LINK_COOKIE]: 'x' } })
    wrapped(link as never)
    expect(link.cookies[IDENTITY_LINK_COOKIE]).toBe('x')
    expect(inner).toHaveBeenCalledTimes(2)
  })
})

describe('Sign in with Apple, from a faked verified id_token', () => {
  it('maps sub, the stringly email_verified claim, and the one-time name', async () => {
    const event = fakeEvent({ method: 'POST' })
    await appleOptions.onSuccess(event, {
      user: JSON.stringify({ name: { firstName: 'Grace', lastName: 'Hopper' } }),
      payload: { sub: 'apple-001', email: appleProfile.email, email_verified: 'true' },
    })
    expect(completeOAuthSignIn.mock.calls[0]?.[1]).toEqual({
      profile: { ...appleProfile, name: 'Grace Hopper', avatarUrl: null },
      emailVerified: true,
    })
  })

  it('treats email_verified "false" as unverified', async () => {
    await appleOptions.onSuccess(fakeEvent({ method: 'POST' }), {
      user: undefined,
      payload: { sub: 'apple-001', email: appleProfile.email, email_verified: 'false' },
    })
    expect(completeOAuthSignIn.mock.calls[0]?.[1]).toMatchObject({ emailVerified: false })
  })
})
