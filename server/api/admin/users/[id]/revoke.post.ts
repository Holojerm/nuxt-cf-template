// Take back one comp grant — the inverse of grant.post.ts. Admin-only.
//
// POST /api/admin/users/:id/revoke  { ref: "comp_…", reason: "granted twice" }
//
// The mechanics and the comps-only rule live in server/utils/admin-grants.ts ›
// revokeCompPass. This handler is the same four-step shape every privileged
// mutation in this console has:
//
//   1. requireAdmin(event) — the D1 `role` column, not the session, decides.
//   2. A reason is mandatory. Access disappearing from someone's account is
//      exactly the thing that generates a support call six months later, and
//      the answer needs to already be written down.
//   3. Pre-flight the target so a 404/422 leaves no audit row for something
//      that never happened — same rule the grant endpoint follows.
//   4. withAudit writes the row before anything changes.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  /** The `comp_…` ref from the customer's billing history. */
  ref: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3).max(500),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing user id' })

  const body = await readValidatedBody(event, bodySchema.parse)

  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, id),
    columns: { id: true },
  })
  if (!user) throw createError({ statusCode: 404, message: 'User not found' })

  // Refusing a paid ref BEFORE the audit row, not after. A `sub_`/`txn_` ref is
  // a rejected request rather than a performed action — the console never
  // offers the control, so reaching here means a hand-made call — and the audit
  // trail stays a list of things that happened to customers. The 422 names the
  // reason so the caller can tell it apart from a typo'd ref.
  if (!isCompRef(body.ref)) {
    throw createError({
      statusCode: 422,
      message: 'Only comped access can be revoked here — refunds go through Paddle',
      data: { code: 'not_comp' },
    })
  }

  const target = await db.query.entitlements.findFirst({
    where: and(
      eq(schema.entitlements.paddleSubscriptionId, body.ref),
      eq(schema.entitlements.userId, user.id),
    ),
    columns: { currentPeriodEnd: true, status: true, productKey: true },
  })
  if (!target) throw createError({ statusCode: 404, message: 'No such entitlement for this user' })

  // Its window already closed, so there is nothing to take away. Refused before
  // the audit row for the same reason the 404 is: no access changed hands, and
  // revoking it would only drag a past date forward (see revokeCompPass).
  if (target.currentPeriodEnd && target.currentPeriodEnd <= new Date()) {
    throw createError({
      statusCode: 409,
      message: 'That comp already expired on its own — there is nothing left to revoke',
      data: { code: 'already_expired' },
    })
  }

  return withAudit(
    db,
    {
      actorUserId: admin.id,
      action: 'admin.pass_revoked',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        // No email — `targetId` identifies the account (server/utils/audit.ts).
        ref: body.ref,
        reason: body.reason,
        productKey: target.productKey,
        // The access being taken away. Under audit-before-act the resulting
        // state isn't known yet, so this is the half that makes the outcome
        // reconstructible: "they had until the 14th, and an admin ended it."
        revokedEndsAt: target.currentPeriodEnd?.toISOString() ?? null,
        previousStatus: target.status,
      },
      ipHash: await auditIpHash(event),
    },
    async () => {
      // The row is handed through rather than re-read: the pre-flight above
      // already fetched it for the audit metadata. The guarded UPDATE inside
      // still re-asserts every condition, so this is a saved query, not a
      // weakened check.
      const result = await revokeCompPass(db, { userId: user.id, ref: body.ref, row: target })

      // `already_revoked` is a success, not an error: a double-click, or two
      // admins on the same ticket, should not produce a red toast for a row
      // that is already in the state the caller wanted.
      if (result.outcome === 'not_found' || result.outcome === 'not_comp') {
        throw createError({
          statusCode: result.outcome === 'not_found' ? 404 : 422,
          message: 'That entitlement could not be revoked',
          data: { code: result.outcome },
        })
      }

      // Only tell the customer when access actually changed. `already_revoked`
      // and `already_expired` are no-ops, and mailing "your access has ended"
      // for the second time is how a support tool becomes a spam source.
      if (result.outcome === 'revoked') {
        await notifyCompRevoked(db, { userId: user.id })
      }

      return {
        userId: user.id,
        ref: result.ref,
        outcome: result.outcome,
        revokedEndsAt: result.revokedEndsAt?.toISOString() ?? null,
        /** What still grants access, so the UI can say so without guessing. */
        remainingEndsAt: result.remainingEndsAt?.toISOString() ?? null,
      }
    },
  )
})
