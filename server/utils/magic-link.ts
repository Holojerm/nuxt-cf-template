// Magic-link sign-in — mint, inspect, redeem.
//
// This is the consumer front door: an email address, a link, no password and no
// developer account anywhere in the flow. The OAuth providers sit under it as
// conveniences, not as the only way in.
//
// Like server/utils/users.ts, every function here takes the Drizzle client
// explicitly instead of reaching for the auto-imported `db`, so
// test/magic-link.test.ts can drive the whole lifecycle against a real D1
// binding inside workerd without booting Nitro. The lifecycle is the part worth
// testing: a replayed link must lose, and an expired one must not quietly work.
//
// ── The token ────────────────────────────────────────────────────────────────
// 32 bytes of CSPRNG output, base64url-encoded. Not the alphabet-and-modulo
// shape used for connect codes and referral codes (server/utils/users.ts), for
// two reasons:
//
//   * Nobody reads a magic-link token aloud. It lives in a URL and is clicked,
//     so the confusable-character alphabet those two need buys nothing here and
//     costs entropy per character.
//   * `byte % alphabet.length` is biased whenever the alphabet does not divide
//     256, and this is the one token in the app whose sole protection is being
//     unguessable. base64url maps 6 bits to one character with no remainder, so
//     there is no fold and no bias to reason about.
//
// Only the SHA-256 hash reaches the database, so a leaked D1 snapshot contains
// no live links. That hash is deliberately UNSALTED, unlike server/utils/hash.ts:
// salting exists there to stop a low-entropy value (an email, an IP) being
// rainbow-tabled, and 256 bits of randomness has no dictionary to be tabled
// against. Adding a salt would only make the digest depend on a config value the
// verify path would then have to keep in sync forever.

import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import type { Attribution } from '#shared/utils/attribution'
import * as tables from '../db/schema'
import type { MagicLinkToken } from '../db/schema'
import { base64url, sha256Hex } from './hash'
import { isUndeliverableAddress, normalizeEmail } from './users'

export type MagicLinkDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * How long a link stays usable.
 *
 * Fifteen minutes is the shortest window that still survives the realistic
 * path: request on a laptop, unlock a phone, wait for the push, tap through a
 * mail client. Shorter reads as broken to anyone who steps away from their desk;
 * longer leaves a live credential sitting in an inbox that may be shared,
 * synced, or already compromised.
 */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60

/**
 * Per-address limit, applied on top of the 30/min per-IP limit that
 * server/middleware/auth.ts already puts on the whole `/api/auth/` surface.
 *
 * The IP limit alone does not cover the abuse that matters here: this endpoint
 * sends mail to an address chosen by an anonymous caller, so without a
 * per-address bucket a botnet spread across many IPs can use it to flood one
 * person's inbox from a domain they trust. Five in fifteen minutes is well above
 * what a confused human needs ("did that send? let me try again") and far below
 * what makes a useful mail cannon.
 *
 * Exported so test/magic-link.test.ts can drive the real numbers through
 * consumeRateLimit() rather than asserting against a copy of them.
 */
export const MAGIC_LINK_RATE_LIMIT = {
  name: 'magic-link',
  limit: 5,
  windowSeconds: 15 * 60,
} as const

/** Random bytes per token. 32 = 256 bits, the same budget as a session key. */
const TOKEN_BYTES = 32

/**
 * What a token is allowed to look like, so a route can reject junk before it
 * costs a database round trip. Length is a range rather than the exact 43
 * characters 32 bytes encodes to, so changing TOKEN_BYTES doesn't silently
 * invalidate every link in flight.
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

/**
 * Mint a link for an address, storing only its hash.
 *
 * Previously-issued links for the same address are NOT invalidated. That is a
 * decision, not an oversight: people click the first mail they find, and
 * "request again, then click the older message" is the single most common way a
 * magic-link flow tells a user their link is broken when it isn't. The exposure
 * that buys is bounded by the rate limit above — at most five live links per
 * address per quarter hour, each single-use and each expiring on its own.
 */
