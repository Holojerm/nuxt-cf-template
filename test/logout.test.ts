// POST /api/auth/logout: what it clears and the one analytics event it may send.
// An H3 handler reaching for Nitro auto-imports, so the globals it needs are
// stubbed.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown) => Promise<unknown>

const clearUserSession = vi.fn(async (_event: unknown) => {})
const captureServerEvent = vi.fn(async (_opts: unknown) => {})
let session: { user?: { id: string } } = {}
let runtimeConfig: Record<string, unknown> = {}
let handler: Handler

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
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
