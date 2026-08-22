// /api/auth/apple — start + finish Sign in with Apple.
//
// Register this exact URL at developer.apple.com → Certificates, Identifiers &
// Profiles → Identifiers → your Services ID → Sign in with Apple → Configure →
// Return URLs:
//
//   https://<your-app>/api/auth/apple
//
// ── Why this file has no `.get` suffix, unlike github.get.ts ─────────────────
// Apple is the one provider here whose callback is not a GET. It only supports
// `response_mode=form_post` when `email` or `name` scope is requested, so the
// browser arrives back with a cross-site POST of
// `application/x-www-form-urlencoded`. A file named `apple.get.ts` would route
// the outbound leg and 405 the callback — with a stack trace that says nothing
// about response modes. The unsuffixed filename handles both methods, which is
// what defineOAuthAppleEventHandler expects (it branches on the content type
// internally).
//
// ── Credentials are not a client id and secret ───────────────────────────────
// Apple has no static client secret. The "secret" is a short-lived ES256 JWT the
// server signs per request from a .p8 private key, which is why the config here
// is four values (clientId = the Services ID, teamId, keyId, privateKey) rather
// than two. nuxt-auth-utils mints and signs that JWT; nothing in this repo has
// to. The private key is a real secret — `wrangler secret put`, never `[vars]`,
// and its literal newlines written as `\n` in the env var.
//
// ── NUXT_OAUTH_APPLE_REDIRECT_URL is required, unlike every other provider ───
// Not a preference. nuxt-auth-utils 0.5.30's Apple handler
// (dist/runtime/server/lib/oauth/apple.js) builds the outbound authorize URL
// with `config.redirectURL || getOAuthRedirectURL(event)` but then sends the
// RAW `config.redirectURL` in the token-exchange body — the google and github
// handlers fall back in both places. So with it unset the two legs disagree:
// the user reaches Apple, consents, comes back, and the exchange posts
// `redirect_uri=undefined`, which Apple answers with `invalid_grant`. Everything
// up to the final step looks perfect, which is what makes it expensive to
// diagnose. server/utils/auth-providers.ts therefore treats a missing redirect
// URL as "not configured" so the button never renders at all.
//
// ── Hide My Email is a real address, and a separate account ──────────────────
// Apple lets people sign in with a relay address (`…@privaterelay.appleid.com`)
// that forwards to their real inbox. Identity here is the verified email, so
// that relay address becomes the account key — and the same person signing in
// with Google tomorrow, on the address they actually read, lands on a *different*
// account. That is inherent to Sign in with Apple rather than something this
// file can fix; the fix, if a fork needs one, is an explicit "link another
// sign-in method" flow on the account page, not loosening the identity rule.
// Transactional mail still reaches them: Apple forwards it, provided the sending
// domain is registered in Apple's private email relay service.
//
// ── Known limitation: the post-sign-in redirect ──────────────────────────────
// The `auth-redirect` cookie the login page sets is SameSite=Lax, and a browser
// does not send Lax cookies on a cross-site POST — which is exactly what Apple's
// callback is. So an Apple sign-in that started from a deep link lands on
// /dashboard or / rather than back on that page. Documented rather than fixed:
// the alternative is relaxing that cookie to SameSite=None for every provider,
// which trades a real CSRF property for a redirect convenience on one of them.

import { z } from 'zod'

import { completeOAuthSignIn, redirectToLoginError } from '../../utils/auth'

/**
 * Apple sends the user's name exactly ONCE — on the very first authorization,
 * as a `user` field in the form post, and never again. Sign in, delete your
 * account row, sign in again, and it is gone for good.
 *
 * It also arrives as a JSON *string* inside urlencoded form data, even though
 * nuxt-auth-utils types it as an object. So it is parsed here rather than
 * trusted: this is attacker-shaped input on a POST body, and the flow must
 * survive it being absent, malformed, or a hostile value just as happily as it
 * survives the normal case.
 */
const appleUserSchema = z.object({
  name: z
    .object({
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).optional(),
    })
    .optional(),
})

function readAppleName(raw: unknown): string | null {
  const candidate = typeof raw === 'string' ? safeJsonParse(raw) : raw
  const parsed = appleUserSchema.safeParse(candidate)
  if (!parsed.success) return null
  const full = [parsed.data.name?.firstName, parsed.data.name?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim()
  return full || null
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Apple's `email_verified` claim, read rather than assumed.
 *
 * It has shipped as both a boolean and the string `"true"` over the life of the
 * API, and the difference is not cosmetic here: identity is the verified email
 * address (server/utils/users.ts), so `Boolean("false")` — which is `true` —
 * would turn a stringly-typed claim into an account-takeover primitive. Only the
 * two spellings of an affirmative pass; everything else, including `undefined`,
 * is a no.
 */
function isVerified(claim: unknown): boolean {
  return claim === true || claim === 'true'
}

export default defineOAuthAppleEventHandler({
  // Requesting `email` is what makes Apple use form_post at all, and the address
  // is the account key, so it is not optional. `name` is requested because the
  // first authorization is the only chance to get one.
  config: { scope: 'name email' },

  async onSuccess(event, { user, payload }) {
    return completeOAuthSignIn(event, {
      profile: {
        provider: 'apple',
        // The address comes from the verified id_token, not from the form body.
        // The `user` field is unsigned data the browser POSTed and could have
        // edited; the payload was signed by Apple and checked against their JWKS.
        email: payload.email ?? '',
        name: readAppleName(user),
        // Apple exposes no avatar. Nothing to map, and nothing to invent.
        avatarUrl: null,
      },
      emailVerified: isVerified(payload.email_verified),
    })
  },

  onError(event, error) {
    console.error(
      JSON.stringify({ kind: 'oauth_failed', provider: 'apple', message: error.message }),
    )
    return redirectToLoginError(event, 'provider_error')
  },
})
