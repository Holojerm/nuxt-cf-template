// Can this sealed session still act?
//
// ── The gap this closes ──────────────────────────────────────────────────────
// nuxt-auth-utils sessions are self-contained sealed cookies. Nothing is stored
// server-side, so before this file there was nothing to revoke: the middleware
// checked that `session.user` existed and every gate downstream trusted
// `session.user.id`. Delete your account from your laptop and your phone kept
// full paid access to the retained entitlements, could export the tombstone, and
// could re-create preference rows — for as long as the cookie lived. "Sign out
// everywhere" was not merely missing, it was unimplementable.
//
// The fix is the smallest thing that makes a stateless cookie revocable: date
// the cookie (`issuedAt`, set in server/utils/auth.ts) and give the account a
// watermark (`users.sessions_invalid_before`, set by deletion). A session
// issued before the watermark is dead.
//
// ── The cost, stated plainly ─────────────────────────────────────────────────
// One indexed primary-key read on `users` per authenticated request. That is a
// real cost on a stack whose whole auth story was "zero reads", and it was
// weighed against a KV cache of the answer.
//
// A cache was rejected, and not on latency grounds. Caching "this session is
// valid" for N seconds means a revoked session keeps working for up to N
// seconds — reintroducing, in miniature, exactly the bug being fixed. KV is
// eventually consistent on top of that, so the window would not even be a
// number you could quote to a customer asking "is my old phone signed out
// yet?". A deny-list in KV fails the same way and in the more dangerous
// direction: a revocation that has not propagated is a session that still
// works, and it fails OPEN. D1 is strongly consistent and the read is a
// point lookup on the primary key; most authenticated routes already talk to
// D1 anyway. If a fork ever needs the read back, the honest lever is a shorter
// session cookie lifetime, not a cache that makes the guarantee fuzzy.

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
// Explicit, not the Nitro auto-import: the workerd vitest suite loads this file
// directly and nothing is injected there.
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
 * Where the middleware parks the row it just read, for requireAdmin().
 *
 * A per-request cache, not a cross-request one — `event.context` dies with the
 * request, so this cannot go stale the way the KV cache rejected in the note
 * above would. It exists because the guard and requireAdmin() were reading the
 * same primary key on every single admin call: two round trips for one row.
 */
export const SESSION_ROLE_CONTEXT_KEY = 'sessionRole'

/**
 * Should a revoked session be cleared WITHOUT aborting this request?
 *
 * ── The lockout this prevents ────────────────────────────────────────────────
 * The guard used to 401 everything, including the sign-in surface — and the one
 * cookie guaranteed to be present at the moment somebody is trying to sign in
 * again is the stale one. So: `/login`'s SSR fetch of `/api/auth/providers`
 * 401d and the page rendered "No sign-in method is configured" forever; a
 * perfectly good magic link read as "we don't recognise that sign-in link"; and
 * an OAuth callback dumped raw JSON into the browser. A dead cookie became an
 * unrecoverable lockout from the product.
 *
 * The rule: anything whose whole job is to END or REPLACE the credential is
 * allowed to proceed, because none of them read the session to decide anything.
 *
 *   /api/auth/*   the sign-in surface — OAuth callbacks, the magic-link mint
 *                 and verify, the provider list, logout. How someone recovers.
 *   /api/health   a liveness probe must not depend on a cookie.
 *   DELETE /api/_auth/session   signing out authorizes nothing; it destroys a
 *                 credential. 401ing it would also make
 *                 useUserSession().clear() throw, which it does not catch.
 *
 * GET /api/_auth/session is deliberately NOT here. It must fail, because
 * useUserSession().fetch() catches a failed response and nulls the session —
 * that is what flips the other browser to signed-out. Letting it through would
 * achieve nothing anyway: h3's clearSession drops the cached session from the
 * request context, so the endpoint would re-unseal the same cookie and report
 * the revoked user as present.
 */
export function isSessionClearOnlyPath(path: string, method: string): boolean {
  if (path.startsWith('/api/auth/')) return true
  if (path === '/api/health') return true
  return path === '/api/_auth/session' && method === 'DELETE'
}

/**
 * Is the account behind this session still allowed to act?
 *
 * Three refusals, in the order they matter:
 *
 *   no_account  The row is gone entirely. Nothing in this app deletes a `users`
 *               row today (deletion anonymizes in place), so this is the
 *               belt-and-braces case: a hand-run DELETE, a restored backup, a
 *               session minted against a different database.
 *   deleted     The row is a tombstone. Redundant with the watermark below,
 *               since deletion sets both — and kept anyway, because it costs
 *               nothing (the email is in the row we already read) and it means
 *               a tombstone can never authorize a call even if some future code
 *               path forgets to set the watermark.
 *   revoked /   The account has a revocation instant and this session either
 *   undated     predates it or cannot say. "Cannot say" is a refusal on purpose:
 *               a session with no `issuedAt` is one sealed before this feature
 *               existed, and letting it through would mean the one class of
 *               cookie an attacker would most like to be holding is the one
 *               class the check waves past. Accounts that have never revoked
 *               anything have a NULL watermark and are unaffected, so the
 *               upgrade logs nobody out.
 *
 * Takes the Drizzle client explicitly, like the rest of server/utils, so
 * test/session-guard.test.ts can drive it against a real D1 inside workerd.
 */
export async function checkSession(
  db: SessionGuardDb,
  claim: SessionClaim,
): Promise<SessionVerdict> {
  const row = await db.query.users.findFirst({
    where: eq(tables.users.id, claim.userId),
    // `role` is not needed here — it is fetched so requireAdmin() can reuse the
    // row this guard has already read. Both run on every admin request, both on
    // the same primary key, and reading two columns costs the same as one.
    columns: { email: true, role: true, sessionsInvalidBefore: true },
  })

  if (!row) return { valid: false, reason: 'no_account' }
  if (isUndeliverableAddress(row.email)) return { valid: false, reason: 'deleted' }

  const watermark = row.sessionsInvalidBefore
  if (!watermark) return { valid: true, role: row.role }

  if (claim.issuedAt === undefined) return { valid: false, reason: 'undated' }
  // Seconds on both sides: D1 stores timestamps at second resolution, so a
  // millisecond comparison would round-trip a session issued in the same second
  // as the revocation into whichever side the truncation fell on. `<` rather
  // than `<=` — a session issued in the revocation second is the one being
  // created by a *new* sign-in, and must survive.
  return claim.issuedAt < Math.floor(watermark.getTime() / 1000)
    ? { valid: false, reason: 'revoked' }
    : { valid: true, role: row.role }
}
