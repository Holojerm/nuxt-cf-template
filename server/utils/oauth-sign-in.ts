// Which account an OAuth sign-in lands on. The order is the security property:
//
//   1. (provider, subject) in user_identities → that account. The provider
//      proved who this is; the address it reports this time does not matter,
//      which is what makes Apple's hidden relay addresses work.
//   2. A verified email that matches an account → that account, and the
//      identity is recorded on it so step 1 answers next time.
//   3. A verified email that matches nothing → a new account, identity recorded.
//
// An unverified (or missing) address never reaches 2 or 3. It cannot match an
// account and cannot create one; a person whose provider account is already
// linked still gets in by step 1. Magic link and the credentials layer never
// come here: their identity is the email itself (server/utils/auth.ts).
//
// Takes the Drizzle client explicitly so test/oauth-sign-in.test.ts runs it
// against real D1.

import { eq } from 'drizzle-orm'
import type { Attribution } from '#shared/utils/attribution'
import * as tables from '../db/schema'
import type { ExtensionDb as Db } from './extensions'
import { logEvent } from './log'
import { findIdentityOwner, linkIdentity } from './user-identities'
import { upsertOAuthUser } from './users'
import type { OAuthProfile, SignInResult, UpsertOAuthUserOptions } from './users'

export type SignInRefusalCode = 'no_email' | 'unverified_email'

export type OAuthSignInOutcome =
  | (SignInResult & { matchedBy: 'identity' | 'email' | 'created' })
  | { refused: SignInRefusalCode }

export interface OAuthSignInInput {
  profile: OAuthProfile
  /** Did the provider vouch for the address? Only consulted past step 1. */
  emailVerified: boolean
  attribution?: Attribution | null
  options?: UpsertOAuthUserOptions
}

export async function signInOAuthUser(
  db: Db,
  { profile, emailVerified, attribution, options }: OAuthSignInInput,
): Promise<OAuthSignInOutcome> {
  if (profile.subject) {
    const ownerId = await findIdentityOwner(db, profile.provider, profile.subject)
    if (ownerId) {
      const user = await touchLinkedUser(db, ownerId, profile)
      if (user) return { user, created: false, matchedBy: 'identity' }
    }
  }

  if (!profile.email) return { refused: 'no_email' }
  if (!emailVerified) return { refused: 'unverified_email' }

  const result = await upsertOAuthUser(db, profile, attribution, options)

  if (profile.subject) {
    const link = await linkIdentity(db, result.user.id, {
      provider: profile.provider,
      subject: profile.subject,
      email: profile.email,
    })
    // Only a race reaches this: the lookup above found no owner. The person
    // still proved the address, so the sign-in stands; the identity stays put.
    if (link.outcome === 'taken') {
      logEvent('warn', 'identity_owned_elsewhere', { provider: profile.provider })
    }
  }

  return { ...result, matchedBy: result.created ? 'created' : 'email' }
}

/**
 * A returning sign-in matched by identity. The account's email is left alone:
 * it is the magic-link key, and a relay address must not replace a real one.
 * Name only changes when the provider sent one, because Apple sends it once.
 */
async function touchLinkedUser(db: Db, userId: string, profile: OAuthProfile) {
  const existing = await db.query.users.findFirst({ where: eq(tables.users.id, userId) })
  if (!existing) return null

  const [updated] = await db
    .update(tables.users)
    .set({
      name: profile.name?.trim() || existing.name,
      avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
      lastLoginAt: new Date(),
    })
    .where(eq(tables.users.id, userId))
    .returning()
  return updated ?? existing
}
