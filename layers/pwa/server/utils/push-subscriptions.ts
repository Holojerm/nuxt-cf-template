// The push_subscriptions table: what a browser hands over when its person
// turns notifications on, validated, stored per account, and capped.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '../db/schema'
import type { PushSubscriptionRow } from '../db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { base64UrlToBytes, isPushServiceEndpoint } from '../../shared/utils/push'

/**
 * A person's phone, tablet and a couple of browsers. Each send is one
 * subrequest per row, so the cap also bounds what one account can make the
 * Worker do. Past it, the oldest subscription makes room.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10

const decodesTo = (length: number) => (value: string) => {
  try {
    return base64UrlToBytes(value).length === length
  } catch {
    return false
  }
}

export const pushEndpointSchema = z
  .string()
  .max(2048)
  .refine(isPushServiceEndpoint, 'Not a push service this app sends to')

/** `PushSubscription.toJSON()`, less the `expirationTime` nothing here uses. */
export const pushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({
    p256dh: z.string().max(128).refine(decodesTo(65), 'Not a P-256 public key'),
    auth: z.string().max(64).refine(decodesTo(16), 'Not a 16-byte auth secret'),
  }),
})

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>

/**
 * Store the browser's subscription under this account. An endpoint is one
 * browser, so if another account had it (two people, one device) it moves:
 * nobody is sent the notifications of whoever signed in before them.
 */
export async function savePushSubscription(
  db: ExtensionDb,
  userId: string,
  input: PushSubscriptionInput,
): Promise<void> {
  const fields = { userId, p256dh: input.keys.p256dh, auth: input.keys.auth }
  await db
    .insert(tables.pushSubscriptions)
    .values({ endpoint: input.endpoint, ...fields })
    .onConflictDoUpdate({
      target: tables.pushSubscriptions.endpoint,
      set: { ...fields, lastSuccessAt: null, updatedAt: new Date() },
    })

  const newestFirst = await db
    .select({ id: tables.pushSubscriptions.id })
    .from(tables.pushSubscriptions)
    .where(eq(tables.pushSubscriptions.userId, userId))
    .orderBy(desc(tables.pushSubscriptions.updatedAt), desc(tables.pushSubscriptions.id))
  const beyondCap = newestFirst.slice(MAX_PUSH_SUBSCRIPTIONS_PER_USER).map((row) => row.id)
  if (beyondCap.length) {
    await db.delete(tables.pushSubscriptions).where(inArray(tables.pushSubscriptions.id, beyondCap))
  }
}

/** True when a row was removed. Scoped to the account: nobody unsubscribes someone else. */
export async function removePushSubscription(
  db: ExtensionDb,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const removed = await db
    .delete(tables.pushSubscriptions)
    .where(
      and(
        eq(tables.pushSubscriptions.userId, userId),
        eq(tables.pushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({ id: tables.pushSubscriptions.id })
  return removed.length > 0
}

/** Whether this browser's subscription is stored for this account. */
export async function hasPushSubscription(
  db: ExtensionDb,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const row = await db.query.pushSubscriptions.findFirst({
    where: and(
      eq(tables.pushSubscriptions.userId, userId),
      eq(tables.pushSubscriptions.endpoint, endpoint),
    ),
    columns: { id: true },
  })
  return Boolean(row)
}

export async function listPushSubscriptions(
  db: ExtensionDb,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  return db
    .select()
    .from(tables.pushSubscriptions)
    .where(eq(tables.pushSubscriptions.userId, userId))
}
