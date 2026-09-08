// POST /api/account/sessions/revoke — "sign out everywhere".
//
// Moves the account's session watermark (server/utils/session-guard.ts) and
// re-issues THIS session at the same instant, so every other device's cookie
// is refused on its next request while the one that clicked stays signed in.

import { db } from '@nuxthub/db'
import { revokeSessions } from '../../../utils/account'
import { buildSessionPayload } from '../../../utils/auth'
import { findUserById } from '../../../utils/users'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  // One clock reading for both halves: the watermark is stored in seconds and
  // the guard is a strict less-than, so a cookie dated the same second as the
  // watermark survives. Reading the clock twice could straddle a second.
  const now = Date.now()
  const outcome = await revokeSessions(db, user.id, new Date(now))
  if (outcome.outcome === 'not_found') {
    throw createError({ statusCode: 404, message: 'Account not found' })
  }

  const row = await findUserById(db, user.id)
  if (!row) throw createError({ statusCode: 404, message: 'Account not found' })
  await replaceUserSession(event, buildSessionPayload(row, now))

  return { revoked: true, at: outcome.at.toISOString() }
})
