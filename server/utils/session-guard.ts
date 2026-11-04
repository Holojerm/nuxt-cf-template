// Can this sealed session still act?
//
// nuxt-auth-utils sessions are self-contained sealed cookies, so there was
// nothing to revoke: delete your account on your laptop and your phone kept full
// paid access until the cookie expired. The smallest fix that makes a stateless
// cookie revocable: date it (`issuedAt`, server/utils/auth.ts) and give the
// account a watermark (`users.sessions_invalid_before`); a session issued before
// the watermark is dead.
//
// Cost: one indexed primary-key read on `users` per authenticated request. A KV
// cache was rejected, not for latency: caching "valid" for N seconds keeps a
// revoked session working for N seconds (the bug, in miniature), KV is
// eventually consistent so N is not even quotable, and a KV deny-list fails
// OPEN. D1 is strongly consistent and most routes hit it anyway. If a fork needs
// the read back, shorten the cookie lifetime; do not blur the guarantee.

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
// Explicit, not auto-imported: the workerd vitest suite loads this file directly.
import { isUndeliverableAddress } from './users'

export type SessionGuardDb = ReturnType<typeof drizzle<typeof tables>>

/** The two fields of a sealed session this check needs. */
export interface SessionClaim {
  userId: string
  /** Unix seconds. Absent on sessions sealed before revocation shipped. */
  issuedAt?: number
}

export type SessionVerdict =
  | { valid: true; role: string }
  | { valid: false; reason: 'no_account' | 'deleted' | 'revoked' | 'undated' }

/**
 * Where the middleware parks the row it read, so requireAdmin() does not repeat
 * the same primary-key read. Per-request (`event.context`), so it cannot go
 * stale like the rejected KV cache.
 */
export const SESSION_ROLE_CONTEXT_KEY = 'sessionRole'

/**
 * Should a revoked session be cleared WITHOUT aborting this request?
 *
 * A guard that 401s the sign-in surface locks the user out: the stale cookie is
 * exactly what is present when they try to sign in again (/login's SSR fetch of
 * `/api/auth/providers` 401d into "No sign-in method is configured", a good
 * magic link read as unrecognised, an OAuth callback dumped raw JSON). Anything
 * whose job is to END or REPLACE the credential proceeds, as none read the
 * session to decide anything:
 *
 *   /api/auth/*   the sign-in surface, how someone recovers.
 *   /api/health   a liveness probe must not depend on a cookie.
 *   DELETE /api/_auth/session   signing out authorizes nothing; a 401 would make
 *                 useUserSession().clear() throw uncaught.
 *
 * GET /api/_auth/session is deliberately NOT here: it must fail, since
 * useUserSession().fetch() catches that and nulls the session (flipping the
 * other browser to signed-out), and letting it through would re-unseal the same
 * cookie (clearSession only drops the cached one) and report the revoked user.
 */
export function isSessionClearOnlyPath(path: string, method: string): boolean {
  if (path.startsWith('/api/auth/')) return true
  if (path === '/api/health') return true
  return path === '/api/_auth/session' && method === 'DELETE'
}

/**
 * Is the account behind this session still allowed to act? Refusals in order:
 *
 *   no_account  The row is gone (nothing deletes one today; deletion anonymizes
 *               in place): a hand-run DELETE, restored backup, other database.
 *   deleted     A tombstone. Redundant with the watermark but free (the email is
 *               in the row already read), and it means a tombstone never
 *               authorizes a call even if a future path forgets the watermark.
 *   revoked /   The account has a revocation instant and the session predates it
 *   undated     or cannot say. "Cannot say" refuses on purpose: a session with
 *               no `issuedAt` predates this feature, and waving it through would
 *               exempt exactly the cookie an attacker would hold. A NULL
 *               watermark (never revoked) is unaffected, so nobody was logged
 *               out by the upgrade.
 *
 * Takes the Drizzle client explicitly so test/session-guard.test.ts runs it
 * against real D1 in workerd.
 */
export async function checkSession(
  db: SessionGuardDb,
  claim: SessionClaim,
): Promise<SessionVerdict> {
  const row = await db.query.users.findFirst({
    where: eq(tables.users.id, claim.userId),
    // `role` is fetched only so requireAdmin() can reuse this row; two columns cost the same as one.
    columns: { email: true, role: true, sessionsInvalidBefore: true },
  })

  if (!row) return { valid: false, reason: 'no_account' }
  if (isUndeliverableAddress(row.email)) return { valid: false, reason: 'deleted' }

  const watermark = row.sessionsInvalidBefore
  if (!watermark) return { valid: true, role: row.role }

  if (claim.issuedAt === undefined) return { valid: false, reason: 'undated' }
  // Seconds on both sides (D1 resolution; ms would round a same-second session
  // either way). `<` not `<=`: a session issued in the revocation second is the
  // NEW sign-in and must survive.
  return claim.issuedAt < Math.floor(watermark.getTime() / 1000)
    ? { valid: false, reason: 'revoked' }
    : { valid: true, role: row.role }
}
