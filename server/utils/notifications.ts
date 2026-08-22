// Whether a user gets a given optional email. The one rule that must hold
// everywhere: billing and security mail is mandatory, and that rule is
// enforced HERE — before the table is ever consulted — not by a column on
// notification_preferences (see the comment on that table in
// server/db/schema.ts for why there must never be one).
//
// Like entitlements.ts, every function takes the Drizzle client as its first
// argument instead of reaching for the auto-imported `db`. That's what lets
// test/notifications.test.ts drive this against a real D1 inside workerd
// without booting Nitro.

import { and, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
// Explicit, not the Nitro auto-import: the workerd vitest suite loads this
// file directly and nothing is injected there.
import {
  isMandatoryNotification,
  type OptionalNotificationEventType,
} from '#shared/utils/notifications'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type NotificationDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * The only channel this app sends on, and the only value ever written to the
 * column.
 *
 * A `channel` parameter used to be threaded through both functions below and
 * every one of their call sites, always defaulted, never once passed. That is
 * not extensibility — it is five call sites of noise plus a knob that has never
 * been turned and so has never been proven to work. The COLUMN stays (it is
 * part of the unique index, and adding push or SMS is a real possibility); the
 * parameter goes, and comes back the day a second channel does, with a caller.
 */
const DEFAULT_CHANNEL = 'email'

/**
 * Would this user receive `eventType` mail right now?
 *
 * Mandatory classes (billing.*, security.*, account.*) short-circuit to true
 * WITHOUT touching the table — no lookup even runs, so there is no code path
 * in which a row could suppress one. Everything else defaults to true in the
 * absence of a row: storing only exceptions is what keeps the table from
 * needing a backfill every time a new event type ships, and it means a failed
 * read degrades toward sending rather than toward silence.
 */
export async function isNotificationEnabled(
  db: NotificationDb,
  userId: string,
  eventType: string,
): Promise<boolean> {
  if (isMandatoryNotification(eventType)) return true

  const row = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(tables.notificationPreferences.userId, userId),
      eq(tables.notificationPreferences.channel, DEFAULT_CHANNEL),
      eq(tables.notificationPreferences.eventType, eventType),
    ),
    columns: { enabled: true },
  })

  return row?.enabled ?? true
}

/**
 * Upsert one opt-in/opt-out row.
 *
 * Refuses to write anything for a mandatory event type — belt-and-suspenders
 * alongside the Zod enum on PUT /api/account/notifications, which already
 * restricts `eventType` to the optional list. This function doesn't trust its
 * callers to have checked: a row here can never suppress mandatory mail
 * because isNotificationEnabled() never looks one up for a mandatory type,
 * but a stray row is still a landmine for anything written later that reads
 * this table directly, so the write is refused rather than merely ignored on
 * read.
 */
export async function setNotificationPreference(
  db: NotificationDb,
  userId: string,
  eventType: OptionalNotificationEventType,
  enabled: boolean,
): Promise<void> {
  if (isMandatoryNotification(eventType)) {
    console.warn(
      JSON.stringify({
        kind: 'notification_preference_mandatory_write_blocked',
        userId,
        eventType,
      }),
    )
    return
  }

  await db
    .insert(tables.notificationPreferences)
    .values({ userId, channel: DEFAULT_CHANNEL, eventType, enabled })
    .onConflictDoUpdate({
      target: [
        tables.notificationPreferences.userId,
        tables.notificationPreferences.channel,
        tables.notificationPreferences.eventType,
      ],
      set: { enabled, updatedAt: new Date() },
    })
}
