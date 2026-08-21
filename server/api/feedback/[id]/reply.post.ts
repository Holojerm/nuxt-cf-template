// Reply to one piece of feedback — POST /api/feedback/[id]/reply. Admin-only.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Everything else in the feedback loop moves information toward us: the widget
// writes a row, the triage routine files an issue, the digest summarises it.
// Nothing moved information back, so a person who reported a bug got silence
// forever. That is extraction, not a loop, and it teaches people to stop
// bothering — the cheapest way to kill your own feedback channel.
//
// ── Why there is no UI for it in this app ────────────────────────────────────
// Deliberate. This is the durable half; an admin screen belongs in whatever
// operator surface you run across your apps, and that surface calls this route.
// Until then it is reachable with a session cookie and curl, which is enough.
//
// ── Why a routine must never call it ─────────────────────────────────────────
// `.claude/routines/feedback-triage.md` forbids replying to submitters, and the
// requireAdmin() gate is what makes that stick: an agent has no admin session.
// An autonomous agent emailing your customers unsupervised is a category of
// mistake you cannot recall.

import { z } from 'zod'

const bodySchema = z.object({
  /** The reply, as plain sentences. Rendered escaped — no markup survives. */
  message: z.string().trim().min(1).max(5000),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing feedback id' })

  const body = await readValidatedBody(event, bodySchema.parse)

  const row = await findFeedbackById(db, id)
  if (!row) throw createError({ statusCode: 404, message: 'Feedback not found' })

  const to = await feedbackReplyAddress(db, row)
  if (!to) {
    // Anonymous feedback with no address is legitimate and common — this is a
    // property of the submission, not a failure, so it says so precisely.
    throw createError({
      statusCode: 422,
      message: 'This feedback has no reply address',
      data: { code: 'no_reply_address' },
    })
  }

  // ── Audited before the mail leaves ──────────────────────────────────────────
  // This is the one action in the app that speaks to a customer under the
  // company's name, and an email cannot be recalled — so the record goes down
  // first, exactly like a comp grant (server/utils/audit.ts).
  //
  // If the send then fails, the row stands and the feedback is NOT stamped
  // replied. That reads correctly: an attempt was made, and nothing claims a
  // reply the customer never got.
  //
  // What is deliberately absent: the recipient address and the reply text. The
  // address is PII that `target_id` already leads to, and the body is free text
  // that would sit undeletable in an append-only table — the same reasoning that
  // keeps emails out of every other audit row here. The mail provider holds the
  // content; this holds who decided to send it, about what, and when.
  await writeAudit(db, {
    actorUserId: admin.id,
    action: 'feedback.replied',
    targetType: 'feedback',
    targetId: row.id,
    metadata: {
      feedbackKind: row.kind,
      previousStatus: row.status,
      replyLength: body.message.length,
    },
    ipHash: await auditIpHash(event),
  })

  const config = useRuntimeConfig()
  const result = await sendEmail({
    to,
    replyTo: config.public.supportEmail,
    ...feedbackReplyEmail(emailBranding(), {
      reply: body.message,
      originalMessage: row.message,
    }),
  })

  // sendEmail never throws, so an unsent reply would otherwise be recorded as a
  // reply. Stamp the row only when the mail actually left — a queue that claims
  // to be answered is worse than one that is visibly not.
  if (!result.sent) {
    throw createError({
      statusCode: result.reason === 'unconfigured' ? 503 : 502,
      message:
        result.reason === 'unconfigured'
          ? 'Email is not configured on this deployment'
          : 'Could not send the reply',
      data: { code: `email_${result.reason}` },
    })
  }

  const updated = await markFeedbackReplied(db, id, admin.id)

  await captureServerEvent({
    distinctId: row.userId ?? row.posthogDistinctId ?? `feedback-${row.id}`,
    event: 'feedback_replied',
    properties: { feedback_id: row.id, feedback_kind: row.kind },
  })

  return {
    id: row.id,
    status: updated?.status ?? row.status,
    repliedAt: updated?.repliedAt?.toISOString() ?? null,
  }
})
