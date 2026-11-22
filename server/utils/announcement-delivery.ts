// One announcement to one person: every check a send must pass, in the order
// that keeps it cheap and safe. Called by the run loop in announcements.ts.
//
// `capped` and `optedOut` are final for this announcement (the run moves on and
// never returns); `retry` means the send failed for a reason that may pass, so
// the claim is given back and the run stops at this person until tomorrow.

import { announcementStepId, type Announcement } from '#shared/utils/announcements'
import type { LifecycleDb } from '../types/extension-types'
import {
  ledgerFor,
  type AnnouncementRecipient,
  type AnnouncementStage,
} from './announcement-audience'
import type { Branding } from './email-templates'
import { noteEmail } from './email-notes'
import type { LifecycleDeps } from './lifecycle'
import { emailLink } from './lifecycle-definitions'
import { isUndeliverableAddress } from './users'

export interface AnnouncementDeps {
  brand: Branding
  send: LifecycleDeps['send']
  /** The account's own unsubscribe link, for the `product_updates` preference. */
  unsubscribeUrl: LifecycleDeps['unsubscribeUrl']
  subscriberUnsubscribeUrl: (subscriberId: string) => Promise<string>
  onSent?: (userId: string, stepId: string) => Promise<void>
  /** Announcements one person may get in seven days. */
  weeklyCap: number
}

export type AnnouncementOutcome =
  | 'sent'
  | 'capped'
  | 'optedOut'
  | 'failed'
  | 'alreadySent'
  | 'retry'

export async function deliverAnnouncement(
  db: LifecycleDb,
  announcement: Announcement,
  stage: AnnouncementStage,
  recipient: AnnouncementRecipient,
  deps: AnnouncementDeps,
  now: Date,
): Promise<AnnouncementOutcome> {
  const ledger = ledgerFor(db, stage)
  const stepId = announcementStepId(announcement.id)
  if (isUndeliverableAddress(recipient.email)) return 'optedOut'
  if (!(await ledger.allows(recipient.id))) return 'optedOut'
  if ((await ledger.sentThisWeek(recipient.id, now)) >= deps.weeklyCap) return 'capped'

  const claimId = await ledger.claim(recipient.id, stepId, now)
  if (!claimId) return 'alreadySent'

  const { brand } = deps
  const content = noteEmail(brand, {
    subject: announcement.subject,
    heading: announcement.heading,
    paragraphs: announcement.paragraphs,
    button: announcement.button && {
      label: announcement.button.label,
      url: emailLink(brand.appUrl, announcement.button.path, 'announcement', stepId),
    },
    footnote:
      stage === 'users'
        ? `You're receiving this because you have an account at ${brand.appName}.`
        : `You're receiving this because you asked for product updates from ${brand.appName}.`,
  })
  const url =
    stage === 'users'
      ? await deps.unsubscribeUrl(recipient.id, 'product_updates')
      : await deps.subscriberUnsubscribeUrl(recipient.id)
  const result = await deps.send({
    to: recipient.email,
    ...content,
    unsubscribe: { eventType: 'product_updates', url },
  })

  if (!result.sent) {
    if (result.reason === 'rejected') return 'failed'
    await ledger.release(claimId)
    return 'retry'
  }
  if (stage === 'users') await deps.onSent?.(recipient.id, stepId)
  return 'sent'
}
