// DELETE /api/account — self-serve account deletion.
//
// /privacy promises "deletion of your account and its contents" through the
// support inbox; this is that promise made self-serve instead, which matters
// for the same reason app/utils/churn.ts refuses to make cancelling hard —
// routing deletion through a support inbox is friction at the exact same exit
// door. The mechanics (what "contents" means, why the users row survives as a
// tombstone, why a live subscription is the one refusal) live in
// server/utils/account.ts.
//
// `confirmEmail` is a typed-confirmation safeguard, not an obstacle: it stops
// a stray click on a destructive button, and unlike an "are you sure?" dialog
// it can't be dismissed by reflex.

import { z } from 'zod'

const bodySchema = z.object({
  confirmEmail: z.string().trim().email(),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readValidatedBody(event, bodySchema.parse)

  if (normalizeEmail(body.confirmEmail) !== normalizeEmail(user.email)) {
    throw createError({
      statusCode: 400,
      message: 'That email does not match your account.',
      data: { code: 'confirm_email_mismatch' },
    })
  }

  const outcome = await deleteAccount(db, user.id)

  if (outcome.outcome === 'not_found') {
    // Unreachable in practice — the session already proves the row exists —
    // but a stale session outliving a since-vanished row is not impossible.
    throw createError({ statusCode: 404, message: 'Account not found' })
  }

  if (outcome.outcome === 'live_subscription') {
    throw createError({
      statusCode: 409,
      message:
        'Deleting your account would not stop the charges — Paddle owns the subscription, ' +
        'not this account. Cancel it from the billing portal first, then delete your account.',
      data: { code: 'live_subscription', subscriptionId: outcome.subscriptionId },
    })
  }

  // Sent with the session's copy of the address, which is unaffected by
  // deleteAccount() having already rewritten the row to a tombstone — sending
  // only after a confirmed 'deleted' outcome (rather than before, "in case it
  // works") means nobody gets told their account is gone when a live
  // subscription just refused the request. Never throws, so a mail outage
  // can't undo a deletion the person asked for and already got.
  await sendEmail({ to: user.email, ...accountDeletedEmail(emailBranding(), { name: user.name }) })

  await clearUserSession(event)

  return { deleted: true }
})
