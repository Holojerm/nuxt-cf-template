// First-touch attribution capture — client half.
//
// Records how this visitor first arrived, once, into a cookie that
// establishSession() reads when an account is created (server/utils/auth.ts).
// See shared/utils/attribution.ts for the classification rules and for why
// this is first-touch rather than last-touch.
//
// Client-only (`.client.ts`): it needs `document.referrer`, which does not
// exist during SSR. Running on the first landing is the whole point — by the
// time someone reaches /login the referrer is our own pricing page.
//
// ── Privacy posture ──────────────────────────────────────────────────────────
// One first-party cookie holding a channel name and the referring URL. No
// third party can read it, it is never used to build a profile, and it is not
// an advertising identifier. That said: several jurisdictions require consent
// for analytics cookies regardless of who sets them. If you operate somewhere
// that does, gate this plugin behind your consent banner — the app degrades to
// unattributed signups, which is exactly what you have today.

import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  nextAttributionCookie,
  parseAttribution,
  readAttributionCookie,
} from '#shared/utils/attribution'

export default defineNuxtPlugin(() => {
  const cookie = useCookie<string | null>(ATTRIBUTION_COOKIE, {
    maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
    path: '/',
    // Lax, not Strict: the OAuth callback is a top-level GET navigation from
    // the provider's origin, and Strict would withhold the cookie on exactly
    // the request that creates the account.
    sameSite: 'lax',
    secure: window.location.protocol === 'https:',
  })

  // First touch wins for the CHANNEL — a returning visitor already has the one
  // that introduced them, and overwriting it here is how attribution quietly
  // becomes "everyone came from Google". The one exception is a referral code
  // arriving on a cookie that has none, which is a hole rather than a competing
  // claim; nextAttributionCookie() owns that decision and explains it, and
  // returns null when there is nothing to write.
  const next = nextAttributionCookie(
    readAttributionCookie(cookie.value ?? undefined),
    parseAttribution({
      url: window.location.href,
      referrer: document.referrer,
      origin: window.location.origin,
    }),
  )

  if (next) cookie.value = JSON.stringify(next)
})
