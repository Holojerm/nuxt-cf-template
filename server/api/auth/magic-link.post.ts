// POST /api/auth/magic-link — "email me a link to sign in".
//
// The consumer front door. It is also the sign-UP door: an address with no
// account gets a link that creates one when opened, which is why nothing here
// looks a user up first.
//
// Lives under /api/auth/ (no underscore), which server/middleware/auth.ts
// allowlists and rate-limits at 30/min per IP — no session exists yet, so the
// guard must not run.
//
// ── Identical response, always ───────────────────────────────────────────────
// Known address or not, this returns the same body with the same status. An
// endpoint that answered differently would be an account-enumeration oracle:
// point a script at a leaked address list and learn who has an account here,
// which is the raw material for credential-stuffing and for targeted phishing
// ("your <this app> subscription has a billing problem"). The cost of the
// property is that a typo'd address gets no feedback, which the page handles by
// saying "if that address has an account…" rather than "sent".
//
// ── Sending mail on an anonymous caller's say-so ─────────────────────────────
// This endpoint puts mail from a domain the recipient trusts into an inbox that
// the sender chose. Three things keep that from being a weapon, and they answer
// different questions: the per-IP limit in the middleware and the per-address
// limit below both answer "how fast" (see MAGIC_LINK_RATE_LIMIT for why the
// second is the load-bearing half), while Turnstile answers "is there a browser
// here at all". The challenge runs before either limiter is charged — the note
// in the handler explains why that ordering is not cosmetic.

import { z } from 'zod'

// Everything from server/utils is imported by path rather than left to Nitro's
// auto-import. The auto-import typechecks everywhere and is not always injected
// at runtime (CLAUDE.md › Gotchas), and on this route a symbol resolving to
// `undefined` would be a sign-in that silently stops working.
import { ATTRIBUTION_COOKIE, readAttributionCookie } from '#shared/utils/attribution'
import { REDIRECT_COOKIE, safeRedirectPath } from '../../utils/auth'
import { magicLinkEmail } from '../../utils/auth-email-templates'
import { sendEmail } from '../../utils/email'
import { emailBranding } from '../../utils/email-templates'
import { kv } from '@nuxthub/kv'
import { saltedHash } from '../../utils/hash'
import {
  createMagicLinkToken,
  discardMagicLinkToken,
  MAGIC_LINK_RATE_LIMIT,
  MAGIC_LINK_TTL_SECONDS,
} from '../../utils/magic-link'
import { consumeRateLimit } from '../../utils/rate-limit'
import { requireTurnstile, turnstileTokenSchema } from '../../utils/turnstile'
import {
  canonicalizeEmailForLimiting,
  isUndeliverableAddress,
  normalizeEmail,
} from '../../utils/users'

const bodySchema = z.object({
  // 254 is the RFC 5321 ceiling for a whole address. Capped before the address
  // reaches a KV key or a database column.
  email: z.string().trim().email().max(254),
  // Optional here, required by requireTurnstile() only once a secret key is
  // configured. Optionality belongs in the schema and the decision belongs in
  // the util: a `.min(1)` here would make an unconfigured fork's sign-in form
  // 400 on a field it never rendered.
  turnstileToken: turnstileTokenSchema.nullish(),
})

