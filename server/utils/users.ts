// User provisioning — the bridge between an OAuth callback and a `users` row.
//
// Like server/utils/entitlements.ts, every function here takes the Drizzle
// client explicitly instead of reaching for the auto-imported `db`, so the
// workerd suite (test/users.test.ts) can drive account creation against a real
// D1 binding without booting Nitro.
//
// ── Identity model ───────────────────────────────────────────────────────────
// A verified email address IS the account key. Sign in with GitHub today and
// Google tomorrow on the same address and you land on the same row — which is
// what users expect, and what avoids the duplicate-account support tickets that
// per-provider identities create.
//
// That model is only safe because the caller guarantees the email is verified
// (see server/utils/auth.ts › completeOAuthSignIn). An unverified email from
// any provider is an account-takeover primitive: register the victim's address
// at a sloppy provider, sign in here, inherit their subscription. Never relax
// that check.

import { eq } from 'drizzle-orm'
import type { Attribution } from '#shared/utils/attribution'
import * as tables from '../db/schema'
import type { User } from '../db/schema'
import type { EntitlementDb as Db } from './entitlements'

/** The normalized profile an OAuth callback hands over. */
export interface OAuthProfile {
  /** Which button the user pressed. Stored for support ("how do I get back in?"). */
  provider: string
  /** Verified email — the account key. Callers MUST have checked verification. */
  email: string
  name?: string | null
  avatarUrl?: string | null
}

export interface SignInResult {
  user: User
  /** True on the very first sign-in — the caller sends the welcome email. */
  created: boolean
}

/** Lowercase + trim. Providers are inconsistent about casing; the unique index isn't. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Addresses this app must never mail, and must never mint a credential for.
 *
 * ── The one that matters: deleted-account tombstones ─────────────────────────
 * Deleting an account anonymizes the `users` row in place rather than removing
 * it (server/utils/account.ts — the id has to survive, because
 * `entitlements.user_id` is a real foreign key and billing records are kept for
 * tax law). The scrubbed row keeps a synthetic address,
 * `deleted-<id>@deleted.invalid`.
 *
 * That address is still an address, and identity here is the email. Mint a
 * magic link for it and redeeming that link would find the tombstone row by
 * email and hand out a session for the deleted account's id — with its
 * entitlement history, its audit trail, and whatever `role` it had. Account
 * resurrection, from nothing but a leaked user id.
 *
 * In practice Resend refuses `.invalid` today, so the mail never leaves. That
 * is not a guard, it's a coincidence: it depends on a third party's address
 * validation, and a fork that swaps mail providers or points a catch-all domain
 * at itself loses it silently. An authentication boundary does not get to live
 * in someone else's input validation.
 *
 * ── Why the whole TLD, not the exact tombstone string ────────────────────────
 * `.invalid` is reserved by RFC 2606 precisely so that it can never resolve, so
 * refusing all of it costs zero real users and survives the tombstone's
 * spelling changing later. The sibling reservations are deliberately NOT here:
 * `.example` is what this repo's own fixtures and dev sign-in run on.
 *
 * Lives beside normalizeEmail() rather than with the magic-link code because it
 * is a rule about the identity key itself — the session guard
 * (server/utils/session-guard.ts) reads it too.
 */
export function isUndeliverableAddress(email: string): boolean {
  const domain = normalizeEmail(email).split('@').pop() ?? ''
  return domain === 'invalid' || domain.endsWith('.invalid')
}

/**
 * Providers that deliver every dotted spelling of a local part to one mailbox,
 * and treat their alternate domain as the same account.
 */
const DOT_INSENSITIVE_DOMAINS = new Map([
  ['gmail.com', 'gmail.com'],
  ['googlemail.com', 'gmail.com'],
])

/**
 * The one mailbox an address actually reaches, for rate-limiting purposes only.
 *
 * ── Why normalizeEmail() is not enough ───────────────────────────────────────
 * Trim-and-lowercase makes `Ada@Example.com` and `ada@example.com` one bucket,
 * and stops there. But `victim+1@gmail.com` … `victim+9999@gmail.com` are
 * thousands of distinct strings that all land in ONE inbox, so a per-address
 * limiter keyed on the normalized form is a limiter an attacker steps around by
 * incrementing a counter — while every message still arrives at the person
 * being flooded. Gmail also ignores dots, so `v.i.c.t.i.m@gmail.com` multiplies
 * that again.
 *
 * ── Why this is NOT the identity key ─────────────────────────────────────────
 * Two different people can legitimately own `a.b@example.com` and
 * `ab@example.com` on a provider that treats dots as significant — which is
 * most of them, and which is why this function only special-cases the two
 * domains that document otherwise. Collapsing identities on a guess would merge
 * two strangers' accounts. Accounts stay keyed on normalizeEmail(); this is
 * only ever a KV bucket name, where a false merge costs one person a slower
 * retry and nothing else.
 *
 * Callers limit on BOTH this and the exact address, so sub-addressing cannot
 * widen a budget and a shared canonical form cannot narrow someone else's.
 */
