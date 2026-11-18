// Sends one notification to every browser a person turned notifications on
// in. Everything it needs is an argument, so the workerd tests drive it with a
// real D1 and a fake push service; `sendPush` (push.ts) fills them in.
//
// A push is a side effect of something else (a plan changed, the post
// arrived), so nothing here throws for a subscription that failed: it is
// logged, counted, and the others still go out.

import { eq } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { logEvent } from '#server/utils/log'
import { base64UrlToBytes } from '../../shared/utils/push'
import type { PushMessage } from '../../shared/utils/push'
import { encryptPushPayload, vapidAuthorization } from './push-crypto'
import { listPushSubscriptions } from './push-subscriptions'

export interface PushKeys {
  publicKey: string
  privateKey: string
  /** The VAPID `sub`: a `mailto:` or `https:` URL. */
  subject: string
}

export interface PushDeps {
  db: ExtensionDb
  /** Null when the app has no VAPID keys: sending is then a no-op. */
  keys: PushKeys | null
  fetch?: typeof fetch
  now?: () => Date
}

export interface PushResult {
  /** Accepted by the push service. Delivery to the device is the service's business. */
  sent: number
  /** Subscriptions the service said are gone (404, 410), deleted here. */
  removed: number
  /** Everything else: the service refused or could not be reached. The row stays. */
  failed: number
}

/** How long a push service holds a message for a device that is offline. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60

// A lock screen shows about this much. It also keeps the message far inside
// the 4096 bytes a push service accepts, whatever the script.
const MAX_TITLE_CHARS = 100
const MAX_BODY_CHARS = 300
const clip = (value: string, max: number) => [...value].slice(0, max).join('')

type Outcome = keyof PushResult

export async function deliverPush(
  deps: PushDeps,
  userId: string,
  message: PushMessage,
): Promise<PushResult> {
  const result: PushResult = { sent: 0, removed: 0, failed: 0 }
  const { db, keys } = deps
  if (!keys) return result
  const rows = await listPushSubscriptions(db, userId)
  if (!rows.length) return result

  const send = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      title: clip(message.title, MAX_TITLE_CHARS),
      body: clip(message.body, MAX_BODY_CHARS),
      url: message.url,
    } satisfies PushMessage),
  )

  // One token per push service, not per subscription: it is bound to the
  // service's origin, and signing is the slow step.
  const tokens = new Map<string, Promise<string>>()
  const authorizationFor = (endpoint: string) => {
    const origin = new URL(endpoint).origin
    let token = tokens.get(origin)
    if (!token) {
      token = vapidAuthorization({ endpoint, ...keys, now: now().getTime() })
      tokens.set(origin, token)
    }
    return token
  }

  const outcomes = await Promise.all(
    rows.map(async (row): Promise<Outcome> => {
      const host = new URL(row.endpoint).hostname
      try {
        const body = await encryptPushPayload({
          plaintext,
          uaPublic: base64UrlToBytes(row.p256dh),
          authSecret: base64UrlToBytes(row.auth),
        })
        const response = await send(row.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await authorizationFor(row.endpoint),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(PUSH_TTL_SECONDS),
            Urgency: 'normal',
          },
          body,
        })
        await response.body?.cancel()

        if (response.ok) {
          await db
            .update(tables.pushSubscriptions)
            .set({ lastSuccessAt: now() })
            .where(eq(tables.pushSubscriptions.id, row.id))
          return 'sent'
        }
        // The browser unsubscribed, or the subscription expired. It never comes back.
        if (response.status === 404 || response.status === 410) {
          await db.delete(tables.pushSubscriptions).where(eq(tables.pushSubscriptions.id, row.id))
          return 'removed'
        }
        // The endpoint is a capability URL, so only its host is logged.
        logEvent('warn', 'push_rejected', { host, status: response.status })
        return 'failed'
      } catch (error) {
        logEvent('warn', 'push_failed', { host, error: String(error) })
        return 'failed'
      }
    }),
  )
  for (const outcome of outcomes) result[outcome] += 1
  return result
}
