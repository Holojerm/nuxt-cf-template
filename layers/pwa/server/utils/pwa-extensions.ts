// What the pwa layer contributes to core: account deletion removes the
// person's push subscriptions and idempotency keys, the data export lists the
// subscriptions, and the purge task sweeps old keys. Registered by
// server/plugins/pwa.ts; tests call registerPwaExtensions() directly.

import { count, eq } from 'drizzle-orm'

import * as tables from '../db/schema'
import { registerAccountContributor, registerPurgeContributor } from '#server/utils/extensions'
import { purgeIdempotencyKeys } from './idempotency-keys'
import { listPushSubscriptions } from './push-subscriptions'

export interface AccountExportPushSubscription {
  /** The push service's host, which says which browser family it is. */
  service: string
  createdAt: string
  lastSuccessAt: string | null
}

declare module '#server/utils/extensions' {
  interface AccountExportSections {
    pushSubscriptions: AccountExportPushSubscription[]
  }
}

export function registerPwaExtensions(): void {
  registerAccountContributor({
    key: 'pushSubscriptions',
    async countForDeletion(db, userId) {
      const [row] = await db
        .select({ total: count() })
        .from(tables.pushSubscriptions)
        .where(eq(tables.pushSubscriptions.userId, userId))
      return row?.total ?? 0
    },
    deletionStatements: (db, userId) => [
      db.delete(tables.pushSubscriptions).where(eq(tables.pushSubscriptions.userId, userId)),
    ],
    // The endpoint and keys stay out: together they are what lets a sender
    // reach the browser, and a data export gets mailed around.
    async exportSection(db, userId) {
      const rows = await listPushSubscriptions(db, userId)
      return rows.map((row) => ({
        service: new URL(row.endpoint).hostname,
        createdAt: row.createdAt.toISOString(),
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      }))
    },
  })
  // Not in the export: a key is the client's own random id, and the answer
  // stored under it repeats something the app's own section already lists.
  registerAccountContributor({
    key: 'idempotencyKeys',
    async countForDeletion(db, userId) {
      const [row] = await db
        .select({ total: count() })
        .from(tables.idempotencyKeys)
        .where(eq(tables.idempotencyKeys.userId, userId))
      return row?.total ?? 0
    },
    deletionStatements: (db, userId) => [
      db.delete(tables.idempotencyKeys).where(eq(tables.idempotencyKeys.userId, userId)),
    ],
  })

  registerPurgeContributor({
    key: 'idempotencyKeys',
    run: (db, options) => purgeIdempotencyKeys(db, options),
  })
}