/**
 * Has this mailbox had its share of links for now?
 *
 * ── Why this does not use rateLimit() ────────────────────────────────────────
 * The H3 wrapper is the right tool for the per-IP limit in the middleware and
 * the wrong one here, for two reasons that both leak information about somebody
 * else's account:
 *
 *   * It sets `X-RateLimit-Remaining` on the response. Keyed by ADDRESS, that
 *     header answers "is this person in the middle of signing in right now?"
 *     for anyone willing to POST their address — an activity oracle on a
 *     stranger, from an unauthenticated endpoint.
 *   * It throws 429. A distinguishable response for a distinguishable address
 *     is the enumeration hole the identical-response rule exists to close, and
 *     it also hands an attacker confirmation that their lockout landed.
 *
 * So the budget is consumed through the pure counter, which sets no headers,
 * and exhaustion is reported to the caller as an ordinary success. The person
 * being targeted still gets no unwanted mail; the attacker learns nothing and
 * cannot tell a locked-out address from a fresh one. It costs the honest user
 * who exhausts their own budget an email that never arrives, which is what a
 * rate limit costs anyway.
 *
 * ── Two buckets, because one address has many spellings ──────────────────────
 * `victim+1@gmail.com` … `+9999` are thousands of distinct strings that all
 * land in one inbox, so a limiter keyed on the exact address is one an attacker
 * walks around by incrementing a counter while every message still arrives.
 * Both the canonical mailbox and the exact address are charged, so
 * sub-addressing cannot widen the budget — and identity stays on the exact
 * address, because collapsing it would merge two strangers' accounts (see
 * canonicalizeEmailForLimiting).
 *
 * Fails OPEN, like rateLimit() itself: a KV outage must not take the front door
 * down with it.
 */
