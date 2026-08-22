// GET /api/referral/me — the signed-in user's own referral link and its results.
//
// Auth comes from the global /api/* middleware. There is no route for reading
// anybody else's, and there must not be: a referral code is a bearer value that
// credits its holder with customers, so an endpoint that returned one for an
// arbitrary user id would let anyone attribute their own signup to a stranger,
// or enumerate the code space against real accounts.
//
// Only the counts and the code are on the wire. The day amounts the UI needs to
// state the terms are constants in #shared/utils/referral, auto-imported by the
// component — sending them from here would be a second copy of a number the
// grant path already owns, and the two would eventually disagree about what
// this page promised.

// Imported by path rather than left to Nitro's auto-import, following
// server/api/auth/magic-link.post.ts: the auto-import typechecks everywhere and
// is not always injected at runtime (CLAUDE.md › Gotchas), and a symbol that
// resolves to `undefined` here is a share link that quietly becomes 'undefined'.
import { referralShareUrl } from '#shared/utils/referral'
import { getReferralSummary } from '../../utils/referral'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  // Mints a code on the spot for accounts that predate the column — the column
  // is nullable precisely so that backfilling never handed codes to accounts
  // that would never share one (server/db/schema.ts).
  const summary = await getReferralSummary(db, user.id)
  if (!summary) {
    // The session names a user row that is gone. Not a 500: the session guard
    // will end this session on the next request anyway.
    throw createError({ statusCode: 404, message: 'Account not found' })
  }

  const config = useRuntimeConfig(event)

  return {
    code: summary.code,
    // '' when no appUrl is configured, so the card renders its unavailable
    // state rather than a link to `undefined/?ref=…`.
    shareUrl: referralShareUrl(config.public.appUrl, summary.code),
    referredCount: summary.referredCount,
    rewardedCount: summary.rewardedCount,
  }
})
