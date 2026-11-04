// The files layer's nightly sweep of abandoned uploads, run by core's
// purge-expired-tokens task through a PurgeContributor (files-extensions.ts).
//
// `files` rows are written BEFORE the object exists, because the client uploads
// to R2 directly — so `status = 'pending'` is the honest default and a row that
// never reaches `uploaded` is an upload someone started and abandoned. Unlike
// core's token sweeps this one also has an object to remove, and the two
// deletes cannot be made atomic — see the ordering note below.

import { and, eq, inArray, lt } from 'drizzle-orm'
import * as tables from '../db/schema'
import { PURGE_BATCH_LIMIT, PURGE_GRACE_SECONDS } from '#server/utils/purge'
import type { PurgeDb, PurgeOptions } from '#server/utils/purge'
import { logEvent } from '#server/utils/log'

/** The slice of NuxtHub's blob handle this needs — lets tests pass a fake. */
export interface PurgeBlobStore {
  del(keys: string[]): Promise<unknown>
}

export interface PurgeUploadsResult {
  /** Rows removed from `files`. */
  files: number
  /** True when a full batch came back, so more remain for the next run. */
  truncated: boolean
}

/**
 * Collect uploads that were started and never finished.
 *
 * A `files` row is written before its R2 object exists — the client uploads
 * directly — so `pending` is the honest initial state and a row still pending
 * a day later is abandoned. Nothing deleted these, so they accumulated as
 * unreachable rows pointing at objects nobody could list, download, or stop
 * paying for.
 *
 * ── Why the object goes first ────────────────────────────────────────────────
 * There is no transaction spanning D1 and R2, so one of the two orderings has
 * to lose. Deleting the row first can orphan the object permanently: the only
 * record of its key is gone, and nothing will ever look for it again. Deleting
 * the object first can at worst leave a row whose object is already absent —
 * which the next run retries, and which `blob.del` tolerates anyway. One
 * failure mode is a silent recurring cost; the other is a retry.
 *
 * ── Why a failed delete does not abort the run ───────────────────────────────
 * Same policy as deleteAccount(): an R2 outage must not stop the sweep. The
 * rows stay, the next run tries again, and the failure is logged rather than
 * thrown — this is a cron task, and throwing would just retry the whole batch
 * on Cloudflare's schedule with the same broken R2.
 *
 * `blob` is a parameter rather than the NuxtHub auto-import for the same reason
 * `db` is: the workerd test suite loads this file directly, where nothing is
 * injected.
 */
export async function purgePendingUploads(
  db: PurgeDb,
  blob: PurgeBlobStore,
  {
    now = Date.now(),
    graceSeconds = PURGE_GRACE_SECONDS,
    limit = PURGE_BATCH_LIMIT,
  }: PurgeOptions = {},
): Promise<PurgeUploadsResult> {
  const cutoff = new Date(now - graceSeconds * 1000)

  const abandoned = await db
    .select({ id: tables.files.id, r2Key: tables.files.r2Key })
    .from(tables.files)
    .where(and(eq(tables.files.status, 'pending'), lt(tables.files.createdAt, cutoff)))
    .limit(limit)

  if (abandoned.length === 0) return { files: 0, truncated: false }

  try {
    await blob.del(abandoned.map((file) => file.r2Key))
  } catch (error) {
    // Best-effort, and deliberately not fatal — see the docblock. Keys are not
    // logged: an r2_key is derived per user and naming them in bulk turns a log
    // line into an inventory of someone's uploads.
    logEvent('error', 'purge_uploads_blob_failed', {
      count: abandoned.length,
      error: String(error),
    })
    return { files: 0, truncated: false }
  }

  const deleted = await db
    .delete(tables.files)
    .where(
      inArray(
        tables.files.id,
        abandoned.map((file) => file.id),
      ),
    )
    .returning({ id: tables.files.id })

  return { files: deleted.length, truncated: abandoned.length >= limit }
}
