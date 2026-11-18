// `idempotent()`: the server half of the outbox. A write the client could not
// confirm is sent again with the same `Idempotency-Key`; the first attempt's
// answer is stored under it, and the replay gets that answer back with nothing
// written a second time.
//
//   export default defineEventHandler(async (event) => {
//     const { user } = await requireUserSession(event)
//     const body = await readValidatedBody(event, schema.parse)
//     return idempotent(event, user.id, () => saveSession(db, user.id, body))
//   })
//
// Validate before the call and write inside it. A request with no key runs
// as it always did.

import { db } from '@nuxthub/db'
import type { H3Event } from 'h3'

import { runIdempotent } from './idempotency-keys'

/** The outbox sends a UUID. Anything this shape is taken. */
const KEY_SHAPE = /^[\w-]{8,64}$/

/**
 * Wrap a write so a replay of it does not write twice. See the file header.
 *
 * Also refuses a queued write that names another account as its owner: the
 * service worker replays without knowing who is signed in now.
 */
export async function idempotent<T>(
  event: H3Event,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  const owner = getRequestHeader(event, 'x-outbox-owner')
  if (owner && owner !== userId) {
    throw createError({ statusCode: 403, message: 'This was saved under another account' })
  }
  const key = getRequestHeader(event, 'idempotency-key')
  if (!key) return work()
  if (!KEY_SHAPE.test(key)) {
    throw createError({ statusCode: 400, message: 'Idempotency-Key is not a valid key' })
  }

  const outcome = await runIdempotent(db, { userId, key }, work, () => getResponseStatus(event))
  if (outcome.state === 'busy') {
    // `Retry-After` is what tells the outbox to keep the write and try again.
    setResponseHeader(event, 'Retry-After', 2)
    throw createError({ statusCode: 409, message: 'This request is already being handled' })
  }
  if (outcome.state === 'replayed') {
    setResponseStatus(event, outcome.status)
    setResponseHeader(event, 'Idempotent-Replayed', 'true')
  }
  return outcome.value
}
