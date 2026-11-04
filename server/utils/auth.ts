// The shared tail of every sign-in: verify, provision, seal a session, work out
// where the user was headed. Provider handlers (github.get.ts, google.get.ts)
// map their API's shape to a normalized profile and hand it here.
//   establishSession()     → provisions + seals, returns data. Throws on refusal.
//   completeOAuthSignIn()  → wraps it in the 302s an OAuth callback must return.

import type { H3Event } from 'h3'
import type { UserSession } from '#auth-utils'
import type { Attribution } from '#shared/utils/attribution'
import { ATTRIBUTION_COOKIE, readAttributionCookie } from '#shared/utils/attribution'
import { safeRedirectPath } from '#shared/utils/redirect'
import { getSignupContributors } from './signup-contributors'
import type { OAuthProfile } from './users'
import { logEvent } from './log'

/** Cookie the login page sets before bouncing to a provider. */
export const REDIRECT_COOKIE = 'auth-redirect'

/** Read-and-clear the redirect cookie the login page set, safely. */
export function popRedirectTarget(event: H3Event, fallback = '/'): string {
  const raw = getCookie(event, REDIRECT_COOKIE)
  deleteCookie(event, REDIRECT_COOKIE)
  return safeRedirectPath(raw, fallback)
}

/** Send the user back to /login with a code the page renders as a sentence. */
export function redirectToLoginError(event: H3Event, code: string) {
  return sendRedirect(event, `/login?error=${encodeURIComponent(code)}`)
}

interface EstablishSessionOptions {
  profile: OAuthProfile
  /**
   * Did the provider confirm this address belongs to this person? Not optional,
   * not defaulted: email is the account key, so an unverified address is a
   * takeover primitive (claim the victim's address at a lax provider, inherit
   * their subscription).
   */
  emailVerified: boolean
  /**
   * First-touch attribution to record if this call creates the account. Omit it
   * (OAuth: the browser that started the flow finishes it) and it is read from
   * the `attr` cookie. Magic-link finishes on another device, so it captures
   * attribution at mint time and passes it explicitly (server/utils/magic-link.ts);
   * `null` asserts "none" and suppresses the cookie fallback, `undefined` keeps it.
   */
  attribution?: Attribution | null
}

/**
 * The exact top-level shape of a sealed session, derived from `UserSession` so a
 * field added there but not to the payload is a type error, not a silent
 * carry-over of the previous user's value. `id` is h3's.
 */
export type SessionPayload = Omit<UserSession, 'id'>

/** The keys `buildSessionPayload` must write. Asserted by test/session-payload.test.ts. */
export const SESSION_PAYLOAD_KEYS = ['user', 'issuedAt'] as const

/**
 * Run something that happens AFTER the session cookie is sealed, and never let
 * it fail the sign-in. Once `replaceUserSession` has run the user IS signed in,
 * but the caller is still inside `completeOAuthSignIn`'s try/catch, which turns
 * a throw into `sign_in_failed`; on magic-link the token is already spent. Even
 * the welcome email can throw around `sendEmail` (`isNotificationEnabled` is a
 * D1 read, `buildUnsubscribeUrl` throws on a missing session password). Put
 * anything added to that tail inside this.
 */
export async function afterSignIn(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    logEvent('warn', 'after_sign_in_failed', { label, error: String(error) })
  }
}

/**
 * Build the whole session payload, every key written explicitly. Exported
 * because `replaceUserSession` shallow-merges over the previous session (see
 * the call site), so "every top-level key of `UserSession` is written here" is
 * an invariant; test/session-payload.test.ts asserts the key set. `issuedAt`
 * (seconds, D1's resolution) is what makes revocation possible: a sealed cookie
 * has no server record, so it is dated and compared against
 * `users.sessions_invalid_before`.
 */
export function buildSessionPayload(
  user: { id: string; email: string; name: string; avatarUrl: string | null; role: string },
  now: number = Date.now(),
): SessionPayload {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
    },
    issuedAt: Math.floor(now / 1000),
  }
}

/**
 * Provision the user and issue the session cookie.
 *
 * Throws a 401 carrying a `data.code` the login page knows how to phrase.
 */
