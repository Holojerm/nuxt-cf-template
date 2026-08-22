// Admin gate for owner-facing endpoints.
//
// The session (nuxt-auth-utils) carries identity, not authority — `role` lives
// in the users table so it can't be forged by whatever issued the session.
//
// It is read from the database on every admin request; it is just not read
// TWICE. server/middleware/auth.ts already fetched this exact row a moment ago
// to check the session had not been revoked, and parks the role on
// `event.context` for this function. Per-request, so it cannot go stale — and
// the fallback below still does the read for the one case the middleware skips
// (a route reached without passing through it, e.g. a direct call in a test).
//
// Grant it with: UPDATE users SET role = 'admin' WHERE email = '…';

import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'

export async function requireAdmin(event: H3Event): Promise<{ id: string; email: string }> {
  const { user } = await requireUserSession(event)

  const cached: unknown = event.context[SESSION_ROLE_CONTEXT_KEY]
  const role =
    typeof cached === 'string'
      ? cached
      : (
          await db.query.users.findFirst({
            where: eq(schema.users.id, user.id),
            columns: { role: true },
          })
        )?.role

  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  return { id: user.id, email: user.email }
}
