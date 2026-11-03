// User provisioning — the bridge between an OAuth callback and a `users` row.
//
// Like layers/billing/server/utils/entitlements.ts, every function here takes the Drizzle
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
 * only ever the budget's bucket key (`magic_link_tokens.mailbox`), where a
 * false merge costs one person a slower retry and nothing else.
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

/**
 * Do these two addresses reach the same inbox?
 *
 * ── Why this is allowed to use the limiting form, when identity may not ──────
 * canonicalizeEmailForLimiting() carries a loud warning that it is NOT the
 * identity key, because collapsing `a.b@` and `ab@` on a provider where dots
 * are significant would merge two strangers' accounts. That warning is about
 * MERGING. This function only ever REFUSES, and the two failure directions are
 * not comparable:
 *
 *   - A false merge grants one stranger access to another's account.
 *   - A false refusal here costs two people who genuinely share a canonical
 *     form one referral reward, and they can email support.
 *
 * On money, the refusing direction is the safe one, so the looser comparison is
 * the right one. It is also the only comparison that catches the attack it
 * exists for: `me+1@gmail.com` referred by `me@gmail.com`'s own code is one
 * person with one mailbox and two accounts, and an exact-match check waves it
 * straight through. Note the surface stays narrow — outside the two
 * dot-insensitive domains this only folds `+tags`, which are the same mailbox
 * by definition rather than by guess.
 *
 * Accounts are still keyed on normalizeEmail(). Nothing here merges anything.
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
   * Replaces the registered signup contributors. Production never passes this.
   *
   * It exists because the mint-and-retry below is the kind of code that is
   * written once, never executed, and quietly wrong — a collision on a minted
   * column is a 1-in-10^11 event, so nothing would ever have exercised the
   * branch OR the error-string match a contributor's `isCollision` does. That
   * match is against a message D1 produces, so it cannot be verified by
   * reasoning; it has to be run against a real driver. This lets a test hand in
   * a contributor whose generator it controls, force a genuine unique-index
   * violation and prove the retry recovers.
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

  // ── What features resolve about a new account, exactly once ────────────────
  // On the INSERT branch only, for the same reason the four attribution columns
  // are: these answer "who introduced this customer" and similar, and each has
  // one true answer forever. It is also the only place a *claim* from a cookie
  // becomes a fact (the referral feature drops a code that does not name a
  // real, live, other account). See server/utils/signup-contributors.ts.
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

  // Columns a feature mints for the new row (the referral code) are made here,
  // at creation, so no later code path has to handle "user without one" — the
  // column is nullable only for rows that predate it.
  //
  // The retry is the deliberate half. A pre-flight SELECT would be a race, and
  // the unique index is the real guarantee anyway, so the collision is handled
  // where it actually surfaces: catch it, mint different values, try again.
  // Bounded, because an unbounded loop turns a genuine schema problem into a
  // hung sign-in. At 30^8 this should never fire once; if it fires five times
  // the randomness is broken and that deserves to be thrown, not papered over.
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
        // Practically unreachable — D1 returns the row or throws — but a missing
        // row here would mean issuing a session for a user that doesn't exist.
        throw new Error('User insert returned no row')
      }

      return { user: created, created: true }
    } catch (error) {
      if (attempt === attempts || !contributors.some((c) => c.isCollision?.(error))) throw error
    }
  }

  // Unreachable — the loop above either returns or rethrows on its last attempt.
  throw new Error('User insert exhausted its mint attempts')
}

/** Look up a user for a notification. Returns null rather than throwing — a
 *  missing row must not fail the webhook that triggered the lookup. */
export async function findUserById(db: Db, id: string): Promise<User | null> {
  const user = await db.query.users.findFirst({ where: eq(tables.users.id, id) })
  return user ?? null
}
