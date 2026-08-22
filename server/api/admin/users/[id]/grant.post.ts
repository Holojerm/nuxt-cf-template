// Grant comp access to one customer — the apology grant. Admin-only.
//
// POST /api/admin/users/:id/grant  { passes: 1, reason: "outage on the 3rd" }
//
// The mechanics (why whole passes, why the `comp_` prefix, why it goes through
// grantPass) are in server/utils/admin-grants.ts. What lives here is the part
// that has to be true of every privileged mutation in this console:
//
//   1. requireAdmin(event) — the session says who, the D1 `role` column says
//      whether. The client-side middleware on /admin is not a boundary.
//   2. A reason is mandatory. An entitlement with no explanation is a row
//      nobody can defend six months later, and "make the operator type the
//      reason" is the cheapest control in the whole system.
//   3. Refs are minted BEFORE the audit row, so the row names the exact
//      entitlements about to be created rather than describing them vaguely.
//   4. withAudit writes that row before granting anything. A failed audit write
//      means no grant — see the policy note in server/utils/audit.ts.

import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  passes: z.coerce.number().int().min(1).max(MAX_COMP_PASSES).default(1),
  /** Free text, shown in the audit trail. Required — see (2) above. */
  reason: z.string().trim().min(3).max(500),
  productKey: z.string().trim().min(1).max(64).default('default'),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing user id' })

  const body = await readValidatedBody(event, bodySchema.parse)

  // `entitlements.user_id` IS a foreign key, so granting to a missing user
  // would fail at the constraint anyway — but as a 500 after the audit row was
  // already written, which reads as "an admin granted something and we don't
  // know what happened". Check first and 404 cleanly.
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, id),
    columns: { id: true, email: true },
  })
  if (!user) throw createError({ statusCode: 404, message: 'User not found' })

  const refs = Array.from({ length: body.passes }, () => compRef())

  // Refused BEFORE the audit row: a comp to a live subscriber delivers no days
  // at all (the window is what their next payment already buys), so this is a
  // rejected request rather than a privileged action, and it belongs in the
  // operator's face rather than in the trail. The console hides the form in
  // this state too — reaching here means a hand-made call or a race with a
  // subscription that started mid-session. grantCompPasses re-checks anyway.
  const overview = await getBillingOverview(db, user.id, body.productKey)
  const liveSubscription = overview.accessSubscriptionIds[0]
  if (liveSubscription) {
    throw createError({
      statusCode: 409,
      message:
        'This customer has an active subscription. Comp days would stack past its renewal ' +
        'date, so the paid period consumes them and they gain nothing. Issue a Paddle ' +
        'credit or discount against the next invoice instead.',
      data: { code: 'active_subscription', subscriptionId: liveSubscription },
    })
  }

  const before = overview.active

  return withAudit(
    db,
    {
      actorUserId: admin.id,
      action: 'admin.pass_granted',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        // No email — `targetId` identifies the account. See server/utils/audit.ts.
        passes: body.passes,
        days: body.passes * PASS_DAYS,
        reason: body.reason,
        productKey: body.productKey,
        // Flat scalars only (AuditMetadata) — a joined string, not an array.
        // Enough to find every row this action created with one LIKE.
        refs: refs.join(' '),
        // What they had before. The resulting expiry is not knowable yet under
        // audit-before-act, and this is the half that makes the outcome
        // reconstructible anyway.
        previousEndsAt: before?.currentPeriodEnd?.toISOString() ?? null,
      },
      ipHash: await auditIpHash(event),
    },
    async () => {
      const result = await grantCompPasses(db, {
        userId: user.id,
        passes: body.passes,
        productKey: body.productKey,
        refs,
      })

      // The util re-checks the subscription rule for callers that skip the
      // pre-flight above. Both paths report the same thing.
      if (result.outcome === 'active_subscription') {
        throw createError({
          statusCode: 409,
          message: 'This customer has an active subscription — issue a Paddle credit instead.',
          data: { code: 'active_subscription', subscriptionId: result.blockedBy ?? null },
        })
      }

      // After the write and awaited, so nobody is told about access that did
      // not land. sendEmail never throws, so a mail outage cannot undo a grant.
      await notifyCompGranted(db, { userId: user.id, endsAt: result.endsAt })

      return {
        userId: user.id,
        refs: result.refs,
        passes: result.passes,
        days: result.days,
        endsAt: result.endsAt?.toISOString() ?? null,
        stackedOn: result.stackedOn?.toISOString() ?? null,
      }
    },
  )
})
