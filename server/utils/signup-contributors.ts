// What a feature adds to the moment an account is created: facts resolved from
// the first-touch claims, columns minted for the new row, and work that follows
// a brand-new sign-in. The referral loop is the shipped user (a referral code
// per account, `referred_by` resolved from the visitor's cookie, the welcome
// days after sign-in); upsertOAuthUser() and establishSession() ask the
// registry and never import it.
//
// Plain registry, like every seam in extensions.ts: a feature registers from a
// Nitro plugin, tests call the same function. With nothing registered a new
// account is a `users` row with only the columns the template itself sets.
//
// ── Order of operations on the INSERT branch (unchanged from before the seam) ─
// 1. `resolve` for every contributor, once, before the insert: a claim from a
//    cookie becomes a fact here or it is dropped.
// 2. Up to `max(mintAttempts)` insert attempts. Each calls every `mint()` for
//    fresh column values. A failure that some contributor's `isCollision` claims
//    is retried with new values; anything else, and the last attempt, throws.
// 3. After the session is sealed, `afterSignUp` runs inside afterSignIn() so a
//    throw can never fail a sign-in whose cookie is already issued.

import type { H3Event } from 'h3'
import type { Attribution } from '#shared/utils/attribution'
import type { NewUser, User } from '../db/schema'
import type { ExtensionDb } from './extensions'

export interface SignupContributor {
  key: string
  /**
   * Columns resolved once from the first-touch claims, before the insert. May
   * read; never writes. `attribution` is null/undefined for a sign-in with none.
   */
  resolve?: (
    db: ExtensionDb,
    input: { email: string; attribution: Attribution | null | undefined },
  ) => Promise<Partial<NewUser>>
  /** Columns minted fresh for each insert attempt (a code behind a unique index). */
  mint?: () => Partial<NewUser>
  /** True when an insert error is a collision on a column this contributor minted. */
  isCollision?: (error: unknown) => boolean
  /** Insert attempts this contributor needs (default 1: no retry). */
  mintAttempts?: number
  /**
   * Work after a brand-new account's session is sealed. Logged, never rethrown,
   * under `afterSignUpLabel` (default: the key).
   */
  afterSignUp?: (context: { db: ExtensionDb; event: H3Event; user: User }) => Promise<void>
  afterSignUpLabel?: string
}

// Keyed, so a plugin and a test (or a dev reload) registering twice replace.
const contributors = new Map<string, SignupContributor>()

export function registerSignupContributor(contributor: SignupContributor): void {
  contributors.set(contributor.key, contributor)
}

export function getSignupContributors(): SignupContributor[] {
  return [...contributors.values()]
}

/** Test-only: forget every contributor, to exercise core with no features. */
export function clearSignupContributorsForTest(): void {
  contributors.clear()
}
