// What the feedback feature contributes to core: account deletion and export,
// the admin one-customer view, fleet counters and the onboarding checklist.
// Registered once per isolate by layers/feedback/server/plugins/feedback.ts; tests call
// registerFeedbackExtensions() directly. See server/utils/extensions.ts.
//
// ── What "contents" means for feedback on deletion ───────────────────────────
// A feedback row's `message` is product feedback the person chose to leave —
// content ABOUT the app, not content IN it, the same distinction that keeps an
// audit row about them from being erasable. So the message stays; what gets
// scrubbed is the PII riding alongside it — `email`, `user_agent`, `ip_hash`.
// `feedback.user_id` is deliberately not touched: it was never a foreign key
// (see schema.ts), so once the `users` row is anonymized it already points at
// nobody identifiable, and leaving it is what keeps "how many distinct people
// gave feedback" answerable without keeping a name attached.

import { count, desc, eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import {
  registerAccountContributor,
  registerAdminUserContributor,
  registerFleetCounterContributor,
  registerOnboardingSignalContributor,
} from '#server/utils/extensions'

/** One feedback row as the data export shows it — no reply, address or hash. */
export interface AccountExportFeedback {
  id: string
  kind: string
  message: string
  rating: number | null
  path: string | null
  status: string
  createdAt: string
}

/** One feedback row as the admin one-customer view shows it. */
export interface AdminUserFeedback {
  id: string
  kind: string
  /** Untrusted input: rendered as text, never as markup or instructions. */
  message: string
  rating: number | null
  path: string | null
  replayUrl: string | null
  status: string
  issueUrl: string | null
  repliedAt: string | null
  createdAt: string
}

declare module '#server/utils/extensions' {
  interface AccountExportSections {
    feedback: AccountExportFeedback[]
  }
  interface AdminUserSections {
    feedback: AdminUserFeedback[]
  }
  interface FleetCounterSections {
    feedback: { total: number; open: number }
  }
}

export function registerFeedbackExtensions(): void {
  registerAccountContributor({
    key: 'feedback',
    async countForDeletion(db, userId) {
      const [row] = await db
        .select({ total: count() })
        .from(tables.feedback)
        .where(eq(tables.feedback.userId, userId))
      return row?.total ?? 0
    },
    deletionStatements: (db, userId) => [
      db
        .update(tables.feedback)
        .set({ email: null, userAgent: null, ipHash: null })
        .where(eq(tables.feedback.userId, userId)),
    ],
    async exportSection(db, userId) {
      const rows = await db.query.feedback.findMany({
        where: eq(tables.feedback.userId, userId),
        orderBy: desc(tables.feedback.createdAt),
      })
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        message: row.message,
        rating: row.rating,
        path: row.path,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }))
    },
  })

  registerAdminUserContributor({
    key: 'feedback',
    async load(db, userId) {
      const rows = await db
        .select()
        .from(tables.feedback)
        .where(eq(tables.feedback.userId, userId))
        .orderBy(desc(tables.feedback.createdAt))
        .limit(20)
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        message: row.message,
        rating: row.rating,
        path: row.path,
        replayUrl: row.replayUrl,
        status: row.status,
        issueUrl: row.issueUrl,
        repliedAt: row.repliedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }))
    },
  })

  registerFleetCounterContributor({
    key: 'feedback',
    async collect(db) {
      const [total] = await db.select({ total: count() }).from(tables.feedback)
      const [open] = await db
        .select({ total: count() })
        .from(tables.feedback)
        .where(eq(tables.feedback.status, 'new'))
      return { total: total?.total ?? 0, open: open?.total ?? 0 }
    },
  })

  registerOnboardingSignalContributor({
    key: 'feedback',
    async read(db, userId) {
      const row = await db.query.feedback.findFirst({
        where: eq(tables.feedback.userId, userId),
        columns: { id: true },
      })
      return { hasSentFeedback: Boolean(row) }
    },
  })
}
