// The idempotency keys table (server/db/schema.ts): claiming a key, recording
// the answer the first attempt got, giving it back to a replay, and sweeping
// old keys. `idempotent()` (idempotency.ts) is the call a route makes; this is
// what it stands on, with the database passed in.

import { and, eq, inArray, isNull, lt } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { ExtensionDb } from '#server/utils/extensions'

/** How long a key answers for. A replay later than this writes again. */
export const IDEMPOTENCY_KEY_DAYS = 14

/**
 * A first attempt that has not finished after this long is taken for dead (the
 * isolate was killed mid-request) and the write runs again. If it died after
 * writing and before recording its answer, that is a second write: a handler
 * that cannot tolerate one stores the key on its own row under a unique index.
 */
export const IDEMPOTENCY_STALE_SECONDS = 60

/** A stored answer larger than this is replayed as an empty body. */
const MAX_STORED_RESPONSE = 64 * 1024

export type IdempotentOutcome<T> =
  | { state: 'ran' | 'replayed'; status: number; value: T }
  /** The first attempt is still running. */
  | { state: 'busy' }

export interface IdempotentRequest {
  userId: string
  key: string
  /** Unix milliseconds. Injected so tests don't depend on the wall clock. */
  now?: number
}

/**
 * Run `work` once per (account, key). `status` is read after `work` returns,
 * so a handler's `setResponseStatus(event, 201)` is replayed too. A `work`
 * that throws leaves no record: the write did not happen and may be tried again.
 */
export async function runIdempotent<T>(
  db: ExtensionDb,
  { userId, key, now = Date.now() }: IdempotentRequest,
  work: () => Promise<T>,
  status: () => number = () => 200,
): Promise<IdempotentOutcome<T>> {
  const mine = and(eq(tables.idempotencyKeys.userId, userId), eq(tables.idempotencyKeys.key, key))
  const claimedAt = new Date(now)

  const claimed = await db
    .insert(tables.idempotencyKeys)
    .values({ userId, key, createdAt: claimedAt })
    .onConflictDoNothing()
    .returning({ id: tables.idempotencyKeys.id })

  if (!claimed.length) {
    const [row] = await db.select().from(tables.idempotencyKeys).where(mine)
    if (row?.status != null) {
      const value = (row.response === null ? null : JSON.parse(row.response)) as T
      return { state: 'replayed', status: row.status, value }
    }
    // Still running, or dead. Taken over only when stale, and only by one
    // caller: the update matches the claim time it read.
    const stale = row && now - row.createdAt.getTime() >= IDEMPOTENCY_STALE_SECONDS * 1000
    const taken = stale
      ? await db
          .update(tables.idempotencyKeys)
          .set({ createdAt: claimedAt })
          .where(
            and(
              mine,
              isNull(tables.idempotencyKeys.status),
              eq(tables.idempotencyKeys.createdAt, row.createdAt),
            ),
          )
          .returning({ id: tables.idempotencyKeys.id })
      : []
    // No row at all: the first attempt failed and released the key between
    // the two statements. The client's next try starts clean.
    if (!taken.length) return { state: 'busy' }
  }

  let value: T
  try {
    value = await work()
  } catch (error) {
    await db.delete(tables.idempotencyKeys).where(mine)
    throw error
  }
  const body = JSON.stringify(value ?? null)
  const code = status()
  await db
    .update(tables.idempotencyKeys)
    .set({ status: code, response: body.length > MAX_STORED_RESPONSE ? null : body })
    .where(mine)
  return { state: 'ran', status: code, value }
}

/** One bounded sweep of keys past their life. Run by the purge task. */
export async function purgeIdempotencyKeys(
  db: ExtensionDb,
  { now = Date.now(), limit = 5000 }: { now?: number; limit?: number } = {},
): Promise<{ count: number; truncated: boolean }> {
  const cutoff = new Date(now - IDEMPOTENCY_KEY_DAYS * 24 * 60 * 60 * 1000)
  const old = db
    .select({ id: tables.idempotencyKeys.id })
    .from(tables.idempotencyKeys)
    .where(lt(tables.idempotencyKeys.createdAt, cutoff))
    .limit(limit)
  const gone = await db
    .delete(tables.idempotencyKeys)
    .where(inArray(tables.idempotencyKeys.id, old))
    .returning({ id: tables.idempotencyKeys.id })
  return { count: gone.length, truncated: gone.length >= limit }
}