export async function establishSession(
  event: H3Event,
  { profile, emailVerified, attribution: providedAttribution }: EstablishSessionOptions,
) {
  if (!profile.email) {
    logEvent('warn', 'auth_no_email', { provider: profile.provider })
    throw createError({ statusCode: 401, message: 'No email address', data: { code: 'no_email' } })
  }

  if (!emailVerified) {
    logEvent('warn', 'auth_unverified_email', { provider: profile.provider })
    throw createError({
      statusCode: 401,
      message: 'Email not verified',
      data: { code: 'unverified_email' },
    })
  }

  // The `attr` cookie is untrusted but parsed through a strict, length-capped
  // schema (null otherwise), so a forged one dirties one row's marketing
  // columns. Read ONLY when the caller did not decide: no merging, because
  // topping up a magic-link caller's attribution from this request's cookie is
  // how a shared browser credits a stranger's referral link (see
  // server/api/auth/magic-link/verify.post.ts).
  const attribution =
    providedAttribution !== undefined
      ? providedAttribution
      : readAttributionCookie(getCookie(event, ATTRIBUTION_COOKIE))

  const { user, created } = await upsertOAuthUser(db, profile, attribution)

  // Consumed: clear it so a stale channel does not reach the next account from this browser.
  if (created && attribution) deleteCookie(event, ATTRIBUTION_COOKIE, { path: '/' })

  // `replaceUserSession` does not replace: it calls `session.clear()` (which does
  // not touch the INCOMING Cookie header) then `session.update(data)`, which
  // re-unseals the request cookie and shallow-merges `data` over it. Nothing
  // leaks only because the payload writes every top-level key of `UserSession`
  // (app/types/auth.d.ts); buildSessionPayload() and
  // test/session-payload.test.ts keep that checkable. Still better than
  // `setUserSession`, which deep-merges via defu and skips nulls, so a null
  // avatarUrl would inherit the previous account's picture.
  await replaceUserSession(event, buildSessionPayload(user))

  await captureServerEvent({
    distinctId: user.id,
    event: created ? 'user_signed_up' : 'user_signed_in',
    properties: {
      provider: profile.provider,
      // Signup event only: on every sign-in, "signups by source" is uncountable.
      ...(created && attribution
        ? {
            signup_source: attribution.source,
            signup_medium: attribution.medium,
            signup_campaign: attribution.campaign,
          }
        : {}),
    },
  })

  // Nothing past the session write may fail the sign-in (see afterSignIn).
  if (created) {
    await afterSignIn('welcome_email', async () => {
      // Always true for a brand-new user; kept so the next optional email added here wires the same check.
      if (await isNotificationEnabled(db, user.id, 'welcome')) {
        const config = useRuntimeConfig(event)
        const unsubscribeUrl = await buildUnsubscribeUrl(
          config.sessionPassword,
          config.public.appUrl,
          user.id,
          'welcome',
        )
        // Awaited: Workers can tear down the isolate once the response is sent.
        await sendEmail({
          to: user.email,
          ...welcomeEmail(emailBranding(), { name: user.name }),
          unsubscribe: { eventType: 'welcome', url: unsubscribeUrl },
        })
      }
    })
  }

  // What features add to a new account (server/utils/signup-contributors.ts), each
  // inside afterSignIn for the reason that helper exists.
  if (created) {
    for (const contributor of getSignupContributors()) {
      const afterSignUp = contributor.afterSignUp
      if (!afterSignUp) continue
      await afterSignIn(contributor.afterSignUpLabel ?? contributor.key, () =>
        afterSignUp({ db, event, user }),
      )
    }
  }

  return { user, created }
}

/** The OAuth-callback flavour: every outcome is a redirect, since the browser followed a 302. */
export async function completeOAuthSignIn(event: H3Event, opts: EstablishSessionOptions) {
  let created: boolean
  try {
    ;({ created } = await establishSession(event, opts))
  } catch (error) {
    const code = (error as { data?: { code?: string } }).data?.code ?? 'sign_in_failed'
    return redirectToLoginError(event, code)
  }

  // New accounts land in the product; returning users go where they were going.
  return sendRedirect(event, popRedirectTarget(event, created ? '/dashboard' : '/'))
}
