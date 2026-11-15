// Sign-up in two steps, email first, because identity here is the VERIFIED
// email address (server/utils/auth.ts): no `users` row, and no password, may
// exist for an address until its owner has opened the mail.
//
// The password is chosen AFTER the link is opened, on the page the link leads
// to. Taking it with the address would let anyone start a sign-up for your
// address with their password and wait for you to click the wrong mail.
//
// The request step does the same work for every address (one row, one mail),
// including one that already has an account, so it is not an oracle. The
// difference is only visible to whoever opens the mail.

import { eq } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '../db/schema'
import { users } from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { attributionSchema } from '#shared/utils/attribution'
import type { Attribution } from '#shared/utils/attribution'
import { consumeCredentialToken, mintCredentialToken } from './credentials-tokens'
import type { CredentialTokenFailure, MintCredentialTokenResult } from './credentials-tokens'

const pendingSchema = z.object({ attribution: attributionSchema.nullable() })

export interface PendingSignUp {
  email: string
  /** First touch as the sign-up form saw it; the link may be opened on another device. */
  attribution: Attribution | null
}

export function startSignUp(
  db: ExtensionDb,
  pending: PendingSignUp,
  now?: number,
): Promise<MintCredentialTokenResult> {
  return mintCredentialToken(db, {
    purpose: 'verify',
    email: pending.email,
    payload: { attribution: pending.attribution },
    now,
  })
}

export type RedeemSignUpResult =
  | { ok: true; pending: PendingSignUp }
  | { ok: false; reason: CredentialTokenFailure | 'already_registered' }

/**
 * Spend a verification token and say whose sign-up it finishes.
 *
 * An address that already signs in with a password is refused: the token proves
 * the mailbox, and replacing a password on that proof is the reset flow's job,
 * with its hook. An account with no password yet (it came from another sign-in
 * method) gains one, since the same mailbox proof is what a magic link accepts.
 */
export async function redeemSignUp(
  db: ExtensionDb,
  token: string,
  now?: number,
): Promise<RedeemSignUpResult> {
  const consumed = await consumeCredentialToken(db, 'verify', token, now)
  if (!consumed.ok) return consumed

  const parsed = pendingSchema.safeParse(consumed.record.payload)
  if (!parsed.success) return { ok: false, reason: 'invalid' }

  const [existing] = await db
    .select({ userId: tables.credentialPasswords.userId })
    .from(tables.credentialPasswords)
    .innerJoin(users, eq(users.id, tables.credentialPasswords.userId))
    .where(eq(users.email, consumed.record.email))
    .limit(1)
  if (existing) return { ok: false, reason: 'already_registered' }

  return { ok: true, pending: { email: consumed.record.email, ...parsed.data } }
}