export function canonicalizeEmailForLimiting(email: string): string {
  const normalized = normalizeEmail(email)
  const at = normalized.lastIndexOf('@')
  if (at <= 0) return normalized

  let local = normalized.slice(0, at)
  const rawDomain = normalized.slice(at + 1)
  const domain = DOT_INSENSITIVE_DOMAINS.get(rawDomain) ?? rawDomain

  // `plus > 0`, not `>= 0`: an address whose local part IS the tag (`+x@…`)
  // would otherwise canonicalize to `@domain` and put every such address in one
  // shared bucket.
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)

  if (DOT_INSENSITIVE_DOMAINS.has(rawDomain)) local = local.replaceAll('.', '')

  return local ? `${local}@${domain}` : normalized
}

/** Fall back to the local-part when a provider has no display name (common on GitHub). */
function displayName(profile: OAuthProfile, email: string): string {
  const name = profile.name?.trim()
  if (name) return name
  return email.split('@')[0] ?? 'there'
}

// ── Referral codes ───────────────────────────────────────────────────────────
// A referral code ends up in a URL, in a tweet, and read aloud over a phone, so
// the alphabet drops every character people confuse when transcribing: 0/O,
// 1/I/L. What's left is 30 symbols, all URL-safe without escaping.
const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const REFERRAL_CODE_LENGTH = 8
/** Bounded retries on a code collision — see the insert branch below for why. */
const REFERRAL_CODE_ATTEMPTS = 5

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
 */
function isReferralCodeCollision(error: unknown): boolean {
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
 * Find-or-create the user behind an OAuth profile, and record the sign-in.
 *
 * Returning users get their name/avatar refreshed from the provider (people
 * change their avatar and expect the app to notice) but never their role —
 * that's ours to set, not the identity provider's.
 *
 * `attribution` is written on the INSERT branch only. It is first-touch by
 * definition (see server/db/schema.ts › users), so a returning user's channel
 * is already recorded and must not be overwritten by the cookie they happen to
 * be carrying today.
 */
export interface UpsertOAuthUserOptions {
  /**
   * Override for the code generator. Production never passes this.
   *
   * It exists because the retry below is the kind of code that is written once,
   * never executed, and quietly wrong — the collision it catches is a 1-in-10^11
   * event, so nothing would ever have exercised the branch OR the error-string
   * match inside isReferralCodeCollision(). That match is against a message D1
   * produces, so it cannot be verified by reasoning; it has to be run against a
   * real driver. This seam lets test/users.test.ts force a genuine unique-index
   * violation and prove the retry recovers.
   */
  mintCode?: () => string
}

export async function upsertOAuthUser(
  db: Db,
  profile: OAuthProfile,
  attribution?: Attribution | null,
  options: UpsertOAuthUserOptions = {},
): Promise<SignInResult> {
  const mintCode = options.mintCode ?? generateReferralCode
  const email = normalizeEmail(profile.email)
  const now = new Date()

  const existing = await db.query.users.findFirst({ where: eq(tables.users.email, email) })

  if (existing) {
    const [updated] = await db
      .update(tables.users)
      .set({
        name: displayName(profile, email),
        avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
        lastLoginAt: now,
      })
      .where(eq(tables.users.id, existing.id))
      .returning()
    return { user: updated ?? existing, created: false }
  }

  const values = {
    email,
    name: displayName(profile, email),
    avatarUrl: profile.avatarUrl ?? null,
    provider: profile.provider,
    lastLoginAt: now,
    signupSource: attribution?.source ?? null,
    signupMedium: attribution?.medium ?? null,
    signupCampaign: attribution?.campaign ?? null,
    signupReferrer: attribution?.referrer ?? null,
  }

  // Every account is minted a referral code here, at creation, so no later code
  // path has to handle "user without a code" — the column is nullable only for
  // rows that predate it.
  //
  // The retry is the deliberate half. A pre-flight SELECT would be a race, and
  // the unique index is the real guarantee anyway, so the collision is handled
  // where it actually surfaces: catch it, mint a different code, try again.
  // Bounded, because an unbounded loop turns a genuine schema problem into a
  // hung sign-in. At 30^8 this should never fire once; if it fires five times
  // the randomness is broken and that deserves to be thrown, not papered over.
  for (let attempt = 1; attempt <= REFERRAL_CODE_ATTEMPTS; attempt++) {
    try {
      const [created] = await db
        .insert(tables.users)
        .values({ ...values, referralCode: mintCode() })
        .returning()

      if (!created) {
        // Practically unreachable — D1 returns the row or throws — but a missing
        // row here would mean issuing a session for a user that doesn't exist.
        throw new Error('User insert returned no row')
      }

      return { user: created, created: true }
    } catch (error) {
      if (attempt === REFERRAL_CODE_ATTEMPTS || !isReferralCodeCollision(error)) throw error
    }
  }

  // Unreachable — the loop above either returns or rethrows on its last attempt.
  throw new Error('User insert exhausted referral code attempts')
}

/** Look up a user for a notification. Returns null rather than throwing — a
 *  missing row must not fail the webhook that triggered the lookup. */
export async function findUserById(db: Db, id: string): Promise<User | null> {
  const user = await db.query.users.findFirst({ where: eq(tables.users.id, id) })
  return user ?? null
}
