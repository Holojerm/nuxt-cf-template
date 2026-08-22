// One-click List-Unsubscribe (RFC 8058) — token minting/verification, and the
// shared guts of GET/POST /api/email/unsubscribe.
//
// Web Crypto only (no node:crypto), same reasoning as server/utils/paddle.ts:
// it runs identically on Cloudflare Workers and in local dev.
//
// ── Why no new secret ─────────────────────────────────────────────────────
// CLAUDE.md is explicit that a new secret is a human gate — every fork of
// this template would have to go set one before this feature worked at all.
// `sessionPassword` is the one secret guaranteed to exist (nuxt-auth-utils
// refuses to boot without it), so the unsubscribe key is DERIVED from it via
// HKDF rather than reused as-is. HKDF's `info` parameter domain-separates
// this key from whatever nuxt-auth-utils derives from the same password for
// session sealing: a bug in one derivation can't be leveraged against the
// other, and an unsubscribe token — which, unlike a session cookie, is mailed
// out in plaintext links and sits in inboxes indefinitely — can't be turned
// into anything session-shaped even if one leaked.
//
// ── Verification shape ────────────────────────────────────────────────────
// Recompute-and-compare, not crypto.subtle.verify, to match the existing
// convention in server/utils/paddle.ts (hmacSha256Hex + timingSafeEqual)
// rather than introduce a second way of doing the same thing. The comparison
// is fixed-cost XOR accumulation over equal-length strings, not `===`, which
// short-circuits on the first differing byte and would leak how much of a
// guessed token was correct through response timing.

import { z } from 'zod'
import type { H3Event } from 'h3'
import {
  isMandatoryNotification,
  OPTIONAL_NOTIFICATION_EVENT_TYPES,
  type OptionalNotificationEventType,
} from '#shared/utils/notifications'
import type { NotificationDb } from './notifications'

const encoder = new TextEncoder()

const HKDF_INFO = 'nuxt-cf-template:email-unsubscribe:v1'
// A fixed salt is fine here: HKDF's salt is for domain separation, not
// secrecy — all the secret entropy is in sessionPassword.
const HKDF_SALT = 'email-unsubscribe'

async function deriveKey(sessionPassword: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(sessionPassword),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacBase64Url(sessionPassword: string, message: string): Promise<string> {
  const key = await deriveKey(sessionPassword)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return base64UrlEncode(signature)
}

/** Mirrors server/utils/paddle.ts's timingSafeEqual — same reasoning, same shape. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!
  return diff === 0
}

/**
 * Sign `userId|eventType`.
 *
 * Throws for a mandatory event type rather than warning-and-continuing like
 * sendEmail() does — deliberately the opposite policy. sendEmail must never
 * throw because by the time it runs, something more important than the email
 * is already mid-flight (a signup, a webhook that must return 200). Nothing
 * has happened yet when this function is called: no email has been sent, no
 * state committed. Throwing here is a fail-fast catch of what can only be a
 * programming error, with zero side effects to protect anyone from.
 */
export async function signUnsubscribeToken(
  sessionPassword: string,
  userId: string,
  eventType: OptionalNotificationEventType,
): Promise<string> {
  if (isMandatoryNotification(eventType)) {
    throw new Error(`refusing to sign an unsubscribe token for mandatory event type "${eventType}"`)
  }
  return hmacBase64Url(sessionPassword, `${userId}|${eventType}`)
}

/**
 * Verify a token against the userId/eventType claimed alongside it in the
 * URL. Never throws on malformed input — a forged or garbled token is exactly
 * the input this has to handle, since the caller on the other end is either a
 * mail provider's automated POST or a cold click with no session behind it.
 */
export async function verifyUnsubscribeToken(
  sessionPassword: string,
  userId: string,
  eventType: string,
  token: string,
): Promise<boolean> {
  const expected = await hmacBase64Url(sessionPassword, `${userId}|${eventType}`)
  return timingSafeEqual(expected, token)
}

/** Absolute unsubscribe link for an email footer / List-Unsubscribe header. */
export async function buildUnsubscribeUrl(
  sessionPassword: string,
  appUrl: string,
  userId: string,
  eventType: OptionalNotificationEventType,
): Promise<string> {
  const token = await signUnsubscribeToken(sessionPassword, userId, eventType)
  const base = appUrl.replace(/\/+$/, '')
  const params = new URLSearchParams({ u: userId, e: eventType, t: token })
  return `${base}/api/email/unsubscribe?${params.toString()}`
}

/** Query shape both unsubscribe.get.ts and unsubscribe.post.ts validate against. */
export const unsubscribeQuerySchema = z.object({
  u: z.string().trim().min(1).max(64),
  e: z.enum(OPTIONAL_NOTIFICATION_EVENT_TYPES),
  t: z.string().trim().min(1).max(512),
})

/**
 * Shared guts of GET and POST /api/email/unsubscribe: validate the query,
 * verify the token, and record the opt-out.
 *
 * Both HTTP verbs perform the SAME write. GET is not treated as a safe
 * preview here on purpose — the realistic caller on GET is a human clicking
 * the plain-text link in an email's footer (always a GET; it's an `<a href>`),
 * not a crawler or link-unfurler that would make "GET has side effects" a
 * real problem. POST is what mail providers use for RFC 8058's one-click
 * button, with no page load and no session either.
 */
export async function resolveUnsubscribeRequest(
  event: H3Event,
  db: NotificationDb,
): Promise<{ userId: string; eventType: OptionalNotificationEventType }> {
  const {
    u: userId,
    e: eventType,
    t: token,
  } = await getValidatedQuery(event, unsubscribeQuerySchema.parse)

  const sessionPassword = useRuntimeConfig(event).sessionPassword
  const valid = await verifyUnsubscribeToken(sessionPassword, userId, eventType, token)
  if (!valid) {
    throw createError({ statusCode: 400, message: 'Invalid or expired unsubscribe link' })
  }

  await setNotificationPreference(db, userId, eventType, false)
  return { userId, eventType }
}
