// Mailed single-use tokens: mint, spend, discard.
//
// Same three rules as core's magic link (server/utils/magic-link.ts), for the
// same reasons: only a hash is stored, spending is one atomic UPDATE (a
// read-then-write lets two requests carrying one token both win), and the
// per-mailbox mail budget is counted in D1 in the batch that writes the row.

import { and, count, eq, gt, isNull } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { CredentialToken } from '../db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { base64url, sha256Hex } from '#server/utils/hash'
import { canonicalizeEmailForLimiting, normalizeEmail } from '#server/utils/users'
import { CREDENTIALS_MAIL_BUDGET } from './credentials-limits'

export type CredentialTokenPurpose = 'verify' | 'reset'

/** A sign-up waits on its mail for an hour; a reset link is a live credential, so half that. */
export const CREDENTIAL_TOKEN_TTL_SECONDS: Record<CredentialTokenPurpose, number> = {
  verify: 60 * 60,
  reset: 30 * 60,
}

export type CredentialTokenFailure = 'invalid' | 'expired' | 'used'

export type CredentialTokenResult =
  | { ok: true; record: CredentialToken }
  | { ok: false; reason: CredentialTokenFailure }

export function generateCredentialToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export const hashCredentialToken = (token: string): Promise<string> =>
  sha256Hex(`credentials-token:${token}`)

export interface MintCredentialTokenInput {
  purpose: CredentialTokenPurpose
  email: string
  payload?: Record<string, unknown>
  now?: number
}

export interface MintCredentialTokenResult {
  token: string
  record: CredentialToken
  /** False once this mailbox has used its budget: the row exists, no mail goes out. */
  withinBudget: boolean
}

/**
 * The row is the charge. An over-budget request still writes one (nobody holds
 * the token; it expires with the rest), so D1's serialised batches make N
 * parallel requests for one mailbox come out as exactly `limit` mails.
 */
export async function mintCredentialToken(
  db: ExtensionDb,
  { purpose, email, payload, now = Date.now() }: MintCredentialTokenInput,
): Promise<MintCredentialTokenResult> {
  const token = generateCredentialToken()
  const normalized = normalizeEmail(email)
  const mailbox = canonicalizeEmailForLimiting(normalized)
  const windowStart = new Date(now - CREDENTIALS_MAIL_BUDGET.windowSeconds * 1000)

  const [inserted, counted] = await db.batch([
    db
      .insert(tables.credentialTokens)
      .values({
        purpose,
        email: normalized,
        mailbox,
        tokenHash: await hashCredentialToken(token),
        payload: payload ?? null,
        expiresAt: new Date(now + CREDENTIAL_TOKEN_TTL_SECONDS[purpose] * 1000),
        createdAt: new Date(now),
      })
      .returning(),
    db
      .select({ total: count() })
      .from(tables.credentialTokens)
      .where(
        and(
          eq(tables.credentialTokens.mailbox, mailbox),
          gt(tables.credentialTokens.createdAt, windowStart),
        ),
      ),
  ])
  const record = inserted[0]
  if (!record) throw new Error('credential token insert returned no row')
  return {
    token,
    record,
    withinBudget: (counted[0]?.total ?? 0) <= CREDENTIALS_MAIL_BUDGET.limit,
  }
}

/** Spend a token. One statement, so exactly one of two racing requests gets the row. */
export async function consumeCredentialToken(
  db: ExtensionDb,
  purpose: CredentialTokenPurpose,
  token: string,
  now: number = Date.now(),
): Promise<CredentialTokenResult> {
  const tokenHash = await hashCredentialToken(token)
  const [record] = await db
    .update(tables.credentialTokens)
    .set({ usedAt: new Date(now) })
    .where(
      and(
        eq(tables.credentialTokens.tokenHash, tokenHash),
        eq(tables.credentialTokens.purpose, purpose),
        isNull(tables.credentialTokens.usedAt),
        gt(tables.credentialTokens.expiresAt, new Date(now)),
      ),
    )
    .returning()
  if (record) return { ok: true, record }

  // Only to say why. Nothing is decided on this read.
  const existing = await db.query.credentialTokens.findFirst({
    where: and(
      eq(tables.credentialTokens.tokenHash, tokenHash),
      eq(tables.credentialTokens.purpose, purpose),
    ),
    columns: { usedAt: true },
  })
  if (!existing) return { ok: false, reason: 'invalid' }
  return { ok: false, reason: existing.usedAt ? 'used' : 'expired' }
}

/** Remove a token whose mail could not be sent, so it cannot be spent by whoever finds it. */
export async function discardCredentialToken(db: ExtensionDb, id: string): Promise<void> {
  await db.delete(tables.credentialTokens).where(eq(tables.credentialTokens.id, id))
}
