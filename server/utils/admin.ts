// Admin gate for owner-facing endpoints.
//
// The session (nuxt-auth-utils) carries identity, not authority — `role` lives
// in the users table so it can't be forged by whatever issued the session. One
// extra D1 read per admin request is the right price for that.
//
// Grant it with: UPDATE users SET role = 'admin' WHERE email = '…';

import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'

export async function requireAdmin(event: H3Event): Promise<{ id: string; email: string }> {
  const { user } = await requireUserSession(event)

  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, user.id),
    columns: { role: true },
  })

  if (row?.role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  return { id: user.id, email: user.email }
}
