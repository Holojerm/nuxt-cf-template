// Types the extension seams (server/utils/extensions.ts) name but do not own.
//
// A seam's registry has to compile in an app that never ships the feature on
// the other side. Importing `LifecycleStep` from lifecycle.ts made lifecycle
// email a hard dependency of core: a fork without it kept a stub file only so
// the type resolved. The shapes live here instead, with type-only imports of
// modules every app has (email templates, notification vocabulary), so
// lifecycle.ts, its steps and its task can be deleted as a set.
//
// lifecycle.ts re-exports them, so existing imports of `./lifecycle` keep working.
//
// Why not server/utils: Nitro auto-imports every export under server/utils/, and
// the same names exported from two of those files (here this one and
// lifecycle.ts's re-export) is a "Duplicated imports" warning on every build.
// Only lifecycle.ts's copy is scanned; this file is reached by path.

import type { drizzle } from 'drizzle-orm/d1'

import type { OptionalNotificationEventType } from '#shared/utils/notifications'
import type * as tables from '../db/schema'
import type { Branding, EmailContent } from '../utils/email-templates'

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
