// Magic-link sign-in — mint, inspect, redeem. The consumer front door: an email
// address and a link, no password. Every function takes the Drizzle client
// explicitly so test/magic-link.test.ts can drive the lifecycle (a replayed link
// must lose, an expired one must not work) against real D1 in workerd.
//
// The token is 32 bytes of CSPRNG, base64url. Not the alphabet-and-modulo shape
// of connect and referral codes: nobody reads it aloud, so a confusable-free
// alphabet buys nothing, and `byte % alphabet.length` is biased unless the
// alphabet divides 256, which matters for the one token protected only by being
// unguessable. base64url maps 6 bits per character with no remainder. Only its
// SHA-256 reaches the database (a leaked D1 snapshot holds no live links), and
// that hash is deliberately UNSALTED, unlike server/utils/hash.ts: salting
// stops rainbow-tabling a low-entropy value, and 256 random bits have no
// dictionary; a salt would only tie the digest to config the verify path must
// keep in sync forever.

import { and, count, eq, gt, isNull, lt } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import type { Attribution } from '#shared/utils/attribution'
import * as tables from '../db/schema'
import type { MagicLinkToken } from '../db/schema'
import { base64url, sha256Hex } from './hash'
import { canonicalizeEmailForLimiting, isUndeliverableAddress, normalizeEmail } from './users'

export type MagicLinkDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * How long a link stays usable: the shortest window that survives request on a
 * laptop, unlock a phone, tap through a mail client. Longer leaves a live
 * credential in an inbox that may be shared or compromised.
 */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60

/**
 * Per-address limit, on top of the per-IP limit server/middleware/auth.ts puts on
 * `/api/auth/`. The IP limit alone cannot stop a botnet using this endpoint
 * (mail to a caller-chosen address) to flood one inbox from a trusted domain.
 * Five per 15 minutes is above what a confused human needs and below a useful
 * mail cannon. Exported so test/magic-link.test.ts uses the real numbers.
 */
export const MAGIC_LINK_RATE_LIMIT = {
  name: 'magic-link',
  limit: 5,
  windowSeconds: 15 * 60,
} as const

/** Random bytes per token. 32 = 256 bits, the same budget as a session key. */
const TOKEN_BYTES = 32

/**
 * What a token may look like, so a route rejects junk before a DB round trip.
 * A length range, not the exact 43, so changing TOKEN_BYTES keeps links in
 * flight valid.
 */
export const MAGIC_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

/** A fresh, unguessable token. The plaintext exists only in the email. */
export function generateMagicLinkToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
}

/** SHA-256, hex. The only form of a token that is ever written down. */
export async function hashMagicLinkToken(token: string): Promise<string> {
  return sha256Hex(token)
}

export type MagicLinkFailure = 'invalid' | 'expired' | 'used'

export type MagicLinkLookup =
  | { ok: true; record: MagicLinkToken }
  | { ok: false; reason: MagicLinkFailure }

export interface CreateMagicLinkTokenInput {
  /** Normalized here as well as by the caller — the DB row must match `users.email`. */
  email: string
  /** Already run through safeRedirectPath() by the caller. Null when absent. */
  redirectTo?: string | null
  attribution?: Attribution | null
}

export interface CreateMagicLinkTokenResult {
  token: string
  record: MagicLinkToken
  /**
   * false when this mailbox already minted MAGIC_LINK_RATE_LIMIT.limit links
   * in the window. The row is still written (it is the charge), but the caller
   * must not send the mail.
   */
  withinBudget: boolean
}

/**
 * Mint a link for an address, storing only its hash, and charge the mailbox's
 * budget in the same D1 batch. Earlier links for the address are deliberately
 * NOT invalidated: "request again, then click the older message" is the commonest
 * way a flow wrongly tells a user their link is broken. The exposure is bounded
 * by the rate limit: five live, single-use, self-expiring links per quarter hour.
 */
