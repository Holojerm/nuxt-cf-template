// What the credentials layer contributes to core: account deletion and export,
// and the nightly sweep of spent tokens and stale challenges.

import { and, count, eq, inArray, isNotNull, lt, or } from 'drizzle-orm'

import * as tables from '../db/schema'
import { users } from '#server/db/schema'
import { registerAccountContributor, registerPurgeContributor } from '#server/utils/extensions'
import type { ExtensionDb } from '#server/utils/extensions'
import type { PurgeOptions } from '#server/utils/purge'
import { PURGE_BATCH_LIMIT, PURGE_GRACE_SECONDS } from '#server/utils/purge'
import { listPasskeys, passkeySummary, purgePasskeyChallenges } from './credentials-passkeys'
import type { PasskeySummary } from './credentials-passkeys'

export interface AccountExportCredentials {
  hasPassword: boolean
  passkeys: PasskeySummary[]
}

declare module '#server/utils/extensions' {
  interface AccountExportSections {
    credentials: AccountExportCredentials
  }
}

/** Expired or spent tokens past the grace window, and every expired challenge. */
export async function purgeCredentialTokens(
  db: ExtensionDb,
  {
    now = Date.now(),
    graceSeconds = PURGE_GRACE_SECONDS,
    limit = PURGE_BATCH_LIMIT,
  }: PurgeOptions = {},
): Promise<{ count: number; truncated: boolean }> {
  const cutoff = new Date(now - graceSeconds * 1000)
  // A subselect, not `DELETE … LIMIT`: D1 does not promise the latter.
  const dead = db
    .select({ id: tables.credentialTokens.id })
    .from(tables.credentialTokens)
    .where(
      or(
        lt(tables.credentialTokens.expiresAt, cutoff),
        and(isNotNull(tables.credentialTokens.usedAt), lt(tables.credentialTokens.usedAt, cutoff)),
      ),
    )
    .limit(limit)
  const removed = await db
    .delete(tables.credentialTokens)
    .where(inArray(tables.credentialTokens.id, dead))
    .returning({ id: tables.credentialTokens.id })
  const challenges = await purgePasskeyChallenges(db, now)
  return { count: removed.length + challenges, truncated: removed.length >= limit }
}

export function registerCredentialsExtensions(): void {
  registerAccountContributor({
    key: 'credentials',
    async countForDeletion(db, userId) {
      const [row] = await db
        .select({ total: count() })
        .from(tables.credentialPasskeys)
        .where(eq(tables.credentialPasskeys.userId, userId))
      return row?.total ?? 0
    },
    countKey: 'passkeysCount',
    // Tokens are keyed by address, and the deletion batch rewrites the address,
    // so they go first, while the row still says whose they are.
    async beforeDeletion(db, userId) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { email: true },
      })
      if (!user) return
      await db.delete(tables.credentialTokens).where(eq(tables.credentialTokens.email, user.email))
    },
    deletionStatements: (db, userId) => [
      db.delete(tables.credentialPasswords).where(eq(tables.credentialPasswords.userId, userId)),
      db.delete(tables.credentialPasskeys).where(eq(tables.credentialPasskeys.userId, userId)),
    ],
    async exportSection(db, userId) {
      const [password, passkeys] = await Promise.all([
        db.query.credentialPasswords.findFirst({
          where: eq(tables.credentialPasswords.userId, userId),
          columns: { userId: true },
        }),
        listPasskeys(db, userId),
      ])
      return { hasPassword: Boolean(password), passkeys: passkeys.map(passkeySummary) }
    },
  })

  registerPurgeContributor({
    key: 'credentialTokens',
    run: (db, options) => purgeCredentialTokens(db, options),
  })
}
