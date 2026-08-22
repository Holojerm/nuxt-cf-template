// One-click List-Unsubscribe (RFC 8058) — token minting/verification, and the
// shared guts of GET/POST /api/email/unsubscribe.
//
// Web Crypto only (no node:crypto), same reasoning as server/utils/paddle.ts:
// it runs identically on Cloudflare Workers and in local dev.
//
// ── Why no new secret ─────────────────────────────────────────────────────
// .claude/docs/billing.md is explicit that a new secret is a human gate — every fork of
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
import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import {
  isMandatoryNotification,
  OPTIONAL_NOTIFICATION_EVENT_TYPES,
  type OptionalNotificationEventType,
} from '#shared/utils/notifications'
import * as tables from '../db/schema'
import type { NotificationDb } from './notifications'
import { base64url, timingSafeEqual } from './hash'
import { isUndeliverableAddress } from './users'

const encoder = new TextEncoder()

const HKDF_INFO = 'nuxt-cf-template:email-unsubscribe:v1'
// A fixed salt is fine here: HKDF's salt is for domain separation, not
// secrecy — all the secret entropy is in sessionPassword.
const HKDF_SALT = 'email-unsubscribe'

/**
 * Derived keys, memoised per isolate and keyed by the password they came from.
 *
 * HKDF is two Web Crypto calls, and this function ran on every unsubscribe
 * verification and every welcome email — the derivation is deterministic, so
 * repeating it buys nothing. Keyed by password rather than cached as a single
 * value so a config change (or a test driving two secrets) can never be served
 * the wrong key, which is the failure a naive one-slot cache would have.
 *
 * A Map with no eviction is safe here only because the key space is "the
 * deployment's session password": one entry in production, a handful in tests.
 */
const derivedKeys = new Map<string, Promise<CryptoKey>>()

function deriveKey(sessionPassword: string): Promise<CryptoKey> {
  const cached = derivedKeys.get(sessionPassword)
  if (cached) return cached
  const promise = deriveKeyUncached(sessionPassword)
  derivedKeys.set(sessionPassword, promise)
  return promise
}

async function deriveKeyUncached(sessionPassword: string): Promise<CryptoKey> {
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

async function hmacBase64Url(sessionPassword: string, message: string): Promise<string> {
  const key = await deriveKey(sessionPassword)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return base64url(signature)
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
  const { u: userId, e: eventType, t: token } = await readUnsubscribeParams(event)

  const sessionPassword = useRuntimeConfig(event).sessionPassword
  const valid = await verifyUnsubscribeToken(sessionPassword, userId, eventType, token)
  if (!valid) {
    throw createError({ statusCode: 400, message: 'Invalid or expired unsubscribe link' })
  }

  return { userId, eventType, token }
}

/**
 * Body first, query second — both are legitimate, and that is why this widens
 * rather than moves.
 *
 * The signed token is a credential, and Cloudflare's edge records the request
 * URI of every request upstream of anything this Worker can redact. So the
 * confirmation page POSTs a JSON body. But the query form cannot go away: RFC
 * 8058 puts the parameters in the `List-Unsubscribe` URL, and a mail provider's
 * one-click button POSTs that URL with a fixed `List-Unsubscribe=One-Click`
 * body of its own — and the footer link a human clicks is a GET with nowhere
 * else to put them.
 *
 * `safeParse` on the body rather than a method check, precisely because of that
 * one-click body: it parses fine as a body and validates as nothing, so the
 * fallback has to be driven by whether the parameters are THERE, not by which
 * verb was used.
 */
async function readUnsubscribeParams(event: H3Event) {
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    const body = await readBody(event).catch(() => null)
    const parsed = unsubscribeQuerySchema.safeParse(body)
    if (parsed.success) return parsed.data
  }
  return getValidatedQuery(event, unsubscribeQuerySchema.parse)
}

/**
 * Authenticate, check the account is still live, then record the opt-out.
 *
 * ── Why the liveness check ───────────────────────────────────────────────────
 * The unsubscribe token is an HMAC over `userId|eventType` with no expiry — it
 * is valid forever, by design, because a link sitting in a two-year-old email
 * should still work. Combined with deletion anonymizing the `users` row in
 * place, that meant replaying any old link for a deleted account INSERTED a
 * fresh `notification_preferences` row against the tombstone's id: data
 * recreated for an account whose whole point is that its data is gone, and a
 * row that would then have to be cleaned up by a deletion that already ran.
 *
 * Refused with the same response as success, for the same reason every other
 * public endpoint here does: answering differently would turn a never-expiring
 * token into an oracle for "was this account deleted?".
 *
 * One indexed read, on a path taken a handful of times per user per year.
 */
export async function applyUnsubscribeRequest(
  event: H3Event,
  db: NotificationDb,
): Promise<{ userId: string; eventType: OptionalNotificationEventType }> {
  const { userId, eventType } = await authenticateUnsubscribeRequest(event)

  // Deliberately not checkSession(): that answers "may this SESSION act", and
  // its `undated` refusal — a session that cannot prove it postdates a
  // revocation — has no meaning for a link that is not a session. The question
  // here is only whether the account still exists.
  const user = await db.query.users.findFirst({
    where: eq(tables.users.id, userId),
    columns: { email: true },
  })

  if (!user || isUndeliverableAddress(user.email)) {
    console.warn(
      JSON.stringify({ kind: 'unsubscribe_refused', reason: user ? 'deleted' : 'no_account' }),
    )
    return { userId, eventType }
  }

  await setNotificationPreference(db, userId, eventType, false)
  return { userId, eventType }
}
