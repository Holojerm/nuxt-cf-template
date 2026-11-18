// `sendPush`: the one call an app makes to notify a person. Product
// notification only ("your coach changed the plan"); alerts about the app
// itself go to ops_events and fleet, never here.

import { db } from '@nuxthub/db'
import type { H3Event } from 'h3'

import { logEvent } from '#server/utils/log'
import type { PushMessage } from '../../shared/utils/push'
import { deliverPush } from './push-send'
import type { PushKeys, PushResult } from './push-send'

/**
 * One budget for the four push routes, per caller. A settings switch needs two
 * or three requests; 20 a minute leaves room for someone flipping it back and
 * forth and none for a loop.
 */
export const PUSH_LIMIT = { name: 'pwa-push', limit: 20, windowSeconds: 60 }

/**
 * The app's VAPID keys, or null when push is not set up (or the layer is off).
 * Pass the event inside a request; a task or queue consumer has none.
 */
export function pushKeys(event?: H3Event): PushKeys | null {
  const config = useRuntimeConfig(event)
  const publicKey = config.public.pwa.vapidPublicKey
  const privateKey = config.pwa.vapidPrivateKey
  if (!config.public.pwa.enabled || (!publicKey && !privateKey)) return null
  if (!publicKey || !privateKey) {
    // One key without the other sends nothing, and says so once per call.
    logEvent('warn', 'push_half_configured', { missing: publicKey ? 'private' : 'public' })
    return null
  }
  return { publicKey, privateKey, subject: config.pwa.vapidSubject || config.public.appUrl }
}

/** 404, not 503: an app without VAPID keys has no push routes. */
export function requirePush(event: H3Event): PushKeys {
  const keys = pushKeys(event)
  if (!keys) throw createError({ statusCode: 404, message: 'Not found' })
  return keys
}

/**
 * Notify every browser this person turned notifications on in. Does nothing
 * (and reports zeros) when the app has no VAPID keys or the person has no
 * subscription, and never throws for a push service's answer: await it for the
 * counts, or hand it to `event.waitUntil` and move on.
 */
export async function sendPush(userId: string, message: PushMessage): Promise<PushResult> {
  return deliverPush({ db, keys: pushKeys() }, userId, message)
}
