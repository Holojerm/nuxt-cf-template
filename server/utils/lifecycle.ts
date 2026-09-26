// Lifecycle email: "this user did X and not Y within N days" → one email, once.
//
// ── Shape ───────────────────────────────────────────────────────────────────
// A step is a query plus a template. `due()` answers "who should get this now"
// from D1; the runner owns everything that must be true for EVERY step and so
// must not be re-decided in each one: preferences, undeliverable addresses,
// once-only delivery, a per-run cap, and the analytics event.
//
// ── Once, by construction ───────────────────────────────────────────────────
// The `lifecycle_sends` row is claimed BEFORE the send, through a unique index,
// so overlapping runs cannot double-mail. A send that fails transiently gives
// the claim back so the next run retries; a permanent rejection keeps it,
// because retrying a bad address daily is how a domain gets a spam reputation.
//
// ── Windows, not thresholds ─────────────────────────────────────────────────
// Every step's `due()` must bound its audience on BOTH sides ("signed up 1–7
// days ago", never "more than 1 day ago"). The day Resend is first configured,
// a threshold would mail every user the app has ever had.

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import type { OptionalNotificationEventType } from '#shared/utils/notifications'
import { isMandatoryNotification } from '#shared/utils/notifications'
import * as tables from '../db/schema'
import type { Branding, EmailContent } from './email-templates'
import type { SendEmailOptions, SendEmailResult } from './email'
import { isNotificationEnabled } from './notifications'
import { isUndeliverableAddress } from './users'

export type LifecycleDb = ReturnType<typeof drizzle<typeof tables>>

export interface LifecycleRecipient {
  userId: string
  email: string
  name: string
  /** '' for once-per-account; otherwise what makes a repeat legitimate. */
  subjectKey: string
  /** Step-specific values `render` needs (a date, a count). */
  data?: Record<string, string>
}

export interface LifecycleStep {
  /** Stored in lifecycle_sends. Never rename: a renamed step re-sends to everyone. */
  id: string
  /** An optional preference, or a mandatory `billing.` / `account.` type. */
  notification: OptionalNotificationEventType | `billing.${string}` | `account.${string}`
  due(db: LifecycleDb, now: Date, limit: number): Promise<LifecycleRecipient[]>
  render(brand: Branding, recipient: LifecycleRecipient): EmailContent
}

export interface LifecycleDeps {
  send: (opts: SendEmailOptions) => Promise<SendEmailResult>
  unsubscribeUrl: (userId: string, eventType: OptionalNotificationEventType) => Promise<string>
  onSent?: (recipient: LifecycleRecipient, step: LifecycleStep) => Promise<void>
  brand: Branding
}

export interface LifecycleStepReport {
  due: number
  sent: number
  optedOut: number
  alreadySent: number
  failed: number
}

/** Enough to catch up after a missed day; small enough to stay inside one invocation. */
export const LIFECYCLE_SENDS_PER_STEP = 100

export async function runLifecycle(
  db: LifecycleDb,
  steps: readonly LifecycleStep[],
  deps: LifecycleDeps,
  now = new Date(),
): Promise<Record<string, LifecycleStepReport>> {
  const reports: Record<string, LifecycleStepReport> = {}
  for (const step of steps) {
    const report = { due: 0, sent: 0, optedOut: 0, alreadySent: 0, failed: 0 }
    reports[step.id] = report
    // One step's broken query must not cost every later step its run.
    let recipients: LifecycleRecipient[]
    try {
      recipients = await step.due(db, now, LIFECYCLE_SENDS_PER_STEP)
    } catch (error) {
      console.error(
        JSON.stringify({ kind: 'lifecycle_due_failed', step: step.id, error: String(error) }),
      )
      continue
    }
    report.due = recipients.length
    for (const recipient of recipients) {
      const outcome = await deliver(db, step, recipient, deps)
      report[outcome] += 1
    }
  }
  return reports
}

type DeliveryOutcome = 'sent' | 'optedOut' | 'alreadySent' | 'failed'

async function deliver(
  db: LifecycleDb,
  step: LifecycleStep,
  recipient: LifecycleRecipient,
  deps: LifecycleDeps,
): Promise<DeliveryOutcome> {
  if (isUndeliverableAddress(recipient.email)) return 'optedOut'
  if (!(await isNotificationEnabled(db, recipient.userId, step.notification))) return 'optedOut'

  const claimed = await db
    .insert(tables.lifecycleSends)
    .values({ userId: recipient.userId, stepId: step.id, subjectKey: recipient.subjectKey })
    .onConflictDoNothing()
    .returning({ id: tables.lifecycleSends.id })
  const claimId = claimed[0]?.id
  if (!claimId) return 'alreadySent'

  const content = step.render(deps.brand, recipient)
  const unsubscribe = isMandatoryNotification(step.notification)
    ? undefined
    : {
        eventType: step.notification,
        url: await deps.unsubscribeUrl(
          recipient.userId,
          step.notification as OptionalNotificationEventType,
        ),
      }
  const result = await deps.send({ to: recipient.email, ...content, unsubscribe })

  if (!result.sent) {
    if (result.reason !== 'rejected') {
      await db.delete(tables.lifecycleSends).where(eq(tables.lifecycleSends.id, claimId))
    }
    return 'failed'
  }
  await deps.onSent?.(recipient, step)
  return 'sent'
}
