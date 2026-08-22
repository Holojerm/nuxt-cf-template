// Retention for the two single-use credential tables.
//
// `mcp_connect_codes` and `magic_link_tokens` are both mint-once, spend-once,
// expire-in-minutes rows. Nothing in the request path ever deletes them: a
// redemption stamps `used_at` and leaves the row, and an unredeemed row just
// sits past its `expires_at` forever. So both tables grow monotonically with
// sign-ins, and on a busy fork the magic-link table is the single fastest
// growing thing in the database while holding nothing of value.
//
// ── Why a grace window instead of deleting the moment a row is dead ─────────
// The row outlives its usefulness as a credential well before it outlives its
// usefulness as a *record*. Two concrete uses, both within a day:
//
//   * A spent token is the only evidence a link was replayed. Delete it at
//     redemption and a second click on the same link is indistinguishable from
//     a forged token — same "unknown token" branch, no way to tell a user who
//     double-clicked from an attacker holding a stolen link.
//   * An expired token is what lets the verify page say "this link expired"
//     rather than "this link is invalid". Those are different instructions to
//     the person reading them.
//
// 24 hours covers both and is still short enough that the tables stay small.
//
// ── Why the delete is bounded ────────────────────────────────────────────────
// The first run on a fork that has been live for a year has to delete a year
// of rows, and a Worker has a wall-clock and subrequest budget. An unbounded
// `DELETE ... WHERE expires_at < ?` that exceeds it fails, gets retried on the
// next tick, and fails again — a purge that never once succeeds, which is the
// worst possible shape for a cleanup job because nothing looks broken.
//
// So each table deletes at most PURGE_BATCH_LIMIT rows per run and reports how
// many it took. The cron just runs again; a backlog drains over a few days
// instead of never. `deleted === limit` in the log line is the signal that a
// backlog exists.

import { and, inArray, isNotNull, lt, or } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'

/** Same shape as SessionGuardDb — the Drizzle client, passed in explicitly. */
export type PurgeDb = ReturnType<typeof drizzle<typeof tables>>

/** How long a dead row is kept for the two reasons in the file header. */
export const PURGE_GRACE_SECONDS = 24 * 60 * 60

/**
 * Rows deleted per table per run. 5000 is far above any realistic day's churn
 * for either table, so a healthy fork always clears its whole backlog in one
 * tick and only a first run after a long gap ever hits the cap.
 */
export const PURGE_BATCH_LIMIT = 5000

export interface PurgeOptions {
  /** Unix milliseconds. Injected so tests don't depend on the wall clock. */
  now?: number
  graceSeconds?: number
  limit?: number
}

export interface PurgeCounts {
  mcpConnectCodes: number
  magicLinkTokens: number
}

export interface PurgeResult extends PurgeCounts {
  /** Everything older than this was eligible. Unix milliseconds. */
  cutoff: number
  /**
   * True when either table deleted a full batch, meaning more rows remain and
   * the next run has work to do. The one field worth alerting on.
   */
  truncated: boolean
}

/**
 * Delete spent and expired rows from both credential tables.
 *
 * A row is eligible when it went dead — expired, or was redeemed — more than
 * `graceSeconds` ago. Both conditions are checked because they are genuinely
 * independent: a token redeemed one minute after minting is dead long before
 * `expires_at`, and an abandoned one passes `expires_at` while `used_at` stays
 * null forever.
 *
 * Takes the Drizzle client explicitly, like the rest of server/utils, so
 * test/purge.test.ts can drive it against a real D1 inside workerd — the task
 * wrapper in server/tasks/ has nothing in it worth testing.
 */
export async function purgeExpiredTokens(
  db: PurgeDb,
  { now = Date.now(), graceSeconds = PURGE_GRACE_SECONDS, limit = PURGE_BATCH_LIMIT }: PurgeOptions =
    {},
): Promise<PurgeResult> {
  // Drizzle maps these columns with `mode: 'timestamp'`, so comparisons take a
  // Date and it handles the seconds conversion D1 stores.
  const cutoff = new Date(now - graceSeconds * 1000)

  // Bounded by a subselect rather than `DELETE ... LIMIT`, which SQLite only
  // supports when compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT — not a
  // guarantee D1 makes. `.returning({ id })` gives an exact count instead of
  // D1's driver-shaped `meta.changes`, and only pulls back the one column.
  const deadConnectCodes = db
    .select({ id: tables.mcpConnectCodes.id })
    .from(tables.mcpConnectCodes)
    .where(
      or(
        lt(tables.mcpConnectCodes.expiresAt, cutoff),
        and(
          isNotNull(tables.mcpConnectCodes.usedAt),
          lt(tables.mcpConnectCodes.usedAt, cutoff),
        ),
      ),
    )
    .limit(limit)

  const connectCodes = await db
    .delete(tables.mcpConnectCodes)
    .where(inArray(tables.mcpConnectCodes.id, deadConnectCodes))
    .returning({ id: tables.mcpConnectCodes.id })

  const deadMagicLinks = db
    .select({ id: tables.magicLinkTokens.id })
    .from(tables.magicLinkTokens)
    .where(
      or(
        lt(tables.magicLinkTokens.expiresAt, cutoff),
        and(
          isNotNull(tables.magicLinkTokens.usedAt),
          lt(tables.magicLinkTokens.usedAt, cutoff),
        ),
      ),
    )
    .limit(limit)

  const magicLinks = await db
    .delete(tables.magicLinkTokens)
    .where(inArray(tables.magicLinkTokens.id, deadMagicLinks))
    .returning({ id: tables.magicLinkTokens.id })

  return {
    mcpConnectCodes: connectCodes.length,
    magicLinkTokens: magicLinks.length,
    cutoff: cutoff.getTime(),
    truncated: connectCodes.length >= limit || magicLinks.length >= limit,
  }
}
