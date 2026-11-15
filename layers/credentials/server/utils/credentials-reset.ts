// Password reset by email, and password change by someone signed in.
//
// A reset proves the mailbox and nothing else, so it is where an app that
// encrypts under the unlock key must act: `onCredentialsPasswordReset`
// (credentials-hooks.ts) runs in the batch that writes the new password.

import { eq } from 'drizzle-orm'

import { users } from '#server/db/schema'
import type { User } from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { isUndeliverableAddress, normalizeEmail } from '#server/utils/users'
import type { CredentialsNewPassword } from '../../shared/utils/credentials-schemas'
import { hashNewPassword, replacePassword, verifyProofForUser } from './credentials-password'
import type { ProofHasher } from './credentials-password'
import { consumeCredentialToken, mintCredentialToken } from './credentials-tokens'
import type { CredentialTokenFailure, MintCredentialTokenResult } from './credentials-tokens'

export interface ResetRequest extends MintCredentialTokenResult {
  /** Mail the link? False for an unknown or deleted address, or a spent budget. */
  deliver: boolean
}

/**
 * A row is written for every address, known or not, so the request costs the
 * same either way; a token minted for an address with no account is mailed to
 * nobody and cannot be spent (completePasswordReset finds no user).
 */
export async function requestPasswordReset(
  db: ExtensionDb,
  email: string,
  now?: number,
): Promise<ResetRequest> {
  const normalized = normalizeEmail(email)
  const [minted, user] = await Promise.all([
    mintCredentialToken(db, { purpose: 'reset', email: normalized, now }),
    db.query.users.findFirst({ where: eq(users.email, normalized), columns: { id: true } }),
  ])
  const deliver = Boolean(user) && !isUndeliverableAddress(normalized) && minted.withinBudget
  return { ...minted, deliver }
}

export type CompleteResetResult =
  | { ok: true; user: User; at: Date }
  | { ok: false; reason: CredentialTokenFailure }

/**
 * Spend a reset token and set the new password. Every session issued before
 * `at` dies with the old password; the caller issues the new one.
 *
 * The proof is hashed before the token is spent: a hashing failure must not
 * cost the person their only link.
 */
export async function completePasswordReset(
  db: ExtensionDb,
  hasher: ProofHasher,
  token: string,
  password: CredentialsNewPassword,
  now: number = Date.now(),
): Promise<CompleteResetResult> {
  const stored = await hashNewPassword(hasher, password)
  const consumed = await consumeCredentialToken(db, 'reset', token, now)
  if (!consumed.ok) return consumed

  const user = await db.query.users.findFirst({ where: eq(users.email, consumed.record.email) })
  if (!user) return { ok: false, reason: 'invalid' }

  const at = new Date(now)
  await replacePassword(db, 'reset', user.id, stored, at)
  return { ok: true, user, at }
}

export type ChangePasswordResult =
  | { ok: true; at: Date }
  | { ok: false; reason: 'wrong_password' | 'no_password' }

/** Change a password. The current one is required: a borrowed session is not enough. */
export async function changePassword(
  db: ExtensionDb,
  hasher: ProofHasher,
  userId: string,
  currentProof: string,
  password: CredentialsNewPassword,
  now: number = Date.now(),
): Promise<ChangePasswordResult> {
  const verdict = await verifyProofForUser(db, hasher, userId, currentProof)
  if (verdict !== 'ok') {
    return { ok: false, reason: verdict === 'wrong' ? 'wrong_password' : 'no_password' }
  }
  const at = new Date(now)
  await replacePassword(db, 'change', userId, await hashNewPassword(hasher, password), at)
  return { ok: true, at }
}
