// User provisioning — the bridge between an OAuth callback and a `users` row.
// Every function takes the Drizzle client explicitly (not the auto-imported
// `db`) so test/users.test.ts can drive it against real D1 in workerd.
//
// A verified email IS the account key: GitHub today and Google tomorrow on the
// same address land on one row. That is only safe because the caller guarantees
// verification (server/utils/auth.ts › completeOAuthSignIn); an unverified
// address is an account-takeover primitive (register the victim's address at a
// sloppy provider, inherit their subscription). Never relax that check.

import { eq } from 'drizzle-orm'
import type { Attribution } from '#shared/utils/attribution'
import * as tables from '../db/schema'
import type { NewUser, User } from '../db/schema'
import type { ExtensionDb as Db } from './extensions'
import { getSignupContributors } from './signup-contributors'
import type { SignupContributor } from './signup-contributors'

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
 * Addresses this app must never mail, and never mint a credential for.
 *
 * The one that matters: deleted-account tombstones. Deletion anonymizes the
 * `users` row in place (server/utils/account.ts; the id survives because
 * `entitlements.user_id` is a real FK and billing records are kept for tax law)
 * and leaves `deleted-<id>@deleted.invalid`. Identity here is the email, so a
 * magic link minted for it would redeem to a session for the deleted account's
 * id, with its entitlement history, audit trail and `role`: resurrection from a
 * leaked user id. Resend refusing `.invalid` today is a coincidence, not a
 * guard; an authentication boundary does not get to live in someone else's input
 * validation.
 *
 * The whole TLD, not the exact string: RFC 2606 reserves `.invalid` so it never
 * resolves, so this costs no real user and survives the tombstone's spelling
 * changing. Sibling reservations are NOT here: `.example` is what our fixtures
 * and dev sign-in use. Lives beside normalizeEmail() because it is a rule about
 * the identity key; server/utils/session-guard.ts reads it too.
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
 * The one mailbox an address actually reaches, for rate-limiting ONLY.
 *
 * normalizeEmail() is not enough: `victim+1@gmail.com` … `+9999` are thousands
 * of strings for ONE inbox, so a limiter keyed on the normalized form is
 * stepped around by incrementing a counter while every message still reaches
 * the person flooded (Gmail also ignores dots).
 *
 * NOT the identity key: `a.b@` and `ab@` are different people on most providers
 * (hence only the two documented domains are special-cased), and collapsing
 * identities on a guess would merge strangers' accounts. Accounts stay keyed on
 * normalizeEmail(); this is only the budget's bucket (`magic_link_tokens.mailbox`),
 * where a false merge costs one person a slower retry.
 */
export function canonicalizeEmailForLimiting(email: string): string {
  const normalized = normalizeEmail(email)
  const at = normalized.lastIndexOf('@')
  if (at <= 0) return normalized

  let local = normalized.slice(0, at)
  const rawDomain = normalized.slice(at + 1)
  const domain = DOT_INSENSITIVE_DOMAINS.get(rawDomain) ?? rawDomain

  // `plus > 0`, not `>= 0`: a local part that IS the tag (`+x@…`) would collapse to `@domain`, one shared bucket.
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)

  if (DOT_INSENSITIVE_DOMAINS.has(rawDomain)) local = local.replaceAll('.', '')

  return local ? `${local}@${domain}` : normalized
}

/**
 * Do these two addresses reach the same inbox? May use the looser limiting form
 * because it only ever REFUSES, never merges: a false merge hands one stranger
 * another's account, a false refusal costs two people sharing a canonical form
 * one referral reward. On money the refusing direction is safe, and it is the
 * only comparison that catches `me+1@gmail.com` referred by `me@gmail.com`'s
 * code. Outside the two dot-insensitive domains it folds only `+tags`, the same
 * mailbox by definition. Accounts stay keyed on normalizeEmail().
 */
export function isSameMailbox(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return canonicalizeEmailForLimiting(a) === canonicalizeEmailForLimiting(b)
}

/** Fall back to the local-part when a provider has no display name (common on GitHub). */
function displayName(profile: OAuthProfile, email: string): string {
  const name = profile.name?.trim()
  if (name) return name
  return email.split('@')[0] ?? 'there'
}

/**
 * Find-or-create the user behind an OAuth profile, and record the sign-in.
 * Returning users get name/avatar refreshed but never their role (ours to set).
 * `attribution` is written on the INSERT branch only: first-touch by definition
 * (see server/db/schema.ts › users).
 */
export interface UpsertOAuthUserOptions {
  /**
   * Replaces the registered signup contributors. Production never passes this.
   * A collision on a minted column is a 1-in-10^11 event, so the retry branch and
   * a contributor's `isCollision` match against a D1-produced message would never
   * run; a test hands in a contributor it controls and forces a real
   * unique-index violation to prove the retry recovers.
   */
  contributors?: SignupContributor[]
}

export async function upsertOAuthUser(
  db: Db,
  profile: OAuthProfile,
  attribution?: Attribution | null,
  options: UpsertOAuthUserOptions = {},
): Promise<SignInResult> {
  const contributors = options.contributors ?? getSignupContributors()
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

  // INSERT branch only, like the attribution columns: each answers "who
  // introduced this customer" once, forever. Also the only place a cookie
  // *claim* becomes a fact (referral drops a code that names no real, live,
  // other account). See server/utils/signup-contributors.ts.
  let resolved: Partial<NewUser> = {}
  for (const contributor of contributors) {
    if (contributor.resolve) {
      resolved = { ...resolved, ...(await contributor.resolve(db, { email, attribution })) }
    }
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
    ...resolved,
  }

  // Columns a feature mints (the referral code) are made at creation so no later
  // path handles "user without one". Collisions are caught where they surface
  // (the unique index; a pre-flight SELECT would race) and retried with new
  // values. Bounded: at 30^8 a first collision should never happen, and five in
  // a row means broken randomness, which must throw rather than hang sign-in.
  const attempts = Math.max(1, ...contributors.map((c) => c.mintAttempts ?? 1))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const minted = contributors.reduce<Partial<NewUser>>(
        (columns, contributor) => ({ ...columns, ...contributor.mint?.() }),
        {},
      )
      const [created] = await db
        .insert(tables.users)
        .values({ ...values, ...minted })
        .returning()

      if (!created) {
        // Practically unreachable, but a missing row would mean a session for a nonexistent user.
        throw new Error('User insert returned no row')
      }

      return { user: created, created: true }
    } catch (error) {
      if (attempt === attempts || !contributors.some((c) => c.isCollision?.(error))) throw error
    }
  }

  // Unreachable: the loop returns or rethrows on its last attempt.
  throw new Error('User insert exhausted its mint attempts')
}

/** Null rather than a throw: a missing row must not fail the webhook that asked. */
export async function findUserById(db: Db, id: string): Promise<User | null> {
  const user = await db.query.users.findFirst({ where: eq(tables.users.id, id) })
  return user ?? null
}
