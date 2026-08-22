// Every way sign-in can fail, phrased once.
//
// Sign-in failures reach the browser as a short `code`, never as a message: the
// codes travel in a query string (`/login?error=…`) after a provider redirect,
// and in `data.code` on a thrown API error. A raw server message in either place
// is both a bad sentence and an information leak.
//
// The map lives here rather than inside /login because two pages render the same
// codes — /login and /auth/verify — and two copies of user-facing wording drift
// within a release. Auto-imported (app/utils).
//
// Rules for the wording: name what happened, then what to do about it, and never
// blame the reader. None of these say "invalid" at a person.

export const AUTH_ERROR_FALLBACK = 'sign_in_failed'

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  // ── OAuth providers ────────────────────────────────────────────────────────
  no_email: "That provider didn't share an email address, so we can't create an account.",
  unverified_email:
    'That email address is unverified. Verify it with your provider, then try again.',
  provider_error: "The sign-in provider returned an error. That's usually temporary — try again.",

  // ── Magic links ────────────────────────────────────────────────────────────
  // Three separate sentences rather than one shrug, because the right next move
  // differs: an expired link needs a new one, a used link often means it already
  // worked in another tab, and an unrecognised one usually means a mail client
  // mangled the URL.
  link_expired: 'That sign-in link has expired. Links last 15 minutes — request a new one.',
  link_used: 'That sign-in link has already been used. Request a new one to sign in again.',
  link_invalid: "We don't recognise that sign-in link. Request a new one and open it directly.",
  email_unavailable:
    "We couldn't send the email just now. Try again in a moment, or use another sign-in option.",
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',

  [AUTH_ERROR_FALLBACK]: 'Something went wrong signing you in. Try again.',
}

/**
 * Turn a code into a sentence. Returns null when there is no error to show, so
 * a template can `v-if` on it directly.
 *
 * Unknown codes fall back rather than rendering the code itself — a page that
 * prints `?error=<script>` at the reader is the whole reason this is a lookup.
 */
export function authErrorMessage(code: unknown): string | null {
  if (typeof code !== 'string' || !code) return null
  return AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_MESSAGES[AUTH_ERROR_FALLBACK] ?? null
}

/**
 * Pull the `code` out of a thrown $fetch error.
 *
 * The double `.data` is not a typo: ofetch puts the response body on
 * `error.data`, and `createError({ data })` on the server nests our payload
 * inside that body under `data` again.
 */
export function authErrorCode(error: unknown): string {
  return (error as { data?: { data?: { code?: string } } })?.data?.data?.code ?? AUTH_ERROR_FALLBACK
}
