// GET /api/auth/magic-link/verify?token=… — is this link still usable?
//
// ── This GET deliberately does not sign anyone in ────────────────────────────
// The obvious design for a magic link is one route: follow the link, get a
// session, get redirected. It is also the design that hands the session to a
// robot.
//
// A link sits in an inbox, and inboxes are crawled before they are read.
// Microsoft Defender's Safe Links, Proofpoint URL Defense, Mimecast, Barracuda,
// and Gmail's own scanners all fetch URLs out of incoming mail, from their own
// infrastructure, seconds after delivery and without the recipient doing
// anything. Every one of those fetches is a GET. If a GET spends the token then
// the scanner spends it: the user clicks and is told the link was already used,
// while a `Set-Cookie` for their account was handed to a machine in a data
// centre and thrown away. In the failure mode where the scanner keeps cookies,
// it was handed a live session instead.
//
// Link prefetching is not exotic either — mail clients and browsers speculatively
// fetch what looks fetchable, and none of them POST.
//
// So the split is: this route *reads*, POST /api/auth/magic-link/verify *spends*.
// Nothing a scanner can do on its own changes state, and the token is only
// consumed after a human presses a button on /auth/verify. The one thing this
// costs is a click, which also reads as a deliberate confirmation step rather
// than as friction.
//
// Every outcome is a 200 with a `status`, including the unusable ones. "This
// link expired" is a correct answer to the question, not a failed request, and
// modelling it as a 4xx would only make the page render a generic error instead
// of the sentence that tells someone what to do next.
//
// The token arrives in a request HEADER, not the query string — Cloudflare logs
// request URIs upstream of anything this Worker can redact. See readToken().

import { z } from 'zod'

import { inspectMagicLinkToken, MAGIC_LINK_TOKEN_PATTERN } from '../../../utils/magic-link'

const tokenSchema = z.string().regex(MAGIC_LINK_TOKEN_PATTERN)

/**
 * Header for the app's own lookup, query string as a fallback.
 *
 * ── Why the header is preferred ──────────────────────────────────────────────
 * Cloudflare's edge records the request URI of every request, upstream of the
 * Worker and therefore upstream of `pathForLog()` — so a token in the query
 * string is logged where nothing in this codebase can redact it. That is the
 * exact exposure the fragment was introduced to avoid, and sending the token
 * back as `?token=` on the very next request would have handed it straight
 * back. /auth/verify sends `x-magic-link-token`.
 *
 * The query form is kept, not removed, because it is the only spelling
 * available to a link minted by an older deploy or a URL someone reassembled by
 * hand. Those should still work rather than read as "invalid"; they are simply
 * no longer what this app produces.
 */
function readToken(event: Parameters<typeof getQuery>[0]): string | null {
  const header = getRequestHeader(event, 'x-magic-link-token')
  const candidate = header ?? (getQuery(event).token as unknown)
  const parsed = tokenSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/** One shape for every outcome, so the page has one thing to type against. */
interface VerifyLookup {
  status: 'valid' | 'invalid' | 'expired' | 'used'
  /** Who the link would sign in. Null unless the link is usable. */
  email: string | null
}

export default defineEventHandler(async (event): Promise<VerifyLookup> => {
  // Shape-checked before it costs a database round trip. A token that cannot
  // exist is indistinguishable, to the caller, from one that never did.
  const token = readToken(event)
  if (!token) return { status: 'invalid', email: null }

  const result = await inspectMagicLinkToken(db, token)
  if (!result.ok) return { status: result.reason, email: null }

  // The address is returned so the page can say who is about to be signed in —
  // the check that catches "this is my old work address" before it becomes a
  // second account. Only the holder of a 256-bit token can ask, so this
  // discloses to the mailbox what the mailbox already received.
  return { status: 'valid', email: result.record.email }
})
