// Who an announcement goes to, one page at a time, and the two ledgers a send
// is claimed in: `lifecycle_sends` for accounts, `subscriber_sends` for
// visitors who subscribed without one (server/utils/subscribers.ts).
//
// Both kinds of recipient go through the same loop in announcements.ts, so this
// file gives each the same four operations: a page, a weekly count, a claim and
// a way to give the claim back.

import { and, asc, count, eq, exists, gt, isNotNull, like, lte, notExists, sql } from 'drizzle-orm'

import { ANNOUNCEMENT_STEP_PREFIX, type AnnouncementAudience } from '#shared/utils/announcements'
import * as tables from '../db/schema'
import type { LifecycleDb } from '../types/extension-types'
import { isNotificationEnabled } from './notifications'

export type AnnouncementStage = 'users' | 'subscribers'

export interface AnnouncementRecipient {
  /** A user id or a subscriber id: the cursor, and what a claim is keyed on. */
  id: string
  email: string
}

export interface PageQuery {
  /** The last id the run has dealt with; '' at the start. */
  cursor: string
  /** Nobody who arrived after the run started: the far bound of the audience. */
  before: Date
  limit: number
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const isAnnouncement = `${ANNOUNCEMENT_STEP_PREFIX}%`

/** The stages an audience passes through, in order. */
export function stagesFor(audience: AnnouncementAudience): AnnouncementStage[] {
  if (audience === 'subscribers') return ['subscribers']
  if (audience === 'everyone') return ['users', 'subscribers']
  return ['users']
}

export async function usersPage(
  db: LifecycleDb,
  audience: AnnouncementAudience,
  { cursor, before, limit }: PageQuery,
): Promise<AnnouncementRecipient[]> {
  const activated = sql`(select 1 from ${tables.auditLog} where ${tables.auditLog.action} = 'onboarding.activated' and ${tables.auditLog.actorUserId} = ${tables.users.id})`
  return db
    .select({ id: tables.users.id, email: tables.users.email })
    .from(tables.users)
    .where(
      and(
        gt(tables.users.id, cursor),
        lte(tables.users.createdAt, before),
        audience === 'activated' ? exists(activated) : undefined,
      ),
    )
    .orderBy(asc(tables.users.id))
    .limit(limit)
}

/**
 * Confirmed subscribers only, and never an address that has an account: that
 * person's own preference decides, in the users stage.
 */
export async function subscribersPage(
  db: LifecycleDb,
  { cursor, before, limit }: PageQuery,
): Promise<AnnouncementRecipient[]> {
  return db
    .select({ id: tables.emailSubscribers.id, email: tables.emailSubscribers.email })
    .from(tables.emailSubscribers)
    .where(
      and(
        gt(tables.emailSubscribers.id, cursor),
        isNotNull(tables.emailSubscribers.confirmedAt),
        lte(tables.emailSubscribers.confirmedAt, before),
        notExists(
          sql`(select 1 from ${tables.users} where ${tables.users.email} = ${tables.emailSubscribers.email})`,
        ),
      ),
    )
    .orderBy(asc(tables.emailSubscribers.id))
    .limit(limit)
}

export interface AnnouncementLedger {
  /** May this person get product mail at all? */
  allows(id: string): Promise<boolean>
  /** Announcements sent to this person in the seven days before `now`. */
  sentThisWeek(id: string, now: Date): Promise<number>
  /** Claims the send. Null when another run already has it. */
  claim(id: string, stepId: string, now: Date): Promise<string | null>
  release(claimId: string): Promise<void>
}

export function ledgerFor(db: LifecycleDb, stage: AnnouncementStage): AnnouncementLedger {
  if (stage === 'users') {
    const sends = tables.lifecycleSends
    return {
      allows: (id) => isNotificationEnabled(db, id, 'product_updates'),
      async sentThisWeek(id, now) {
        const [row] = await db
          .select({ total: count() })
          .from(sends)
          .where(
            and(
              eq(sends.userId, id),
              like(sends.stepId, isAnnouncement),
              gt(sends.sentAt, new Date(now.getTime() - WEEK_MS)),
            ),
          )
        return row?.total ?? 0
      },
      async claim(id, stepId, now) {
        const claimed = await db
          .insert(sends)
          .values({ userId: id, stepId, subjectKey: '', sentAt: now })
          .onConflictDoNothing()
          .returning({ id: sends.id })
        return claimed[0]?.id ?? null
      },
      release: async (claimId) => void (await db.delete(sends).where(eq(sends.id, claimId))),
    }
  }

  const sends = tables.subscriberSends
  return {
    // The page already holds only confirmed subscribers; being on it is the opt-in.
    allows: async () => true,
    async sentThisWeek(id, now) {
      const [row] = await db
        .select({ total: count() })
        .from(sends)
        .where(
          and(
            eq(sends.subscriberId, id),
            like(sends.stepId, isAnnouncement),
            gt(sends.sentAt, new Date(now.getTime() - WEEK_MS)),
          ),
        )
      return row?.total ?? 0
    },
    async claim(id, stepId, now) {
      const claimed = await db
        .insert(sends)
        .values({ subscriberId: id, stepId, sentAt: now })
        .onConflictDoNothing()
        .returning({ id: sends.id })
      return claimed[0]?.id ?? null
    },
    release: async (claimId) => void (await db.delete(sends).where(eq(sends.id, claimId))),
  }
}
