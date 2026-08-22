// The one salt that must never change.
//
// ── Why this is not derived from sessionPassword ─────────────────────────────
// server/utils/unsubscribe.ts sets this repo's rule: "a new secret is a human
// gate", so the unsubscribe key is derived from `sessionPassword` rather than
// being its own env var. That reasoning is right and it does not reach here,
// for one reason: an unsubscribe token is short-lived and re-issued on every
// email, so rotating the password merely invalidates links in flight. The
// referral welcome trial is the opposite — its whole enforcement mechanism is a
// PERMANENT deterministic ref (`welcome_<hash of mailbox>`) meeting a unique
// index, so the salt has to outlive everything, forever.
//
// Rotate `sessionPassword` after a compromise — the reasonable thing to do, and
// not the same thing as this repo's actual sign-everyone-out mechanism, which
// is the `users.sessions_invalid_before` watermark — and every mailbox's ref is
// recomputed, every spent trial silently re-arms, and the product starts giving
// free months to people who already had one. Nothing fails, nothing logs, and
// the graph moves three weeks later.
//
// ── Why not NUXT_IDENTITY_SALT either ────────────────────────────────────────
// Because that is precisely the human gate the rule above exists to avoid, and
// it fails in the direction that matters: the fork that never sets it is the
// fork that gets the bug, and the warning telling them so is a log line nobody
// reads. A value generated once and kept makes the DEFAULT correct rather than
// the documented path correct, which is the same trade the design and SEO gates
// in this repo make everywhere else.
//
// So: 32 random bytes, written once, read forever. No configuration, no
// rotation story, and nothing for a fork to get wrong.

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
import { base64url } from './hash'

export type IdentityDb = ReturnType<typeof drizzle<typeof tables>>

/** The row id. Chosen here, in code — never from a request (see schema.ts). */
export const IDENTITY_SALT_ID = 'identity-salt'

/**
 * Memoised per isolate. The value is immutable by construction, so there is no
 * invalidation to get wrong — unlike the session-revocation read in
 * server/utils/session-guard.ts, which is deliberately uncached because the
 * whole point of that column is that it changes underneath you.
 */
let cached: string | null = null

/**
 * The deployment's identity salt, generating it on first use.
 *
 * ── Race safety, which is the only interesting part ──────────────────────────
 * Two requests can reach a virgin database at the same moment, and if both
 * generated a salt and both kept their own, two mailboxes' worth of refs would
 * be computed under different salts — the exact invariant break this salt
 * exists to prevent, on day one, permanently.
 *
 * `INSERT … ON CONFLICT DO NOTHING` followed by a read makes that impossible
 * without a transaction: both writers race, the primary key lets exactly one
 * win, and both then read the winner's value. The loser's random bytes are
 * discarded before anything is derived from them.
 */
export async function getIdentitySalt(db: IdentityDb): Promise<string> {
  if (cached) return cached

  const existing = await db.query.instanceSecrets.findFirst({
    where: eq(tables.instanceSecrets.id, IDENTITY_SALT_ID),
    columns: { value: true },
  })
  if (existing?.value) {
    cached = existing.value
    return cached
  }

  // 32 bytes — the same budget as a session key. base64url so the value is
  // printable if somebody ever has to look at it in a database console.
  const candidate = base64url(crypto.getRandomValues(new Uint8Array(32)))
  await db
    .insert(tables.instanceSecrets)
    .values({ id: IDENTITY_SALT_ID, value: candidate })
    .onConflictDoNothing({ target: tables.instanceSecrets.id })

  // Read back rather than trusting `candidate`: on the losing side of a race
  // the insert did nothing, and the row now holds somebody else's bytes.
  const stored = await db.query.instanceSecrets.findFirst({
    where: eq(tables.instanceSecrets.id, IDENTITY_SALT_ID),
    columns: { value: true },
  })
  if (!stored?.value) {
    // Practically unreachable — the insert either wrote a row or lost to one.
    throw new Error('identity salt could not be provisioned')
  }

  cached = stored.value
  return cached
}

/** Drop the memo. Tests only — production has nothing that should call this. */
export function resetIdentitySaltCache(): void {
  cached = null
}