async function addressBudgetExhausted(email: string, salt: string): Promise<boolean> {
  const spellings = [...new Set([canonicalizeEmailForLimiting(email), email])]

  try {
    // In parallel, not in sequence. The two buckets are independent and BOTH
    // are charged on every request — a short-circuit would only skip the second
    // charge in the case where the first already refused, which is the case
    // that returns `true` anyway. Sequential, this was two KV round trips of
    // latency on the critical path of every sign-in for no behavioural gain.
    const verdicts = await Promise.all(
      spellings.map(async (spelling) => {
        // Hashed, not raw: KV keys are readable in the Cloudflare dashboard and
        // land in log lines, and "which addresses asked for a sign-in link" is
        // not something this app needs to publish in order to run.
        const identifier = (await saltedHash(spelling, salt)) ?? spelling
        return consumeRateLimit(kv, {
          key: `${MAGIC_LINK_RATE_LIMIT.name}:${identifier}`,
          limit: MAGIC_LINK_RATE_LIMIT.limit,
          windowSeconds: MAGIC_LINK_RATE_LIMIT.windowSeconds,
        })
      }),
    )
    if (verdicts.some((verdict) => !verdict.allowed)) return true
  } catch (error) {
    console.warn(
      JSON.stringify({
        kind: 'rate_limit_unavailable',
        name: MAGIC_LINK_RATE_LIMIT.name,
        error: String(error),
      }),
    )
    return false
  }

  return false
}

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)

  // ── The bot check runs FIRST, and the ordering is the security property ─────
  // Not "before the mail" — before the per-address budget is *charged*. That
  // budget is the load-bearing limit on this endpoint, and it is keyed by
  // somebody else's mailbox: a script that can spend it without solving a
  // challenge can lock a named victim out of their own sign-in for the window,
  // five requests at a time, and never send a single email in the process. The
  // limiter becomes the attack. Put the challenge behind it and that is exactly
  // what ships.
  //
  // Also before normalizeEmail(), so no address-dependent work happens at all
  // until the caller is established as a browser. The identical-response rule
  // below is unaffected: this 400 is decided entirely by the token, is the same
  // for every address including malformed ones, and tells an attacker only that
  // they failed a challenge they can see themselves failing.
  //
  // No-ops entirely without NUXT_TURNSTILE_SECRET_KEY — see
  // server/utils/turnstile.ts. An unconfigured fork's sign-in is unchanged.
  await requireTurnstile(event, body.turnstileToken)

  const email = normalizeEmail(body.email)
  const config = useRuntimeConfig(event)

  // ── Everything below answers `{ ok: true }` ────────────────────────────────
  // Three reasons a link is not sent, none of them distinguishable from a link
  // that was. Each is logged, because the operator does need to know.

  // 1. Reserved addresses — in practice the `deleted-<id>@deleted.invalid`
  //    tombstone a deleted account's row is rewritten to. Minting for one is an
  //    account-resurrection primitive; see isUndeliverableAddress().
  if (isUndeliverableAddress(email)) {
    console.warn(JSON.stringify({ kind: 'magic_link_reserved_address_refused' }))
    return { ok: true }
  }

  // 2. This mailbox has had its five links for the quarter hour.
  if (await addressBudgetExhausted(email, config.sessionPassword)) {
    console.warn(JSON.stringify({ kind: 'magic_link_address_budget_exhausted' }))
    return { ok: true }
  }

  // Both of these live in cookies on THIS browser and are captured now, because
  // the link may well be opened on another device where neither exists. See the
  // note on `magic_link_tokens` in server/db/schema.ts.
  const redirectTo = safeRedirectPath(getCookie(event, REDIRECT_COOKIE), '')
  const attribution = readAttributionCookie(getCookie(event, ATTRIBUTION_COOKIE))

  const { token, record } = await createMagicLinkToken(db, { email, redirectTo, attribution })

  const brand = emailBranding()
  // Two deliberate choices in one line.
  //
  // The link points at a *page*, not at this API: that page's button is what
  // spends the token — see server/api/auth/magic-link/verify.get.ts for why a
  // link that signs you in by being fetched is a link a mail scanner can spend.
  //
  // And the token rides in the FRAGMENT, not the query string. A fragment is
  // the one part of a URL a browser never transmits: it appears in no access
  // log, no Referer header, no reverse proxy, and no CDN trace. With `?token=`
  // the live credential was written to Cloudflare Logs on every visit and
  // forwarded to PostHog as a same-origin `Referer` — readable by everyone with
  // analytics access, for the whole fifteen-minute window, before the user had
  // clicked anything. The page reads it client-side, which it was already doing.
  const url = `${brand.appUrl}/auth/verify#token=${encodeURIComponent(token)}`

  const result = await sendEmail({
    to: email,
    ...magicLinkEmail(brand, { url, expiresMinutes: MAGIC_LINK_TTL_SECONDS / 60 }),
  })

  if (!result.sent) {
    // sendEmail() never throws, precisely because its usual callers are more
    // important than the mail. Here the mail IS the request, so the one thing
    // this must not do is swallow every failure and answer "check your inbox".
    //
    // `import.meta.dev` is replaced with a literal at build time — the same
    // guard server/api/auth/dev.post.ts relies on, with the same runtime
    // backstop under it — so the branch below is dead code a production bundle
    // drops rather than a check that could be reached.
    if (import.meta.dev && process.env.NODE_ENV !== 'production') {
      // The whole point of the template running without a Resend account:
      // `git clone && bun dev` can still exercise this flow end to end by
      // clicking the URL out of the dev server's log.
      console.info(JSON.stringify({ kind: 'magic_link_dev', reason: result.reason, url }))
      return { ok: true }
    }

    // Nobody will ever hold this token, so the row is a lie about a live link.
    await discardMagicLinkToken(db, record.id)
    console.error(JSON.stringify({ kind: 'magic_link_undeliverable', reason: result.reason }))

    // `rejected` means Resend accepted the request and refused THIS address —
    // a suppression-list entry, a hard bounce, a domain that doesn't exist. It
    // is the one failure that depends on which address was submitted, so
    // answering it differently turns the mail provider's address validation
    // into the enumeration oracle the identical-response rule above exists to
    // prevent: submit an address, read the status, learn whether it is real.
    // Logged, and answered like every other request.
    //
    // `error` and `unconfigured` are properties of this deployment, identical
    // for every caller, and a 503 for them is the honest answer — the whole
    // point of inspecting the result rather than trusting it.
    if (result.reason === 'rejected') return { ok: true }

    throw createError({
      statusCode: 503,
      message: 'Could not send the sign-in email',
      data: { code: 'email_unavailable' },
    })
  }

  return { ok: true }
})
