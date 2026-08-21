// The shared tail of every sign-in: verify, provision, seal a session, and work
// out where the user was originally headed.
//
// Each provider handler (server/api/auth/github.get.ts, google.get.ts) does the
// provider-specific bit — decoding whatever shape that API returns — then hands
// a normalized profile here. Adding a provider should mean writing ~15 lines of
// mapping, not re-implementing sign-in.
//
// Two entry points, because the two callers need different responses:
//   establishSession()     → provisions + seals, returns data. Throws on refusal.
//   completeOAuthSignIn()  → wraps it in the 302s an OAuth callback must return.

import type { H3Event } from 'h3'
import type { OAuthProfile } from './users'

/** Cookie the login page sets before bouncing to a provider. */
export const REDIRECT_COOKIE = 'auth-redirect'

/**
 * Reduce a requested redirect to something safe to send a browser to.
 *
 * Only same-origin paths survive. `//evil.com` and `/\evil.com` are both parsed
 * as protocol-relative URLs by browsers, so a naive `startsWith('/')` check is
 * an open redirect — the classic way a login flow becomes a phishing launchpad:
 * send someone a link to YOUR login page, have it bounce them to a copy of it,
 * and the address bar was right up until the moment it wasn't.
 *
 * Backslashes matter because several browsers normalize `\` to `/` in URLs, so
 * `/\evil.com` reaches the network as `//evil.com`.
 *
 * Pure and exported so test/auth-redirect.test.ts can enumerate the bypasses.
 */
export function safeRedirectPath(raw: string | undefined, fallback = '/'): string {
  if (!raw) return fallback
  if (!raw.startsWith('/')) return fallback
  // Second character decides: a slash or backslash makes it protocol-relative.
  if (raw[1] === '/' || raw[1] === '\\') return fallback
  // A control character or whitespace can be used to smuggle a scheme past the
  // checks above once the browser strips it. Matching control characters is the
  // entire point here, hence the disable.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return fallback
  return raw
}

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
   * Did the provider confirm this address belongs to this person?
   *
   * Not optional, not defaulted to true. Email is the account key here
   * (server/utils/users.ts), so an unverified address is a takeover primitive:
   * claim the victim's address at a lax provider, sign in, inherit their
   * subscription. Every caller must answer this explicitly.
   */
  emailVerified: boolean
}

/**
 * Provision the user and issue the session cookie.
 *
 * Throws a 401 carrying a `data.code` the login page knows how to phrase.
 */
export async function establishSession(
  event: H3Event,
  { profile, emailVerified }: EstablishSessionOptions,
) {
  if (!profile.email) {
    console.warn(JSON.stringify({ kind: 'auth_no_email', provider: profile.provider }))
    throw createError({ statusCode: 401, message: 'No email address', data: { code: 'no_email' } })
  }

  if (!emailVerified) {
    console.warn(JSON.stringify({ kind: 'auth_unverified_email', provider: profile.provider }))
    throw createError({
      statusCode: 401,
      message: 'Email not verified',
      data: { code: 'unverified_email' },
    })
  }

  const { user, created } = await upsertOAuthUser(db, profile)

  await setUserSession(event, {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
    },
  })

  await captureServerEvent({
    distinctId: user.id,
    event: created ? 'user_signed_up' : 'user_signed_in',
    properties: { provider: profile.provider },
  })

  if (created) {
    // Awaited, not floated: Workers can tear down the isolate the moment the
    // response is sent, so a dangling promise here is a welcome email that
    // sometimes doesn't exist. sendEmail never throws.
    await sendEmail({ to: user.email, ...welcomeEmail(emailBranding(), { name: user.name }) })
  }

  return { user, created }
}

/**
 * The OAuth-callback flavour: same work, but every outcome is a redirect,
 * because the browser arrived here by following a 302 and expects another one.
 */
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
