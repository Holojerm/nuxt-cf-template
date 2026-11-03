// Referral codes: minting one, recognising a collision on it, and resolving a
// claimed code to the account that holds it. The alphabet, the length and the
// pattern live in shared/utils/referral-code.ts because the attribution cookie
// validates an incoming `?ref=` against the same shape before it reaches a
// database write; a generator and a validator that disagree mint codes nobody
// can redeem, and the symptom is a referral program that silently credits
// nobody.

import { eq } from 'drizzle-orm'
import {
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  normalizeReferralCode,
} from '#shared/utils/referral-code'
import * as tables from '../db/schema'
import type { User } from '../db/schema'
import type { ExtensionDb as Db } from './extensions'
import { isSameMailbox, isUndeliverableAddress } from './users'

/**
 * A crypto-random referral code. 30^8 ≈ 6.6e11 possibilities, which is both
 * unguessable enough that codes can't be enumerated to farm rewards and sparse
 * enough that collisions stay theoretical.
 *
 * The rejection loop matters: 30 does not divide 256, so a bare `byte % 30`
 * would draw the first 16 symbols 12.5% more often than the last 14, and a
 * skewed code space is a smaller code space than its size suggests. The 6.25%
 * of bytes that would fold unevenly are discarded rather than folded.
 */
export function generateReferralCode(length: number = REFERRAL_CODE_LENGTH): string {
  const size = REFERRAL_CODE_ALPHABET.length
  const ceiling = Math.floor(256 / size) * size
  let code = ''
  while (code.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte >= ceiling) continue
      // charAt, not [], because it returns string rather than string|undefined.
      code += REFERRAL_CODE_ALPHABET.charAt(byte % size)
      if (code.length === length) break
    }
  }
  return code
}

/**
 * True only for a collision on `users.referral_code`.
 *
 * Narrow on purpose: the same insert can violate the `email` unique index when
 * two sign-ins for one address race, and retrying that would burn attempts and
 * then surface the identical error five calls later. That one must propagate
 * immediately.
 *
 * Exported for the second minting path — server/utils/referral.ts lazily mints
 * a code for accounts that predate the column, hits the same unique index, and
 * must recover the same way. A second copy of this cause-chain walk would be a
 * second chance to get it subtly wrong, on a branch nothing ever executes.
 */
export function isReferralCodeCollision(error: unknown): boolean {
  // Walks the cause chain, and that is the whole point. Drizzle does not
  // rethrow D1's error — it wraps it, so `error.message` is
  // "Failed query: insert into \"users\" …" and the actual
  // "D1_ERROR: UNIQUE constraint failed: users.referral_code" sits on
  // `error.cause`. Matching only the top-level message therefore matched
  // NOTHING: the retry below existed, looked correct, and had never once run.
  // A real collision would have thrown straight out of sign-in.
  //
  // Caught by test/users.test.ts, which forces a genuine violation through the
  // real driver rather than asserting against a hand-written error — the only
  // way this class of bug is findable, since the string comes from D1.
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : String(current)
    if (message.includes('UNIQUE constraint failed: users.referral_code')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/**
 * The account behind a referral code, or null — the only way a `?ref=` value is
 * ever allowed to become a fact about somebody's account.
 *
 * Lives apart from server/utils/referral.ts on purpose: the signup contributor
 * (referral-signup.ts) resolves a code at account creation and the payout code
 * resolves it again at payout time, and neither may import the other. Both read
 * the `users` table through users.ts's identity rules, one-directionally.
 *
 * Three refusals, each of which is a way somebody gets paid for nothing:
 *
 *   * A code that doesn't parse, or matches no row. Codes are 30^8, so anything
 *     typed by hand is noise — but noise that would otherwise be written into
 *     `users.referred_by` and read back later as a dangling claim.
 *   * A tombstone. Deleting an account nulls its `referral_code`
 *     (server/utils/account.ts), so a deleted referrer usually stops resolving
 *     on its own; the address check is the backstop for the case where a later
 *     account happens to mint the freed code. A deleted account cannot earn.
 *   * The caller's own mailbox. Not merely the same address — the same INBOX,
 *     via isSameMailbox(). The row being created cannot own a code yet, so an
 *     exact-address check here would never fire and never has; what it missed
 *     is the one shape that matters, `me+1@gmail.com` signing up on
 *     `me@gmail.com`'s code. That is one person, two accounts, and a self-
 *     referral in every sense except string equality.
 */
export async function findReferrerByCode(
  db: Db,
  rawCode: string | null | undefined,
  selfEmail?: string | null,
): Promise<User | null> {
  const code = normalizeReferralCode(rawCode)
  if (!code) return null

  const referrer = await db.query.users.findFirst({
    where: eq(tables.users.referralCode, code),
  })
  if (!referrer) return null
  if (isUndeliverableAddress(referrer.email)) return null
  // Mailbox, not exact address. `me+1@gmail.com` arriving on `me@gmail.com`'s
  // own code is one person with one inbox and two accounts, and an exact
  // comparison passes it — see isSameMailbox() for why the looser test is the
  // correct one on a refusal.
  if (isSameMailbox(referrer.email, selfEmail)) return null
  return referrer
}
