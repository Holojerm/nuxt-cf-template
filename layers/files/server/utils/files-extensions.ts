// What the files layer contributes to core: account deletion sweeps the
// person's uploads (rows and R2 objects), and the nightly purge task collects
// abandoned uploads. Registered by server/plugins/files.ts; tests call
// registerFilesExtensions() directly. See server/utils/extensions.ts.

import { blob } from '@nuxthub/blob'
import { count, eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import { registerAccountContributor, registerPurgeContributor } from '#server/utils/extensions'
import type { PurgeBlobStore } from './files-purge'
import { purgePendingUploads } from './files-purge'
import { logEvent } from '#server/utils/log'

/**
 * `store` is injectable for tests; the running app uses NuxtHub's `blob`,
 * imported explicitly because auto-imports are not injected outside a request.
 */
export function registerFilesExtensions(store: PurgeBlobStore = blob): void {
  registerAccountContributor({
    key: 'files',
    async countForDeletion(db, userId) {
      const [row] = await db
        .select({ total: count() })
        .from(tables.files)
        .where(eq(tables.files.userId, userId))
      return row?.total ?? 0
    },
    // Outside the batch, and before it, because of the R2 half: the objects
    // have to be swept while their rows still name them, and that sweep is
    // best-effort in a way a transaction cannot express.
    async beforeDeletion(db, userId) {
      const rows = await db
        .select({ r2Key: tables.files.r2Key })
        .from(tables.files)
        .where(eq(tables.files.userId, userId))
      if (!rows.length) return
      await db.delete(tables.files).where(eq(tables.files.userId, userId))
      // Best-effort: an R2 outage (or, in tests, no R2 binding at all) must not
      // fail the deletion the person is waiting on. The orphaned objects cost
      // storage, not correctness — the rows that pointed at them, and soon the
      // account itself, are already gone.
      try {
        await store.del(rows.map((row) => row.r2Key))
      } catch (error) {
        logEvent('error', 'account_delete_blob_failed', { userId, error: String(error) })
      }
    },
  })

  registerPurgeContributor({
    key: 'pendingUploads',
    async run(db, options) {
      const result = await purgePendingUploads(db, store, options)
      return { count: result.files, truncated: result.truncated }
    },
  })
}
