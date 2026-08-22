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
 * Parse and authenticate an unsubscribe request. Writes nothing.
 *
 * ── Why this is split from the write ─────────────────────────────────────────
 * This URL lives in inbound email, which is the one place in the world where
 * every link is fetched by a machine before a human sees it. Defender Safe
 * Links, Proofpoint, and Mimecast GET every URL in a message on delivery — the
 * exact hazard the magic-link flow is built around (see
 * server/api/auth/magic-link/verify.get.ts). A GET that performed the opt-out
 * meant a corporate mail gateway silently unsubscribed people from mail they
 * had asked for, and the only evidence would be a preference row nobody set.
 *
 * So the GET authenticates and hands off to a confirmation page, and the POST
 * — which is both RFC 8058's one-click path and that page's button — writes.
 * The friction argument that used to justify the GET writing still holds for
 * the case it was about: Gmail and Yahoo's own Unsubscribe button POSTs, so the
 * one-click experience those rules are written about is untouched.
 */
export async function authenticateUnsubscribeRequest(
  event: H3Event,
): Promise<{ userId: string; eventType: OptionalNotificationEventType; token: string }> {
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

  return { userId, eventType, token }
}

/** Authenticate, then record the opt-out. The POST half of the pair above. */
export async function applyUnsubscribeRequest(
  event: H3Event,
  db: NotificationDb,
): Promise<{ userId: string; eventType: OptionalNotificationEventType }> {
  const { userId, eventType } = await authenticateUnsubscribeRequest(event)
  await setNotificationPreference(db, userId, eventType, false)
  return { userId, eventType }
}
