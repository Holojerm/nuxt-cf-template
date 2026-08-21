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
 */
export async function upsertOAuthUser(db: Db, profile: OAuthProfile): Promise<SignInResult> {
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

  const [created] = await db
    .insert(tables.users)
    .values({
      email,
      name: displayName(profile, email),
      avatarUrl: profile.avatarUrl ?? null,
      provider: profile.provider,
      lastLoginAt: now,
    })
    .returning()

  if (!created) {
    // Practically unreachable — D1 returns the row or throws — but a missing
    // row here would mean issuing a session for a user that doesn't exist.
    throw new Error('User insert returned no row')
  }

  return { user: created, created: true }
}

/** Look up a user for a notification. Returns null rather than throwing — a
 *  missing row must not fail the webhook that triggered the lookup. */
export async function findUserById(db: Db, id: string): Promise<User | null> {
  const user = await db.query.users.findFirst({ where: eq(tables.users.id, id) })
  return user ?? null
}
