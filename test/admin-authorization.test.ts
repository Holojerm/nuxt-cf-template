// Every admin-only route handler must 403 a signed-in non-admin before touching
// anything. Handlers are discovered by glob, so a new admin route is covered
// the moment it lands. Nitro auto-imports are stubbed as globals; anything a
// handler reaches for before `requireAdmin` throws a ReferenceError and fails.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { createError } from 'h3'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { requireAdmin } from '../server/utils/admin'
import { SESSION_ROLE_CONTEXT_KEY } from '../server/utils/session-guard'
import { FEEDBACK_STATUSES } from '../layers/feedback/server/utils/feedback'
import { MAX_COMP_PASSES } from '../layers/billing/shared/utils/comps'

type Handler = (event: unknown) => Promise<unknown>

// `[id]` is a character class in a glob, so the dynamic-segment dirs are walked with `**`.
const modules = {
  ...import.meta.glob('../server/api/admin/**/*.ts'),
  ...import.meta.glob('../layers/billing/server/api/admin/**/*.ts'),
  ...import.meta.glob('../layers/feedback/server/api/feedback.get.ts'),
  ...import.meta.glob('../layers/feedback/server/api/feedback/**/*.ts'),
}

const db = drizzle(env.DB, { schema })
const USER = { id: 'plain-user', email: 'plain@example.com' }
let session: { user: typeof USER }

beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('requireUserSession', async () => session)
  vi.stubGlobal('db', db)
  vi.stubGlobal('schema', schema)
  vi.stubGlobal('SESSION_ROLE_CONTEXT_KEY', SESSION_ROLE_CONTEXT_KEY)
  // Referenced at module scope by handlers' zod schemas.
  vi.stubGlobal('FEEDBACK_STATUSES', FEEDBACK_STATUSES)
  vi.stubGlobal('MAX_COMP_PASSES', MAX_COMP_PASSES)
  vi.stubGlobal('requireAdmin', requireAdmin)
})

beforeEach(async () => {
  session = { user: USER }
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values({ ...USER, name: 'Plain', role: 'user' })
})

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
  return row?.n ?? 0
}

describe('admin route authorization', () => {
  it('finds the admin handlers', () => {
    const paths = Object.keys(modules)
    expect(paths.length).toBeGreaterThan(0)
    for (const expected of [
      'admin/users.get.ts',
      'admin/audit.get.ts',
      'admin/users/[id]/grant.post.ts',
      'admin/users/[id]/revoke.post.ts',
      'api/feedback.get.ts',
      'feedback/[id].patch.ts',
      'feedback/[id]/reply.post.ts',
    ]) {
      expect(
        paths.some((p) => p.endsWith(expected)),
        expected,
      ).toBe(true)
    }
  })

  describe.each(Object.entries(modules))('%s', (_path, load) => {
    // The route reaches requireAdmin by two routes: the middleware's role on
    // event.context, or a direct DB read when the middleware was skipped.
    it.each([
      ['role from the middleware', { [SESSION_ROLE_CONTEXT_KEY]: 'user' }],
      ['role read from the database', {}],
    ])('403s a signed-in non-admin (%s)', async (_label, context) => {
      const handler = ((await load()) as { default: Handler }).default
      await expect(handler({ context })).rejects.toMatchObject({ statusCode: 403 })
      expect(await count('audit_log')).toBe(0)
      expect(await count('users')).toBe(1)
    })

    it('403s a session whose user no longer exists', async () => {
      session = { user: { id: 'ghost', email: 'ghost@example.com' } }
      const handler = ((await load()) as { default: Handler }).default
      await expect(handler({ context: {} })).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  it('lets an admin through requireAdmin', async () => {
    await env.DB.exec("UPDATE users SET role = 'admin'")
    await expect(requireAdmin({ context: {} } as never)).resolves.toEqual(USER)
  })
})
