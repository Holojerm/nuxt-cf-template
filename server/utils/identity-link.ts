// "Link another sign-in method": a signed-in person attaches a provider account
// to the account they are in, from /account.
//
// ── How the callback knows it is a link, and for whom ────────────────────────
// The provider callback is the same URL as sign-in (it is the one registered
// with the provider), so the request itself cannot say "link". The session
// cannot say it either: Apple's callback is a cross-site form POST, and the
// session cookie is SameSite=Lax, so it never arrives there.
//
// So POST /api/account/identities/link, which only a session can reach, sets a
// short-lived signed cookie naming the session's user, the provider, and the
// session's issue time. It is SameSite=None so it survives Apple's POST, and
// scoped to /api/auth/ so nothing else ever receives it. The callback reads and
// deletes it, and attaches the provider account to the user it names, never to
// an account found by email.
//
// ── Why a SameSite=None cookie is safe here ──────────────────────────────────
// A None cookie rides along on cross-site requests, so it proves nothing by
// itself about who sent the request. What does is nuxt-auth-utils' OAuth state
// check: the callback is accepted only with the provider's code AND a `state`
// equal to the random, HttpOnly `nuxt-auth-state` cookie this browser was given
// when it set out. A forged cross-site callback has neither. The intent cookie
// only answers "which user", and it is signed, so it cannot be edited to name
// another user, and it cannot be set from another site at all.
//
// It is also dated: it dies after ten minutes, with the session it came from
// (sign out everywhere, account deletion: server/utils/session-guard.ts), on
// sign-out, and when any plain sign-in starts in the same browser
// (server/utils/oauth-callback.ts), so an abandoned link cannot attach the next
// person's provider account to the first person's account.
//
// The cookie outlives the intent it carries (an hour against ten minutes), so a
// link that took too long comes back with a dead intent rather than no cookie.
// The callback can then say "expired" instead of treating the return as a plain
// sign-in, which for a hidden Apple address would create a second account.

import type { H3Event } from 'h3'
import type { ExtensionDb as Db } from './extensions'
import { base64url, timingSafeEqual } from './hash'
import { checkSession } from './session-guard'
import { hmacBase64Url } from './unsubscribe'
import { linkIdentity } from './user-identities'
import type { IdentityRef, LinkOutcome } from './user-identities'

export const IDENTITY_LINK_COOKIE = 'identity-link'
export const IDENTITY_LINK_TTL_SECONDS = 10 * 60
const COOKIE_MAX_AGE_SECONDS = 60 * 60
const COOKIE_PATH = '/api/auth/'

export interface LinkIntent {
  userId: string
  provider: string
  /** The starting session's `issuedAt`, so revoking that session voids the link. */
  issuedAt?: number
  /** Unix seconds. */
  expiresAt: number
}

const message = (body: string) => `identity-link|${body}`

export async function signLinkIntent(sessionPassword: string, intent: LinkIntent) {
  const body = base64url(new TextEncoder().encode(JSON.stringify(intent)))
  return `${body}.${await hmacBase64Url(sessionPassword, message(body))}`
}

/** The intent, if `raw` is untampered, unexpired and for `provider`. Never throws. */
export async function verifyLinkIntent(
  sessionPassword: string,
  raw: string | undefined,
  provider: string,
  now: number = Date.now(),
): Promise<LinkIntent | null> {
  if (!raw || !sessionPassword) return null
  const [body, signature, extra] = raw.split('.')
  if (!body || !signature || extra !== undefined) return null
  if (!timingSafeEqual(signature, await hmacBase64Url(sessionPassword, message(body)))) return null

  let intent: LinkIntent
  try {
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
    intent = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
  if (typeof intent?.userId !== 'string' || intent.provider !== provider) return null
  if (typeof intent.expiresAt !== 'number' || intent.expiresAt * 1000 <= now) return null
  return intent
}

export async function setLinkIntentCookie(
  event: H3Event,
  sessionPassword: string,
  intent: Omit<LinkIntent, 'expiresAt'>,
) {
  const expiresAt = Math.floor(Date.now() / 1000) + IDENTITY_LINK_TTL_SECONDS
  setCookie(
    event,
    IDENTITY_LINK_COOKIE,
    await signLinkIntent(sessionPassword, { ...intent, expiresAt }),
    {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: COOKIE_PATH,
      maxAge: COOKIE_MAX_AGE_SECONDS,
    },
  )
}

export function hasLinkIntentCookie(event: H3Event): boolean {
  return Boolean(getCookie(event, IDENTITY_LINK_COOKIE))
}

export function clearLinkIntentCookie(event: H3Event) {
  deleteCookie(event, IDENTITY_LINK_COOKIE, { path: COOKIE_PATH, secure: true, sameSite: 'none' })
}

/**
 * Read and clear: an intent is good for one callback, whatever happens in it.
 *
 * `null` means no link was under way, so the callback is a sign-in. `'invalid'`
 * means one was (the cookie came back) but its intent is expired, tampered with
 * or for another provider: the callback must refuse, never sign in instead.
 */
export async function takeLinkIntent(
  event: H3Event,
  sessionPassword: string,
  provider: string,
): Promise<LinkIntent | 'invalid' | null> {
  const raw = getCookie(event, IDENTITY_LINK_COOKIE)
  if (!raw) return null
  clearLinkIntentCookie(event)
  return (await verifyLinkIntent(sessionPassword, raw, provider)) ?? 'invalid'
}

export type LinkAttempt = LinkOutcome | { outcome: 'expired' }

/**
 * Attach the provider account to the intent's user.
 *
 * `sessionUserId` is the session cookie's user when it arrived (Google and
 * GitHub return with a top-level GET, so it does; Apple's POST does not). A
 * different user there means the browser changed hands mid-link: refuse.
 */
export async function attachLinkedIdentity(
  db: Db,
  intent: LinkIntent,
  ref: IdentityRef,
  sessionUserId?: string | null,
): Promise<LinkAttempt> {
  if (sessionUserId && sessionUserId !== intent.userId) return { outcome: 'expired' }
  const verdict = await checkSession(db, { userId: intent.userId, issuedAt: intent.issuedAt })
  if (!verdict.valid) return { outcome: 'expired' }
  return linkIdentity(db, intent.userId, ref)
}
