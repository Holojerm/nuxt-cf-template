// Provider accounts attached to a user: the `user_identities` table.
//
// An OAuth sign-in is matched on (provider, subject) before the verified email
// (server/utils/users.ts › signInOAuthUser), which is what lets an Apple account
// behind a hidden relay address reach an account created with Google. A row is
// written in exactly three places, each of which has already proven the person
// owns the account it names:
//
//   - first sign-in creates the account     (the provider proved the subject)
//   - sign-in matched by verified email     (the provider proved the address)
//   - an explicit link from /account        (the session proved the user)
//
// Nothing ever moves a row to another user. The unique index on
// (provider, subject) is the guard: a second owner is refused, not merged.
//
// Takes the Drizzle client explicitly so the workerd tests can drive it.

import { and, asc, eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import type { ExtensionDb as Db } from './extensions'

/** A provider account, as the OAuth callback reports it. */
export interface IdentityRef {
  provider: string
  /** The provider's stable id for the person. Never an address. */
  subject: string
  /** What the provider reported this time. Display only, never a match key. */
  email?: string | null
}

export type LinkOutcome =
  | { outcome: 'linked' }
  | { outcome: 'already_linked' }
  /** The identity signs in to a different account. Nothing was changed. */
  | { outcome: 'taken' }

/** The user id this provider account signs in to, or null. */
export async function findIdentityOwner(
  db: Db,
  provider: string,
  subject: string,
): Promise<string | null> {
  const row = await db.query.userIdentities.findFirst({
    where: and(
      eq(tables.userIdentities.provider, provider),
      eq(tables.userIdentities.subject, subject),
    ),
    columns: { userId: true },
  })
  return row?.userId ?? null
}

/**
 * Attach an identity to `userId` unless somebody already holds it.
 *
 * `ON CONFLICT DO NOTHING` then a read, rather than read-then-insert: two
 * callbacks for one provider account can race, and the unique index lets exactly
 * one win. The read-back says who did.
 */
export async function linkIdentity(db: Db, userId: string, ref: IdentityRef): Promise<LinkOutcome> {
  // An empty subject would be one identity shared by everyone missing one.
  if (!ref.subject || !ref.provider) throw new Error('identity needs a provider and a subject')
  const inserted = await db
    .insert(tables.userIdentities)
    .values({
      userId,
      provider: ref.provider,
      subject: ref.subject,
      email: ref.email || null,
    })
    .onConflictDoNothing({
      target: [tables.userIdentities.provider, tables.userIdentities.subject],
    })
    .returning({ id: tables.userIdentities.id })
  if (inserted.length > 0) return { outcome: 'linked' }

  const owner = await findIdentityOwner(db, ref.provider, ref.subject)
  return owner === userId ? { outcome: 'already_linked' } : { outcome: 'taken' }
}

export interface LinkedIdentity {
  provider: string
  email: string | null
  linkedAt: Date
}

/** What /account shows. The subject is left out: it means nothing to a person. */
export async function listIdentities(db: Db, userId: string): Promise<LinkedIdentity[]> {
  const rows = await db.query.userIdentities.findMany({
    where: eq(tables.userIdentities.userId, userId),
    orderBy: asc(tables.userIdentities.createdAt),
    columns: { provider: true, email: true, createdAt: true },
  })
  return rows.map((row) => ({ provider: row.provider, email: row.email, linkedAt: row.createdAt }))
}
