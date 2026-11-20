// Passkey storage behind nuxt-auth-utils' WebAuthn handlers: the challenge of
// each ceremony, and the credentials an account has registered.

import { and, desc, eq, exists, gt, lt, ne, or } from 'drizzle-orm'
import { createError } from 'nuxt/server'
import type { NuxtError, RequestEvent } from 'nuxt/server'

import * as tables from '../db/schema'
import type { CredentialPasskey } from '../db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { logEvent } from '#server/utils/log'

/** Long enough to find a security key, short enough that a leaked challenge is useless. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60

/** A ceiling, so a hijacked session cannot grow the table without bound. */
export const MAX_PASSKEYS_PER_USER = 20

export async function storePasskeyChallenge(
  db: ExtensionDb,
  attemptId: string,
  challenge: string,
  now: number = Date.now(),
): Promise<void> {
  await db.insert(tables.credentialChallenges).values({
    attemptId,
    challenge,
    expiresAt: new Date(now + PASSKEY_CHALLENGE_TTL_SECONDS * 1000),
  })
}

/**
 * Read a challenge by deleting it. One statement, so a response can be checked
 * against a challenge once: a replayed assertion finds nothing to verify against.
 */
export async function takePasskeyChallenge(
  db: ExtensionDb,
  attemptId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const [row] = await db
    .delete(tables.credentialChallenges)
    .where(
      and(
        eq(tables.credentialChallenges.attemptId, attemptId),
        gt(tables.credentialChallenges.expiresAt, new Date(now)),
      ),
    )
    .returning({ challenge: tables.credentialChallenges.challenge })
  return row?.challenge ?? null
}

export async function purgePasskeyChallenges(
  db: ExtensionDb,
  now: number = Date.now(),
): Promise<number> {
  const rows = await db
    .delete(tables.credentialChallenges)
    .where(lt(tables.credentialChallenges.expiresAt, new Date(now)))
    .returning({ attemptId: tables.credentialChallenges.attemptId })
  return rows.length
}

/** What a verified registration yields (nuxt-auth-utils' `WebAuthnCredential`). */
export interface VerifiedPasskey {
  id: string
  publicKey: string
  counter: number
  backedUp: boolean
  transports?: string[]
  aaguid?: string
}

export type SavePasskeyResult = 'saved' | 'limit_reached'

export async function savePasskey(
  db: ExtensionDb,
  userId: string,
  credential: VerifiedPasskey,
  options: { name: string; prfCapable: boolean },
): Promise<SavePasskeyResult> {
  const existing = await db
    .select({ id: tables.credentialPasskeys.id })
    .from(tables.credentialPasskeys)
    .where(eq(tables.credentialPasskeys.userId, userId))
  if (existing.length >= MAX_PASSKEYS_PER_USER) return 'limit_reached'

  await db.insert(tables.credentialPasskeys).values({
    id: credential.id,
    userId,
    publicKey: credential.publicKey,
    counter: credential.counter,
    backedUp: credential.backedUp,
    transports: credential.transports ?? null,
    aaguid: credential.aaguid ?? null,
    name: options.name,
    prfCapable: options.prfCapable,
  })
  return 'saved'
}

export async function findPasskey(db: ExtensionDb, id: string): Promise<CredentialPasskey | null> {
  const row = await db.query.credentialPasskeys.findFirst({
    where: eq(tables.credentialPasskeys.id, id),
  })
  return row ?? null
}

export function listPasskeys(db: ExtensionDb, userId: string): Promise<CredentialPasskey[]> {
  return db.query.credentialPasskeys.findMany({
    where: eq(tables.credentialPasskeys.userId, userId),
    orderBy: desc(tables.credentialPasskeys.createdAt),
  })
}

/** Record a use. The counter is what lets a cloned authenticator be noticed. */
export async function touchPasskey(
  db: ExtensionDb,
  id: string,
  counter: number,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(tables.credentialPasskeys)
    .set({ counter, lastUsedAt: new Date(now) })
    .where(eq(tables.credentialPasskeys.id, id))
}

export type RemovePasskeyResult = 'removed' | 'not_found' | 'last_way_in'

/**
 * Scoped to the owner in the statement itself, so an id from another account
 * removes nothing. With `keepOne` (this layer is the only sign-in, so an
 * account with no password signs in by passkey alone) the last passkey of an
 * account without a password stays: removing it would leave no way in. The
 * condition is in the same statement, so two removals at once cannot both pass it.
 */
export async function removePasskey(
  db: ExtensionDb,
  userId: string,
  id: string,
  { keepOne = false }: { keepOne?: boolean } = {},
): Promise<RemovePasskeyResult> {
  const { credentialPasskeys: passkeys, credentialPasswords: passwords } = tables
  const mine = and(eq(passkeys.id, id), eq(passkeys.userId, userId))
  const anotherWayIn = or(
    exists(
      db.select({ userId: passwords.userId }).from(passwords).where(eq(passwords.userId, userId)),
    ),
    exists(
      db
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(and(eq(passkeys.userId, userId), ne(passkeys.id, id))),
    ),
  )
  const rows = await db
    .delete(passkeys)
    .where(keepOne ? and(mine, anotherWayIn) : mine)
    .returning({ id: passkeys.id })
  if (rows.length > 0) return 'removed'
  const [kept] = await db.select({ id: passkeys.id }).from(passkeys).where(mine)
  return kept ? 'last_way_in' : 'not_found'
}

/** The shape the settings page lists. No public key: nothing on that page needs it. */
export function passkeySummary(row: CredentialPasskey) {
  return {
    id: row.id,
    name: row.name,
    backedUp: row.backedUp,
    prfCapable: row.prfCapable,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }
}

export type PasskeySummary = ReturnType<typeof passkeySummary>

/**
 * Where nuxt-auth-utils' handlers send every failed ceremony. This layer's own
 * refusals (4xx, with a code) pass through. Anything else is a response that
 * did not verify, which the handler reports as a 500; it is answered as a 400,
 * so a forged assertion cannot fill the ops spool that alerts are raised from.
 *
 * The handlers keep a thrown error's status only when it has a `status` field,
 * which h3 v1's `createError` does not set, so every refusal thrown inside a
 * WebAuthn callback uses `createError` from `nuxt/server`.
 */
export function passkeyCeremonyFailed(_event: RequestEvent, error: NuxtError): never {
  if ((error.status ?? 500) < 500) throw error
  logEvent('warn', 'credentials_passkey_rejected', { message: error.message })
  throw createError({
    status: 400,
    message: 'That passkey could not be verified',
    data: { code: 'passkey_rejected' },
  })
}
