// Product updates by email for a visitor with no account.
//
// ── Double opt-in ────────────────────────────────────────────────────────────
// The form takes an address anyone could have typed, so asking is not consent.
// Asking sends ONE email, the confirmation, and nothing else goes to that
// address until its link is confirmed from the page it opens. An unconfirmed row
// is deleted after SUBSCRIBER_PENDING_DAYS by the daily purge.
//
// ── Leaving deletes ──────────────────────────────────────────────────────────
// Unsubscribing removes the row; there is no "unsubscribed" state holding the
// address. Subscribing again later is a fresh double opt-in.
//
// ── Accounts win ─────────────────────────────────────────────────────────────
// An address with an account is governed by that account's `product_updates`
// preference. Confirming for such an address switches that preference on, and
// signing up removes the subscriber row, so one person is never on both lists.
//
// The signed links are in subscriber-tokens.ts. Every function here takes the
// Drizzle client, for the workerd tests.

import { and, count, eq, isNotNull, isNull, lt } from 'drizzle-orm'

import * as tables from '../db/schema'
import { subscribeConfirmEmail } from './email-notes'
import type { Branding } from './email-templates'
import type { SendEmailOptions, SendEmailResult } from './email'
import { setNotificationPreference, type NotificationDb } from './notifications'
import { consumeRateLimit, type RateLimitStore } from './rate-limit'
import { isUndeliverableAddress, normalizeEmail } from './users'

export const SUBSCRIBER_PENDING_DAYS = 7
/** Confirmation emails one address can be sent in a day, whoever asks. */
export const SUBSCRIBE_ADDRESS_BUDGET = { limit: 3, windowSeconds: 24 * 60 * 60 }

const DAY_MS = 24 * 60 * 60 * 1000
const subscribers = tables.emailSubscribers

export interface SubscribeDeps {
  brand: Branding
  send: (opts: SendEmailOptions) => Promise<SendEmailResult>
  confirmUrl: (subscriberId: string) => Promise<string>
  /** Where the per-address budget is counted. */
  store: RateLimitStore
}

export type SubscribeOutcome =
  /** The confirmation email went out. */
  | { state: 'sent' }
  /** Nothing was sent, and the caller must not be able to tell: see the route. */
  | { state: 'refused' | 'already_confirmed' | 'over_budget' | 'rejected' }
  /** Mail is down or unconfigured. `url` lets a dev server show the link. */
  | { state: 'unavailable'; url: string }

/** Record that an address asked, and send it the one email it may get: the confirmation. */
export async function requestSubscription(
  db: NotificationDb,
  rawEmail: string,
  deps: SubscribeDeps,
  now = new Date(),
): Promise<SubscribeOutcome> {
  const email = normalizeEmail(rawEmail)
  if (isUndeliverableAddress(email)) return { state: 'refused' }

  const existing = await db.query.emailSubscribers.findFirst({
    where: eq(subscribers.email, email),
  })
  if (existing?.confirmedAt) return { state: 'already_confirmed' }

  // Keyed by the address, so a stranger cannot use this form to fill someone's inbox.
  const budget = await consumeRateLimit(
    deps.store,
    { key: `subscribe-address:${email}`, ...SUBSCRIBE_ADDRESS_BUDGET },
    now.getTime(),
  )
  if (!budget.allowed) return { state: 'over_budget' }

  let id = existing?.id
  if (id) {
    // Asking again restarts the week the new link is promised to work for.
    await db.update(subscribers).set({ createdAt: now }).where(eq(subscribers.id, id))
  } else {
    await db.insert(subscribers).values({ email, createdAt: now }).onConflictDoNothing()
    const row = await db.query.emailSubscribers.findFirst({ where: eq(subscribers.email, email) })
    if (!row) return { state: 'refused' }
    id = row.id
  }

  const url = await deps.confirmUrl(id)
  const result = await deps.send({
    to: email,
    ...subscribeConfirmEmail(deps.brand, { url, days: SUBSCRIBER_PENDING_DAYS }),
  })
  if (result.sent) return { state: 'sent' }
  return result.reason === 'rejected' ? { state: 'rejected' } : { state: 'unavailable', url }
}

/**
 * The second half of the opt-in. `gone` when the row no longer exists (purged
 * after a week, or removed). Confirming twice is fine.
 */
export async function confirmSubscription(
  db: NotificationDb,
  id: string,
  now = new Date(),
): Promise<'confirmed' | 'gone'> {
  const row = await db.query.emailSubscribers.findFirst({ where: eq(subscribers.id, id) })
  if (!row) return 'gone'

  const account = await db.query.users.findFirst({
    where: eq(tables.users.email, row.email),
    columns: { id: true },
  })
  if (account) {
    await setNotificationPreference(db, account.id, 'product_updates', true)
    await db.delete(subscribers).where(eq(subscribers.id, id))
    return 'confirmed'
  }

  await db
    .update(subscribers)
    .set({ confirmedAt: now })
    .where(and(eq(subscribers.id, id), isNull(subscribers.confirmedAt)))
  return 'confirmed'
}

/** Unsubscribe, which is also deletion: the address is not kept. */
export async function removeSubscriber(db: NotificationDb, id: string): Promise<void> {
  await db.delete(subscribers).where(eq(subscribers.id, id))
}

/** A new account takes over from a subscriber row with the same address. */
export async function removeSubscriberByEmail(db: NotificationDb, email: string): Promise<void> {
  await db.delete(subscribers).where(eq(subscribers.email, normalizeEmail(email)))
}

/** Delete addresses that never confirmed. Returns how many went. */
export async function purgePendingSubscribers(db: NotificationDb, now = new Date()) {
  const purged = await db
    .delete(subscribers)
    .where(
      and(
        isNull(subscribers.confirmedAt),
        lt(subscribers.createdAt, new Date(now.getTime() - SUBSCRIBER_PENDING_DAYS * DAY_MS)),
      ),
    )
    .returning({ id: subscribers.id })
  return purged.length
}

/** Counts for GET /api/fleet. Never an address. */
export async function countSubscribers(db: NotificationDb) {
  const [confirmed] = await db
    .select({ total: count() })
    .from(subscribers)
    .where(isNotNull(subscribers.confirmedAt))
  const [pending] = await db
    .select({ total: count() })
    .from(subscribers)
    .where(isNull(subscribers.confirmedAt))
  return { confirmed: confirmed?.total ?? 0, pending: pending?.total ?? 0 }
}