export async function createMagicLinkToken(
  db: MagicLinkDb,
  input: CreateMagicLinkTokenInput,
  now: Date = new Date(),
): Promise<CreateMagicLinkTokenResult> {
  const email = normalizeEmail(input.email)

  // Re-checked here, closer to the write, rather than trusted to the route: a
  // rule is only as strong as its weakest caller, and this keeps a deleted
  // account deleted. It throws because the route answers such a request with its
  // ordinary success body and never gets here; an exception means a second
  // caller lacks the guard.
  if (isUndeliverableAddress(email)) {
    throw new Error('Refusing to mint a magic link for a reserved address')
  }

  // Opportunistic sweep scoped to this address (bounded by the per-address
  // limit); a global sweep belongs in a scheduled task, not a sign-in request.
  await db
    .delete(tables.magicLinkTokens)
    .where(and(eq(tables.magicLinkTokens.email, email), lt(tables.magicLinkTokens.expiresAt, now)))

  const token = generateMagicLinkToken()
  const mailbox = canonicalizeEmailForLimiting(email)
  const windowStart = new Date(now.getTime() - MAGIC_LINK_RATE_LIMIT.windowSeconds * 1000)
  // One batch: the count sees this insert and D1 serialises concurrent mints for the mailbox (the k-th insert counts k).
  const [inserted, counted] = await db.batch([
    db
      .insert(tables.magicLinkTokens)
      .values({
        email,
        mailbox,
        createdAt: now,
        tokenHash: await hashMagicLinkToken(token),
        expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000),
        redirectTo: input.redirectTo || null,
        signupSource: input.attribution?.source ?? null,
        signupMedium: input.attribution?.medium ?? null,
        signupCampaign: input.attribution?.campaign ?? null,
        signupReferrer: input.attribution?.referrer ?? null,
        // Shape-validated by attributionSchema, re-validated at redemption before it
        // can name an account; this column only carries it across devices.
        referralCode: input.attribution?.referralCode ?? null,
      })
      .returning(),
    db
      .select({ minted: count() })
      .from(tables.magicLinkTokens)
      .where(
        and(
          eq(tables.magicLinkTokens.mailbox, mailbox),
          gt(tables.magicLinkTokens.createdAt, windowStart),
        ),
      ),
  ])

  const record = inserted[0]
  if (!record) {
    // Practically unreachable, but a missing row would email a link that can never redeem.
    throw new Error('Magic link insert returned no row')
  }
  const minted = counted[0]?.minted ?? 0

  return { token, record, withinBudget: minted <= MAGIC_LINK_RATE_LIMIT.limit }
}

/** Why a lookup failed, for a page that can say something useful about it. */
async function diagnose(db: MagicLinkDb, tokenHash: string, now: Date): Promise<MagicLinkFailure> {
  const record = await db.query.magicLinkTokens.findFirst({
    where: eq(tables.magicLinkTokens.tokenHash, tokenHash),
  })
  if (!record) return 'invalid'
  if (record.usedAt) return 'used'
  if (record.expiresAt <= now) return 'expired'
  // Usable after all: the redeeming UPDATE lost a race, indistinguishable from a replay.
  return 'used'
}

/**
 * Look at a token without spending it: all a GET may do, so /auth/verify can
 * report an expired link before the click and a mail scanner consumes nothing
 * (see server/api/auth/magic-link/verify.get.ts).
 */
export async function inspectMagicLinkToken(
  db: MagicLinkDb,
  token: string,
  now: Date = new Date(),
): Promise<MagicLinkLookup> {
  const tokenHash = await hashMagicLinkToken(token)
  const record = await db.query.magicLinkTokens.findFirst({
    where: eq(tables.magicLinkTokens.tokenHash, tokenHash),
  })
  if (!record) return { ok: false, reason: 'invalid' }
  if (record.usedAt) return { ok: false, reason: 'used' }
  if (record.expiresAt <= now) return { ok: false, reason: 'expired' }
  return { ok: true, record }
}

/**
 * Spend a token, once. Check and write are ONE statement (`UPDATE … WHERE
 * used_at IS NULL AND expires_at > now RETURNING *`): read-then-write is a login
 * bypass, as two requests with one token both read `used_at IS NULL` and both
 * get a session, and the unique index does not help since neither inserts. The
 * database decides; exactly one UPDATE matches. The diagnosis read runs only on
 * failure.
 */
export async function consumeMagicLinkToken(
  db: MagicLinkDb,
  token: string,
  now: Date = new Date(),
): Promise<MagicLinkLookup> {
  const tokenHash = await hashMagicLinkToken(token)

  const [record] = await db
    .update(tables.magicLinkTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(tables.magicLinkTokens.tokenHash, tokenHash),
        isNull(tables.magicLinkTokens.usedAt),
        gt(tables.magicLinkTokens.expiresAt, now),
      ),
    )
    .returning()

  if (record) return { ok: true, record }
  return { ok: false, reason: await diagnose(db, tokenHash, now) }
}

/** Drop a link minted but never sent, so "a row means a live link is out there" stays true. */
export async function discardMagicLinkToken(db: MagicLinkDb, id: string): Promise<void> {
  await db.delete(tables.magicLinkTokens).where(eq(tables.magicLinkTokens.id, id))
}

/**
 * Rebuild the first-touch attribution captured at mint time. `undefined` (none)
 * lets establishSession() fall back to the `attr` cookie; `null` would suppress
 * it. `referralCode` is carried so a link opened on another device still credits
 * the sharer.
 */
export function attributionFromRecord(record: MagicLinkToken): Attribution | undefined {
  const attribution: Attribution = {
    source: record.signupSource ?? undefined,
    medium: record.signupMedium ?? undefined,
    campaign: record.signupCampaign ?? undefined,
    referrer: record.signupReferrer ?? undefined,
    referralCode: record.referralCode ?? undefined,
  }
  const known = Object.values(attribution).some((value) => value !== undefined)
  return known ? attribution : undefined
}
