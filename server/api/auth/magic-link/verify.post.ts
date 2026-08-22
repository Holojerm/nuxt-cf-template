// POST /api/auth/magic-link/verify — spend the token, issue the session.
//
// The other half of the split described in verify.get.ts: this is the route
// that changes state, and it is a POST so that nothing which merely *fetches*
// the link can reach it. Called by /auth/verify when the person clicks the
// confirm button.
//
// Returns JSON with the redirect target instead of a 302, because the caller is
// `$fetch` from a page rather than a browser following a redirect chain — a 302
// here would be followed opaquely and the page would never learn where to go.
// The destination is still resolved exactly the way completeOAuthSignIn resolves
// it, through popRedirectTarget(), so both sign-in paths honour the same cookie
// with the same open-redirect guard.

import { z } from 'zod'

import { establishSession, popRedirectTarget, safeRedirectPath } from '../../../utils/auth'
import {
  attributionFromRecord,
  consumeMagicLinkToken,
  MAGIC_LINK_TOKEN_PATTERN,
} from '../../../utils/magic-link'

const bodySchema = z.object({ token: z.string().regex(MAGIC_LINK_TOKEN_PATTERN) })

export default defineEventHandler(async (event) => {
  const { token } = await readValidatedBody(event, bodySchema.parse)

  // Single statement, single winner — see consumeMagicLinkToken. A replayed
  // link loses the race in the database rather than in application code.
  const consumed = await consumeMagicLinkToken(db, token)
  if (!consumed.ok) {
    throw createError({
      statusCode: 400,
      message: 'That sign-in link cannot be used',
      // `link_expired` | `link_used` | `link_invalid` — the page turns these
      // into a sentence, and /login renders the same codes if it is bounced one.
      data: { code: `link_${consumed.reason}` },
    })
  }

  const record = consumed.record

  let created: boolean
  try {
    ;({ created } = await establishSession(event, {
      profile: {
        provider: 'email',
        email: record.email,
        // No display name and no avatar to offer: nothing in this flow ever
        // spoke to a profile API. upsertOAuthUser falls back to the local part,
        // and the user renames themselves later.
        name: null,
        avatarUrl: null,
      },
      // Verified, and this is the one place in the app where that word means
      // something we did rather than something a provider told us. The token
      // was mailed to this address and nowhere else, and it came back — so
      // whoever is here controls the mailbox, which is precisely the claim
      // `emailVerified` makes. Every other caller is trusting a third party's
      // flag; this one is the primary evidence.
      emailVerified: true,
      // Captured when the link was minted, because that may have been a
      // different device — see server/utils/magic-link.ts.
      attribution: attributionFromRecord(record),
    }))
  } catch (error) {
    const code = (error as { data?: { code?: string } }).data?.code ?? 'sign_in_failed'
    throw createError({
      statusCode: 401,
      message: 'Could not sign you in',
      data: { code },
    })
  }

  return {
    ok: true,
    // Cookie first (this browser asked, in this session), then the destination
    // stored on the row (the cross-device case), then the same new-account /
    // returning-user split completeOAuthSignIn makes. Both candidate values pass
    // through safeRedirectPath before they can reach a browser.
    redirectTo: popRedirectTarget(
      event,
      safeRedirectPath(record.redirectTo ?? undefined, created ? '/dashboard' : '/'),
    ),
  }
})
