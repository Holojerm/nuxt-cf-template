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
// the sender chose. Two limits keep that from being a weapon: the per-IP limit
// in the middleware, and the per-address limit below — see MAGIC_LINK_RATE_LIMIT
// for why the second one is the load-bearing half.

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
import { saltedHash } from '../../utils/hash'
import {
  createMagicLinkToken,
  discardMagicLinkToken,
  isUndeliverableAddress,
  MAGIC_LINK_RATE_LIMIT,
  MAGIC_LINK_TTL_SECONDS,
} from '../../utils/magic-link'
import { rateLimit } from '../../utils/rate-limit'
import { normalizeEmail } from '../../utils/users'

const bodySchema = z.object({
  // 254 is the RFC 5321 ceiling for a whole address. Capped before the address
  // reaches a KV key or a database column.
  email: z.string().trim().email().max(254),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)
  const email = normalizeEmail(body.email)
  const config = useRuntimeConfig(event)

  // Keyed by a salted hash of the address rather than the address itself. KV
  // keys are readable in the Cloudflare dashboard and land in log lines, and
  // "which addresses asked for a sign-in link" is not something this app needs
  // to publish in order to run. Same construction as `feedback.ip_hash`, same
  // reasoning (server/utils/hash.ts).
  const identifier = (await saltedHash(email, config.sessionPassword)) ?? email
  await rateLimit(event, { ...MAGIC_LINK_RATE_LIMIT, identifier })

  // Reserved addresses — in practice, the `deleted-<id>@deleted.invalid`
  // tombstone a deleted account's row is rewritten to. Minting for one would be
  // an account-resurrection primitive; see isUndeliverableAddress() for the
  // whole mechanism.
  //
  // Answered with the ordinary success body, like every other address, because
  // the no-enumeration rule this endpoint is built around does not get an
  // exception for the case where the answer is interesting. Deliberately placed
  // AFTER rateLimit() and not before: the limiter sets X-RateLimit-* on the
  // response, so a short-circuit above it would be visible in the headers and
  // would hand back exactly the signal the identical body exists to withhold.
  //
  // Honest about what this does not cover: the guarded path skips a database
  // write and a call to Resend, so it returns measurably faster. Closing that
  // would mean minting a token nobody can ever receive, to hide a fact that is
  // only reachable by someone who already knows a deleted account's user id.
  // Not worth the row.
  if (isUndeliverableAddress(email)) {
    console.warn(JSON.stringify({ kind: 'magic_link_reserved_address_refused' }))
    return { ok: true }
  }

  // Both of these live in cookies on THIS browser and are captured now, because
  // the link may well be opened on another device where neither exists. See the
  // note on `magic_link_tokens` in server/db/schema.ts.
  const redirectTo = safeRedirectPath(getCookie(event, REDIRECT_COOKIE), '')
  const attribution = readAttributionCookie(getCookie(event, ATTRIBUTION_COOKIE))

  const { token, record } = await createMagicLinkToken(db, { email, redirectTo, attribution })

  const brand = emailBranding()
  // The link points at a *page*, not at this API. That page's button is what
  // spends the token — see server/api/auth/magic-link/verify.get.ts for why a
  // link that signs you in by being fetched is a link a mail scanner can spend.
  const url = `${brand.appUrl}/auth/verify?token=${encodeURIComponent(token)}`

  const result = await sendEmail({
    to: email,
    ...magicLinkEmail(brand, { url, expiresMinutes: MAGIC_LINK_TTL_SECONDS / 60 }),
  })

  if (!result.sent) {
    // sendEmail() never throws, precisely because its usual callers are more
    // important than the mail. Here the mail IS the request, so the one thing
    // this must not do is swallow the failure and answer "check your inbox".
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
    throw createError({
      statusCode: 503,
      message: 'Could not send the sign-in email',
      data: { code: 'email_unavailable' },
    })
  }

  return { ok: true }
})
