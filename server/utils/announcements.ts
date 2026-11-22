// Announcement email: one file in content/announcements/, sent once to everyone
// who allows product mail.
//
// ── One pass, by cursor ──────────────────────────────────────────────────────
// A run walks its audience in id order and remembers how far it got
// (`announcement_runs`). Each person is therefore dealt with exactly once: sent
// to, or skipped and counted. That is what makes the weekly cap a cap rather
// than a delay: someone over it is passed and never returned to.
//
// ── Once, by construction ────────────────────────────────────────────────────
// As in lifecycle.ts, the send is claimed in a ledger before it is made, through
// a unique index, so overlapping runs cannot double-mail. A send that fails for
// a reason that may pass stops the run where it is and gives the claim back; the
// next daily run resumes at that person. A refused address keeps its claim.
//
// ── Bounded on both sides ────────────────────────────────────────────────────
// A send starts on its `date` or in the fortnight after, never later, so the day
// email is first configured does not deliver every announcement ever written.
// Nobody who arrived after the run started is in it, and a run still open after
// a fortnight is closed.

import { eq, sql } from 'drizzle-orm'

import type { Announcement } from '#shared/utils/announcements'
import * as tables from '../db/schema'
import type { LifecycleDb } from '../types/extension-types'
import {
  stagesFor,
  subscribersPage,
  usersPage,
  type AnnouncementStage,
} from './announcement-audience'
import { deliverAnnouncement, type AnnouncementDeps } from './announcement-delivery'
import { logEvent } from './log'

export type { AnnouncementDeps }

export interface AnnouncementReport {
  state: 'scheduled' | 'expired' | 'running' | 'finished'
  sent: number
  /** Skipped because the reader had their week's announcements already. */
  capped: number
  optedOut: number
  failed: number
}

const DAY_MS = 24 * 60 * 60 * 1000
export const ANNOUNCEMENT_START_DAYS = 14
/**
 * People dealt with per run, across every announcement; the cursor carries on
 * the next day. Each costs a handful of D1 calls and a send, and one invocation
 * has a fixed allowance of those, so a list longer than about 1,400 (this times
 * the fortnight a run may stay open) needs a different sender.
 */
export const ANNOUNCEMENT_RECIPIENTS_PER_RUN = 100

const runs = tables.announcementRuns
const blank = (state: AnnouncementReport['state']): AnnouncementReport => ({
  state,
  sent: 0,
  capped: 0,
  optedOut: 0,
  failed: 0,
})

export async function runAnnouncements(
  db: LifecycleDb,
  announcements: readonly Announcement[],
  deps: AnnouncementDeps,
  now = new Date(),
): Promise<Record<string, AnnouncementReport>> {
  const reports: Record<string, AnnouncementReport> = {}
  const budget = { left: ANNOUNCEMENT_RECIPIENTS_PER_RUN }
  for (const announcement of announcements) {
    // One announcement's failure must not cost the others their run.
    try {
      const report = await runOne(db, announcement, deps, now, budget)
      if (report) reports[announcement.id] = report
    } catch (error) {
      logEvent('error', 'announcement_failed', { id: announcement.id, error: String(error) })
    }
  }
  return reports
}

const findRun = (db: LifecycleDb, id: string) =>
  db.query.announcementRuns.findFirst({ where: eq(runs.announcementId, id) })

async function runOne(
  db: LifecycleDb,
  announcement: Announcement,
  deps: AnnouncementDeps,
  now: Date,
  budget: { left: number },
): Promise<AnnouncementReport | null> {
  const stages = stagesFor(announcement.audience)
  let run = await findRun(db, announcement.id)
  if (run?.finishedAt) return null

  if (!run) {
    const opens = Date.parse(`${announcement.date}T00:00:00Z`)
    if (now.getTime() < opens) return blank('scheduled')
    const tooLate = now.getTime() > opens + ANNOUNCEMENT_START_DAYS * DAY_MS
    await db
      .insert(runs)
      .values({
        announcementId: announcement.id,
        stage: stages[0],
        createdAt: now,
        finishedAt: tooLate ? now : null,
      })
      .onConflictDoNothing()
    if (tooLate) return blank('expired')
    run = await findRun(db, announcement.id)
    if (!run || run.finishedAt) return null
  }
  if (now.getTime() > run.createdAt.getTime() + ANNOUNCEMENT_START_DAYS * DAY_MS) {
    await db.update(runs).set({ finishedAt: now }).where(eq(runs.announcementId, announcement.id))
    return blank('expired')
  }

  const report = blank('running')
  let stage = run.stage as AnnouncementStage
  let cursor = run.cursor
  let halted = false

  while (budget.left > 0 && !halted && report.state === 'running') {
    const query = { cursor, before: run.createdAt, limit: budget.left }
    const page =
      stage === 'users'
        ? await usersPage(db, announcement.audience, query)
        : await subscribersPage(db, query)
    for (const recipient of page) {
      const outcome = await deliverAnnouncement(db, announcement, stage, recipient, deps, now)
      if (outcome === 'retry') {
        halted = true
        break
      }
      if (outcome !== 'alreadySent') report[outcome] += 1
      cursor = recipient.id
      budget.left -= 1
    }
    if (!halted && page.length < query.limit) {
      const next = stages[stages.indexOf(stage) + 1]
      if (next) {
        stage = next
        cursor = ''
      } else {
        report.state = 'finished'
      }
    }
  }

  await db
    .update(runs)
    .set({
      stage,
      cursor,
      sent: sql`${runs.sent} + ${report.sent}`,
      capped: sql`${runs.capped} + ${report.capped}`,
      optedOut: sql`${runs.optedOut} + ${report.optedOut}`,
      finishedAt: report.state === 'finished' ? now : null,
    })
    .where(eq(runs.announcementId, announcement.id))
  return report
}
