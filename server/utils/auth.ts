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
import type { UserSession } from '#auth-utils'
import type { Attribution } from '#shared/utils/attribution'
import { ATTRIBUTION_COOKIE, readAttributionCookie } from '#shared/utils/attribution'
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
  /**
   * First-touch attribution to record if this call creates the account.
   *
   * Omit it — the normal case — and it is read from the `attr` cookie on THIS
   * request, which is correct for an OAuth callback: the browser that started
   * the flow is the browser that finishes it.
   *
   * Magic-link sign-in is the exception, and it is why this option exists. That
   * flow routinely finishes on a different device from the one that asked for
   * the link, where no `attr` cookie has ever been set, so it captures
   * attribution at mint time and hands it back here explicitly
   * (server/utils/magic-link.ts). Passing `null` asserts "there is none" and
   * suppresses the cookie fallback; leaving it `undefined` keeps the fallback.
   */
  attribution?: Attribution | null
}

/**
 * The exact top-level shape of a sealed session. See the note at its call site.
 *
 * Derived from `UserSession` rather than written out, so that adding a field
 * there without adding it below is a type error here rather than a silent
 * carry-over of the previous user's value. `id` is omitted because h3 owns it.
 */
export type SessionPayload = Omit<UserSession, 'id'>

/** The keys `buildSessionPayload` must write. Asserted by test/session-payload.test.ts. */
export const SESSION_PAYLOAD_KEYS = ['user', 'issuedAt'] as const

/**
 * Run something that happens AFTER the session cookie is sealed, and never let
 * it fail the sign-in.
 *
 * ── Why this is a function and not a bare try/catch ──────────────────────────
 * Because the rule it enforces is easy to state and easy to forget: once
 * `replaceUserSession` has run, the user IS signed in — but the caller is still
 * inside `completeOAuthSignIn`'s try/catch, which turns any throw into
 * `sign_in_failed`. On the magic-link path that is unrecoverable, because the
 * token was consumed one statement earlier: the person is told sign-in failed,
 * and their link is already spent.
 *
 * The welcome email is what sits there today, and it looked safe because
 * `sendEmail` never throws — but the two calls around it do. `isNotificationEnabled`
 * is a D1 read and `buildUnsubscribeUrl` is an HKDF derivation that throws on a
 * missing session password. Anything added to that tail in future gets the same
 * protection by being put inside this.
 */
export async function afterSignIn(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'after_sign_in_failed', label, error: String(error) }))
  }
}