export async function createMagicLinkToken(
  db: MagicLinkDb,
  input: CreateMagicLinkTokenInput,
  now: Date = new Date(),
): Promise<{ token: string; record: MagicLinkToken }> {
  const email = normalizeEmail(input.email)

  // Re-checked here, one layer closer to the write, rather than trusted to the
  // route — the same reasoning server/utils/email.ts gives for re-checking
  // isMandatoryNotification() itself: a rule is only as strong as its weakest
  // caller, and this one is the difference between a deleted account staying
  // deleted and not. Throwing rather than returning is right *because* nothing
  // should ever reach it: the route answers such a request with its ordinary
  // success body and never gets this far, so an exception here means a second
  // caller was added without the guard and should be loud about it.
  if (isUndeliverableAddress(email)) {
    throw new Error('Refusing to mint a magic link for a reserved address')
  }

  // Opportunistic sweep, scoped to this address and therefore bounded by the
  // per-address rate limit — never a full-table scan. A global sweep of every
  // expired row belongs in a scheduled task, not on the critical path of a
  // sign-in request.
  await db
    .delete(tables.magicLinkTokens)
    .where(and(eq(tables.magicLinkTokens.email, email), lt(tables.magicLinkTokens.expiresAt, now)))

  const token = generateMagicLinkToken()
  const [record] = await db
    .insert(tables.magicLinkTokens)
    .values({
      email,
      tokenHash: await hashMagicLinkToken(token),
      expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000),
      redirectTo: input.redirectTo || null,
      signupSource: input.attribution?.source ?? null,
      signupMedium: input.attribution?.medium ?? null,
      signupCampaign: input.attribution?.campaign ?? null,
      signupReferrer: input.attribution?.referrer ?? null,
    })
    .returning()

  if (!record) {
    // Practically unreachable — D1 returns the row or throws — but a missing row
    // here would mean emailing a link that can never be redeemed.
    throw new Error('Magic link insert returned no row')
  }

  return { token, record }
}

/** Why a lookup failed, for a page that can say something useful about it. */
async function diagnose(db: MagicLinkDb, tokenHash: string, now: Date): Promise<MagicLinkFailure> {
  const record = await db.query.magicLinkTokens.findFirst({
    where: eq(tables.magicLinkTokens.tokenHash, tokenHash),
  })
  if (!record) return 'invalid'
  if (record.usedAt) return 'used'
  if (record.expiresAt <= now) return 'expired'
  // Usable after all — the redeeming UPDATE lost a race with a concurrent one,
  // which from this caller's point of view is indistinguishable from a replay.
  return 'used'
}

/**
 * Look at a token without spending it.
 *
 * This is what a GET may safely do. It exists so /auth/verify can tell someone
 * their link expired *before* they click, rather than after — and so that a mail
 * scanner following the link consumes nothing. See
 * server/api/auth/magic-link/verify.get.ts for the full reasoning.
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
 * Spend a token, once.
 *
 * The check and the write are one statement — `UPDATE … WHERE used_at IS NULL
 * AND expires_at > now RETURNING *` — because the read-then-write version of
 * this is a login bypass with a race in it: two requests carrying the same
 * token both read `used_at IS NULL`, both write, and both get a session. The
 * unique index on `token_hash` does not help, since neither one is inserting.
 * Here the database decides, exactly one UPDATE matches a row, and the loser
 * gets nothing back to sign in with.
 *
 * The diagnosis on the failure path costs a second read, and only ever runs when
 * the link is already unusable.
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

/**
 * Drop a link that was minted but never sent.
 *
 * Keeps "a row in this table means a live link is out there" true, which is what
 * makes the table readable during an incident.
 */
export async function discardMagicLinkToken(db: MagicLinkDb, id: string): Promise<void> {
  await db.delete(tables.magicLinkTokens).where(eq(tables.magicLinkTokens.id, id))
}

/**
 * Rebuild the first-touch attribution that was captured when the link was minted.
 *
 * Returns `undefined` rather than `null` when the row carries none, because the
 * two mean different things to establishSession(): `undefined` lets it fall back
 * to the `attr` cookie on the redeeming request, `null` asserts "there is no
 * attribution" and suppresses that fallback.
 */
export function attributionFromRecord(record: MagicLinkToken): Attribution | undefined {
  const attribution: Attribution = {
    source: record.signupSource ?? undefined,
    medium: record.signupMedium ?? undefined,
    campaign: record.signupCampaign ?? undefined,
    referrer: record.signupReferrer ?? undefined,
  }
  const known = Object.values(attribution).some((value) => value !== undefined)
  return known ? attribution : undefined
}
