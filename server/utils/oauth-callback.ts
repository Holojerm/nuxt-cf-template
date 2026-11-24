// What every provider handler (server/api/auth/<provider>) calls, so a callback
// is either a sign-in or a link and never both (server/utils/identity-link.ts).
//
//   withLinkAwareStart()  wraps the handler: a plain sign-in start voids any
//                         pending link in this browser.
//   finishOAuth()         onSuccess: link when a valid intent for this provider
//                         came back, sign in otherwise.
//   failOAuth()           onError: back to whichever page started it.

import type { H3Event } from 'h3'
import type { RequestEvent } from 'nuxt/server'
import { writeAudit } from './audit'
import { afterSignIn, completeOAuthSignIn, redirectToLoginError } from './auth'
import {
  attachLinkedIdentity,
  clearLinkIntentCookie,
  hasLinkIntentCookie,
  takeLinkIntent,
} from './identity-link'
import { logEvent } from './log'
import { h3Event } from './request-event'
import type { OAuthProfile } from './users'

/** The query flag POST /api/account/identities/link adds to the start URL. */
export const LINK_START_PARAM = 'link'

interface FinishOAuthOptions {
  /** `subject` is what a link attaches; without one a link is refused. */
  profile: OAuthProfile
  emailVerified: boolean
}

/**
 * The outbound leg is a GET with no `code`. Started from /login (no `?link=1`)
 * it is a sign-in, so a link intent left over from an abandoned attempt is
 * dropped before this browser can come back carrying someone else's account.
 */
export function withLinkAwareStart<T extends (event: RequestEvent) => unknown>(handler: T): T {
  return ((event: RequestEvent) => {
    const h3 = h3Event(event)
    const query = getQuery(h3)
    if (h3.method === 'GET' && !query.code && query[LINK_START_PARAM] !== '1') {
      if (hasLinkIntentCookie(h3)) clearLinkIntentCookie(h3)
    }
    return handler(event)
  }) as T
}

export async function finishOAuth(event: H3Event, { profile, emailVerified }: FinishOAuthOptions) {
  const password = useRuntimeConfig(event).sessionPassword
  const intent = await takeLinkIntent(event, password, profile.provider)
  if (!intent) return completeOAuthSignIn(event, { profile, emailVerified })
  if (!profile.subject) return sendRedirect(event, '/account?link_error=provider_error')

  // A link proves ownership through the session, not the address, so the
  // email's verification does not matter here; a hidden address is fine.
  const session = await getUserSession(event)
  const result = await attachLinkedIdentity(
    db,
    intent,
    { provider: profile.provider, subject: profile.subject, email: profile.email },
    session.user?.id ?? null,
  )

  if (result.outcome === 'expired') return redirectToLoginError(event, 'link_session_expired')
  if (result.outcome === 'taken') {
    logEvent('warn', 'identity_link_taken', { provider: profile.provider })
    return sendRedirect(event, '/account?link_error=taken')
  }
  if (result.outcome === 'linked') {
    // After the insert, and never able to fail it: the row is what was asked for.
    await afterSignIn('identity_link_audit', async () => {
      await writeAudit(db, {
        actorUserId: intent.userId,
        actorType: 'user',
        action: 'account.identity_linked',
        targetType: 'user',
        targetId: intent.userId,
        metadata: { provider: profile.provider },
      })
    })
  }
  return sendRedirect(event, `/account?linked=${encodeURIComponent(profile.provider)}`)
}

export function failOAuth(event: H3Event, provider: string, error: { message: string }) {
  logEvent('error', 'oauth_failed', { provider, message: error.message })
  if (hasLinkIntentCookie(event)) {
    clearLinkIntentCookie(event)
    return sendRedirect(event, '/account?link_error=provider_error')
  }
  return redirectToLoginError(event, 'provider_error')
}