/**
 * Build the whole session payload, every key written explicitly.
 *
 * Pure, and exported, for one reason: `replaceUserSession` shallow-merges over
 * the previous session rather than replacing it (the mechanism is written out
 * at the call site), so "every top-level key of `UserSession` is written here"
 * is a real invariant with a real failure mode — the previous account's value
 * surviving a sign-in on a shared browser. test/session-payload.test.ts asserts
 * the key set so adding a field to `UserSession` and forgetting this fails
 * loudly instead of silently.
 *
 * `issuedAt` is what makes revocation possible at all: a sealed cookie has no
 * server-side record to delete, so the only way to invalidate one is to date it
 * and compare against `users.sessions_invalid_before`. Seconds, matching the
 * resolution D1 stores timestamps at.
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

  // First-touch attribution, set on the visitor's first landing by
  // app/plugins/attribution.client.ts. Untrusted — readAttributionCookie()
  // parses it through a strict, length-capped Zod schema and returns null for
  // anything else, so a hand-crafted cookie can dirty one row's marketing
  // columns and nothing more.
  // The caller may have captured it earlier on a different device — see
  // `attribution` on EstablishSessionOptions.
  //
  // Read ONLY when the caller did not decide. There is no merging: a caller
  // that supplies attribution (the magic-link path) has already decided, and
  // topping it up from this request's cookie is how a shared browser credits a
  // stranger's referral link — see the note in
  // server/api/auth/magic-link/verify.post.ts.
  const attribution =
    providedAttribution !== undefined
      ? providedAttribution
      : readAttributionCookie(getCookie(event, ATTRIBUTION_COOKIE))

  const { user, created } = await upsertOAuthUser(db, profile, attribution)

  // Consumed — clearing it keeps a stale channel off the next account created
  // from this browser (shared machines, and every demo you ever give).
  if (created && attribution) deleteCookie(event, ATTRIBUTION_COOKIE, { path: '/' })

  // ── replaceUserSession does not, in fact, replace ──────────────────────────
  // Read the h3 source before trusting the name. `replaceUserSession` calls
  // `session.clear()` then `session.update(data)`. `clearSession` deletes the
  // cached session off `event.context` and queues an outgoing clear cookie — it
  // does not touch the INCOMING `Cookie` header. `update` then finds no cached
  // session, re-unseals the request's cookie, and shallow-merges `data` over
  // the old contents. So it is "shallow merge over whatever was there", one
  // level deep, and the only reason nothing leaks today is that the payload
  // below writes every top-level key of `UserSession`.
  //
  // That is the invariant to keep, and buildSessionPayload() exists to make it
  // checkable rather than remembered: add a key to `UserSession`
  // (app/types/auth.d.ts) without adding it here and the previous user's value
  // for it survives a sign-in. test/session-payload.test.ts pins the key set.
  //
  // It is still the right call over `setUserSession`, which deep-merges through
  // defu and additionally skips nulls — so a null avatarUrl would inherit the
  // previous account's picture rather than clearing it.
  await replaceUserSession(event, buildSessionPayload(user))

  await captureServerEvent({
    distinctId: user.id,
    event: created ? 'user_signed_up' : 'user_signed_in',
    properties: {
      provider: profile.provider,
      // Only on the signup event — attaching a channel to every subsequent
      // sign-in would make "signups by source" uncountable in PostHog.
      ...(created && attribution
        ? {
            signup_source: attribution.source,
            signup_medium: attribution.medium,
            signup_campaign: attribution.campaign,
          }
        : {}),
    },
  })

  // ── Nothing past the session write may fail the sign-in ────────────────────
  // The cookie is sealed by this point, so the user IS signed in — but the
  // caller is still inside a try/catch that turns a throw into `sign_in_failed`.
  // On the magic-link path that is unrecoverable: the token was consumed one
  // statement earlier, so the person is told sign-in failed and their link is
  // already spent. `sendEmail` never throws, but the two calls around it do:
  // `isNotificationEnabled` is a D1 read, and `buildUnsubscribeUrl` does an HKDF
  // derivation that throws on a missing session password. A welcome email is not
  // permitted to cost somebody their account.
  if (created) {
    await afterSignIn('welcome_email', async () => {
      // Welcome is the one optional email that exists today, so it's the one
      // wired through the preferences reader + List-Unsubscribe header. A
      // brand-new user can't have a preference row yet, so this check is
      // always true in practice — kept anyway so the next optional email added
      // here doesn't have to remember to add it.
      if (await isNotificationEnabled(db, user.id, 'welcome')) {
        const config = useRuntimeConfig(event)
        const unsubscribeUrl = await buildUnsubscribeUrl(
          config.sessionPassword,
          config.public.appUrl,
          user.id,
          'welcome',
        )
        // Awaited, not floated: Workers can tear down the isolate the moment the
        // response is sent, so a dangling promise here is a welcome email that
        // sometimes doesn't exist. sendEmail never throws.
        await sendEmail({
          to: user.email,
          ...welcomeEmail(emailBranding(), { name: user.name }),
          unsubscribe: { eventType: 'welcome', url: unsubscribeUrl },
        })
      }
    })
  }

  // ── The referee's half of the referral loop ────────────────────────────────
  // Only on a brand-new account that resolved a referral code moments ago
  // (upsertOAuthUser writes `referred_by` on the INSERT branch, and only when
  // the code named a real, live, other account).
  //
  // Inside afterSignIn for the reason that helper exists: the session cookie is
  // already sealed, so a throw here would tell someone sign-in failed while
  // they are, in fact, signed in — and on the magic-link path their token is
  // already spent. grantRefereeWelcome() never throws either; both guards are
  // deliberate, because free trial days are never worth an account creation.
  if (created && user.referredBy) {
    await afterSignIn('referral_welcome', async () => {
      // The welcome ref is a salted hash of the MAILBOX — that is what makes
      // the trial once-per-inbox instead of once-per-account, and therefore not
      // renewable by deleting and re-registering. Its salt is provisioned in D1
      // rather than configured (server/utils/identity.ts); `sessionPassword` is
      // passed for one job only, recognising refs minted under the previous
      // construction, and can be deleted with that check.
      await grantRefereeWelcome(db, user, {
        sessionPassword: useRuntimeConfig(event).sessionPassword,
      })
    })
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
