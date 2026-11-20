// What every route of the layer must do, read off the route files themselves
// (Vite resolves `?raw` at transform time; workerd has no filesystem), plus the
// sign-in handler driven with its collaborators replaced.

import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashNewPassword, passwordUpsert } from '../server/utils/credentials-password'
import { accountLimitIdentifier, CREDENTIALS_LIMITS } from '../server/utils/credentials-limits'
import { addUser, db, fakeHasher, KDF, proofOf, resetCredentialTables } from './lib/fixtures'

const SOURCES = import.meta.glob<string>('../server/api/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const ROUTES = Object.entries(SOURCES).map(([file, source]) => ({
  route: file.replace('../server/api/', ''),
  source,
}))
const sourceOf = (route: string) => ROUTES.find((entry) => entry.route === route)!.source

describe('every route', () => {
  it('is one of the fifteen this file knows about', () => {
    expect(ROUTES.map((entry) => entry.route).sort()).toEqual([
      'auth/credentials/params.post.ts',
      'auth/credentials/passkey.post.ts',
      'auth/credentials/reset/confirm.post.ts',
      'auth/credentials/reset/request.post.ts',
      'auth/credentials/sign-in.post.ts',
      'auth/credentials/sign-up.post.ts',
      'auth/credentials/verify-passkey.post.ts',
      'auth/credentials/verify.post.ts',
      'credentials/me.get.ts',
      'credentials/passkeys/[id].delete.ts',
      'credentials/passkeys/index.get.ts',
      'credentials/passkeys/register.post.ts',
      'credentials/password.post.ts',
      'credentials/password/first.post.ts',
      'credentials/unlock.post.ts',
    ])
  })

  it.each(ROUTES)(
    '$route answers 404 while the layer is off, before doing anything',
    ({ source }) => {
      const handler = source.slice(source.lastIndexOf('export default defineEventHandler'))
      const firstStatement = handler.split('\n')[1]!.trim()
      expect(firstStatement).toMatch(/requireCredentialsEnabled\(event\)$/)
    },
  )

  it.each(ROUTES)('$route charges a named budget', ({ source }) => {
    expect(source).toMatch(/await rateLimit\(event, (\{ \.\.\.)?CREDENTIALS_LIMITS\.\w+/)
  })

  it.each(ROUTES.filter((entry) => entry.route.startsWith('credentials/')))(
    '$route requires a session itself',
    ({ source }) => {
      expect(source).toContain('requireUserSession(event)')
    },
  )

  it('keeps signed-in routes off the public /api/auth/ prefix', () => {
    for (const { route, source } of ROUTES) {
      if (route.startsWith('auth/')) expect(source).not.toContain('requireUserSession')
    }
  })
})

describe('budgets', () => {
  const limits = Object.values(CREDENTIALS_LIMITS)

  it('are named uniquely, so two routes never share a counter by accident', () => {
    expect(new Set(limits.map((limit) => limit.name)).size).toBe(limits.length)
  })

  it('never match the native limiter (30 per 60s), which cannot hold a 15-minute window', () => {
    expect(limits.some((limit) => limit.limit === 30 && limit.windowSeconds === 60)).toBe(false)
  })

  it('key the per-account budget by mailbox, without the address in the key', async () => {
    const id = await accountLimitIdentifier('Ada+news@Gmail.com')
    expect(await accountLimitIdentifier('a.d.a@googlemail.com')).toBe(id)
    expect(await accountLimitIdentifier('grace@gmail.com')).not.toBe(id)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('Turnstile on the public forms', () => {
  const before = (source: string, first: string, second: string) => {
    expect(source).toContain(first)
    expect(source).toContain(second)
    expect(source.indexOf(first)).toBeLessThan(source.lastIndexOf(second))
  }

  it('runs before the mail budget is charged on sign-up and reset', () => {
    before(
      sourceOf('auth/credentials/sign-up.post.ts'),
      'await requireTurnstile(',
      'await startSignUp(',
    )
    before(
      sourceOf('auth/credentials/reset/request.post.ts'),
      'await requireTurnstile(',
      'await requestPasswordReset(',
    )
  })

  it('runs before the per-account budget and the proof check on sign-in', () => {
    const source = sourceOf('auth/credentials/sign-in.post.ts')
    before(source, 'await requireTurnstile(', 'CREDENTIALS_LIMITS.signInAccount')
    before(source, 'CREDENTIALS_LIMITS.signInAccount', 'await verifySignInProof(')
  })
})

// ── The sign-in handler ──────────────────────────────────────────────────────
const calls: string[] = []
const blocked = new Set<string>()
const hasher = fakeHasher()
const establishSession = vi.fn(async (..._args: unknown[]) => {
  calls.push('session')
  return { created: false }
})

vi.mock('@nuxthub/db', async () => {
  const { drizzle } = await import('drizzle-orm/d1')
  const schema = await import('~~/server/db/schema')
  return { db: drizzle(env.DB, { schema }) }
})
vi.mock('#server/utils/auth', () => ({
  establishSession: (...args: unknown[]) => establishSession(...args),
}))
vi.mock('#server/utils/turnstile', async () => {
  const { z } = await import('zod')
  return {
    turnstileTokenSchema: z.string(),
    requireTurnstile: async () => void calls.push('turnstile'),
  }
})
vi.mock('#server/utils/rate-limit', () => ({
  rateLimit: async (_event: unknown, limit: { name: string }) => {
    calls.push(limit.name)
    if (blocked.has(limit.name))
      throw Object.assign(new Error('Too many requests'), { statusCode: 429 })
  },
}))

type Handler = (event: { body: unknown }) => Promise<unknown>
let signIn: Handler
let enabled = true

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal(
    'readValidatedBody',
    async (event: { body: unknown }, parse: (v: unknown) => unknown) => parse(event.body),
  )
  vi.stubGlobal('createError', (input: { statusCode: number; data?: unknown }) =>
    Object.assign(new Error(String(input.statusCode)), input),
  )
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { credentials: { enabled, primary: false, prf: false, iterations: 600_000 } },
  }))
  vi.stubGlobal('hashPassword', hasher.hash)
  vi.stubGlobal('verifyPassword', hasher.verify)
  signIn = (await import('../server/api/auth/credentials/sign-in.post'))
    .default as unknown as Handler
})

beforeEach(async () => {
  await resetCredentialTables()
  await addUser('u1', 'ada@example.com')
  await passwordUpsert(db, 'u1', await hashNewPassword(hasher, { ...KDF, proof: proofOf('p') }))
  calls.length = 0
  blocked.clear()
  hasher.verifications = 0
  establishSession.mockClear()
  enabled = true
})

const attempt = (email: string, proof: string) => signIn({ body: { email, proof } })

describe('POST /api/auth/credentials/sign-in', () => {
  it('signs in with the right proof, asserting a verified address', async () => {
    expect(await attempt('ada@example.com', proofOf('p'))).toEqual({ ok: true, user: { id: 'u1' } })
    expect(calls).toEqual([
      'credentials-sign-in',
      'turnstile',
      'credentials-sign-in-account',
      'session',
    ])
    expect(establishSession.mock.calls[0]?.[1]).toMatchObject({
      emailVerified: true,
      profile: { email: 'ada@example.com', provider: 'credentials' },
    })
  })

  it('gives a wrong password and an unknown address the same answer', async () => {
    const wrong = await attempt('ada@example.com', proofOf('x')).catch((error) => error)
    const unknown = await attempt('nobody@example.com', proofOf('x')).catch((error) => error)
    for (const error of [wrong, unknown]) {
      expect(error).toMatchObject({ statusCode: 401, data: { code: 'invalid_credentials' } })
    }
    expect(wrong.message).toBe(unknown.message)
    expect(establishSession).not.toHaveBeenCalled()
  })

  it('stops at the per-IP budget before reading the body', async () => {
    blocked.add('credentials-sign-in')
    await expect(attempt('ada@example.com', proofOf('p'))).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(calls).toEqual(['credentials-sign-in'])
  })

  it('stops at the per-account budget before any proof is checked, even the right one', async () => {
    blocked.add('credentials-sign-in-account')
    await expect(attempt('ada@example.com', proofOf('p'))).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(hasher.verifications).toBe(0)
    expect(establishSession).not.toHaveBeenCalled()
  })

  it('does not exist while the layer is off', async () => {
    enabled = false
    await expect(attempt('ada@example.com', proofOf('p'))).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(calls).toEqual([])
  })

  it('rejects a body that is not a derived proof', async () => {
    await expect(attempt('ada@example.com', 'hunter2')).rejects.toThrow()
    expect(hasher.verifications).toBe(0)
  })
})
