// The server's half of password sign-in: store a slow hash of the browser's
// sign-in proof, check a proof against it, and replace it.
//
// The hasher is passed in. In a route it is nuxt-auth-utils' scrypt
// (credentials-hasher.ts); the tests supply their own, because that module
// reads Nuxt runtime config, which the workerd pool does not have.

import { eq } from 'drizzle-orm'

import * as tables from '../db/schema'
import { users } from '#server/db/schema'
import type { User } from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { writeAudit } from '#server/utils/audit'
import { logEvent } from '#server/utils/log'
import { isUndeliverableAddress, normalizeEmail } from '#server/utils/users'
import { CREDENTIALS_KDF_VERSION } from '../../shared/utils/credentials-kdf'
import type { CredentialsNewPassword } from '../../shared/utils/credentials-schemas'
import { getCredentialsPasswordHandlers } from './credentials-hooks'
import type { CredentialsPasswordEvent } from './credentials-hooks'

export interface ProofHasher {
  hash: (proof: string) => Promise<string>
  verify: (hash: string, proof: string) => Promise<boolean>
}

/** What a `credential_passwords` row is written from: the hash, never the proof. */
export interface StoredPassword {
  proofHash: string
  salt: string
  iterations: number
}

export async function hashNewPassword(
  hasher: ProofHasher,
  input: CredentialsNewPassword,
): Promise<StoredPassword> {
  return {
    proofHash: await hasher.hash(input.proof),
    salt: input.salt,
    iterations: input.iterations,
  }
}

/**
 * Give an account that has none its first password. False when it has one:
 * replacing a password is `replacePassword`'s job, which needs the old one or a
 * mailed token.
 */
export async function setFirstPassword(
  db: ExtensionDb,
  userId: string,
  stored: StoredPassword,
): Promise<boolean> {
  const rows = await db
    .insert(tables.credentialPasswords)
    .values({ userId, ...stored, kdfVersion: CREDENTIALS_KDF_VERSION })
    .onConflictDoNothing()
    .returning({ userId: tables.credentialPasswords.userId })
  return rows.length > 0
}

/** Insert or replace the account's password row. */
export function passwordUpsert(db: ExtensionDb, userId: string, stored: StoredPassword) {
  const values = { ...stored, kdfVersion: CREDENTIALS_KDF_VERSION }
  return db
    .insert(tables.credentialPasswords)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: tables.credentialPasswords.userId,
      set: { ...values, updatedAt: new Date() },
    })
}

/**
 * A hash to compare against when the address has no password, so the request
 * costs one scrypt verification whether or not the account exists. Per isolate.
 */
let decoyHash: Promise<string> | null = null
const decoyFor = (hasher: ProofHasher): Promise<string> =>
  (decoyHash ??= hasher.hash('credentials-decoy-proof'))

export function resetDecoyHashForTest(): void {
  decoyHash = null
}

/**
 * Does this proof open this address's account? Null for every failure, with no
 * reason: the caller answers "wrong email or password" and nothing finer.
 */
export async function verifySignInProof(
  db: ExtensionDb,
  hasher: ProofHasher,
  email: string,
  proof: string,
): Promise<User | null> {
  const normalized = normalizeEmail(email)
  const [row] = await db
    .select({ user: users, proofHash: tables.credentialPasswords.proofHash })
    .from(tables.credentialPasswords)
    .innerJoin(users, eq(users.id, tables.credentialPasswords.userId))
    .where(eq(users.email, normalized))
    .limit(1)

  const matches = await hasher.verify(row?.proofHash ?? (await decoyFor(hasher)), proof)
  if (!row || !matches) return null
  // A tombstone keeps its row; it must never sign in.
  return isUndeliverableAddress(row.user.email) ? null : row.user
}

/** The same check for someone already signed in (password change, unlock). */
export async function verifyProofForUser(
  db: ExtensionDb,
  hasher: ProofHasher,
  userId: string,
  proof: string,
): Promise<'ok' | 'wrong' | 'no_password'> {
  const row = await db.query.credentialPasswords.findFirst({
    where: eq(tables.credentialPasswords.userId, userId),
    columns: { proofHash: true },
  })
  if (!row) return 'no_password'
  return (await hasher.verify(row.proofHash, proof)) ? 'ok' : 'wrong'
}

/**
 * Replace a password and end every session issued before `at`, with whatever
 * the app registered for this kind of replacement, in one D1 batch.
 *
 * The caller re-issues its own cookie from the same clock reading: the
 * watermark is stored in seconds and the guard is a strict less-than
 * (server/utils/session-guard.ts), so that one session survives.
 */
export async function replacePassword(
  db: ExtensionDb,
  kind: 'reset' | 'change',
  userId: string,
  stored: StoredPassword,
  at: Date = new Date(),
): Promise<void> {
  const event: CredentialsPasswordEvent = { userId, at }
  const handlers = getCredentialsPasswordHandlers(kind)
  await db.batch([
    passwordUpsert(db, userId, stored),
    db.update(users).set({ sessionsInvalidBefore: at }).where(eq(users.id, userId)),
    ...handlers.flatMap((handler) => handler.statements?.(db, event) ?? []),
  ])
  // The same row "sign out everywhere" writes: this did the same thing.
  await writeAudit(db, {
    actorUserId: userId,
    actorType: 'user',
    action: 'account.sessions_revoked',
    targetType: 'user',
    targetId: userId,
    metadata: { sessionsInvalidBefore: at.toISOString(), cause: `password_${kind}` },
  })
  for (const handler of handlers) {
    try {
      await handler.after?.(db, event)
    } catch (error) {
      logEvent('error', 'credentials_password_hook_failed', {
        kind,
        key: handler.key,
        error: String(error),
      })
    }
  }
}
