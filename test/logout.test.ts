// POST /api/auth/logout: what it clears and the one analytics event it may send.
// An H3 handler reaching for Nitro auto-imports, so the globals it needs are
// stubbed.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown) => Promise<unknown>

const clearUserSession = vi.fn(async (_event: unknown) => {})
const captureServerEvent = vi.fn(async (_opts: unknown) => {})
let session: { user?: { id: string } } = {}
let runtimeConfig: Record<string, unknown> = {}
let cookies: Record<string, string> = {}
let handler: Handler

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('getCookie', (_event: unknown, name: string) => cookies[name])
  vi.stubGlobal('deleteCookie', (_event: unknown, name: string) => delete cookies[name])
  vi.stubGlobal('getUserSession', async () => session)
  vi.stubGlobal('clearUserSession', clearUserSession)
  vi.stubGlobal('captureServerEvent', captureServerEvent)
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  handler = (await import('../server/api/auth/logout.post')).default as unknown as Handler
})

beforeEach(() => {
  clearUserSession.mockClear()
  captureServerEvent.mockClear()
  session = { user: { id: 'u1' } }
  runtimeConfig = { captureSignOut: true }
  cookies = {}
})

it('drops a half-finished "link a sign-in method" with the session', async () => {
  cookies = { 'identity-link': 'pending' }
  await handler({})
  expect(cookies).toEqual({})
})

describe('POST /api/auth/logout', () => {
  it('clears the session and captures user_signed_out for a signed-in user', async () => {
    expect(await handler({})).toEqual({ ok: true })
    expect(clearUserSession).toHaveBeenCalledTimes(1)
    expect(captureServerEvent).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'user_signed_out',
    })
  })

  it('captures the event when the setting is absent — the default', async () => {
    runtimeConfig = {}
    await handler({})
    expect(captureServerEvent).toHaveBeenCalledTimes(1)
  })

  it('still clears the session and sends nothing when captureSignOut is false', async () => {
    runtimeConfig = { captureSignOut: false }
    expect(await handler({})).toEqual({ ok: true })
    expect(clearUserSession).toHaveBeenCalledTimes(1)
    expect(captureServerEvent).not.toHaveBeenCalled()
  })

  it('succeeds quietly with no session, and captures nothing', async () => {
    session = {}
    expect(await handler({})).toEqual({ ok: true })
    expect(clearUserSession).toHaveBeenCalledTimes(1)
    expect(captureServerEvent).not.toHaveBeenCalled()
  })
})
