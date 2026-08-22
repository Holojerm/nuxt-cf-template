// The referral loop's shape and its prices, in the one place both halves read.
//
// In `shared/` for the same reason MAX_COMP_PASSES is: the numbers below are
// simultaneously a marketing promise rendered on /account and a spending limit
// enforced in server/utils/referral.ts. Typed twice, they drift, and the
// direction they drift in is "the page promises 30 days and the grant writes
// 7" — which is a support ticket that reads as fraud to the person filing it.
//
// The code SHAPE lives here for a second reason: shared/utils/attribution.ts
// validates `?ref=` against it before the value reaches a database write, and
// server/utils/users.ts generates codes from the same alphabet. A validator and
// a generator that disagree produce codes nobody can redeem.

/**
 * A referral code ends up in a URL, in a group chat, and read aloud over a
 * phone, so the alphabet drops every character people confuse when
 * transcribing: 0/O, 1/I/L, and U (which is heard as "you"). What's left is 30
 * symbols, all URL-safe without escaping.
 */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 30^8 ≈ 6.6e11 — unguessable enough that codes can't be enumerated to farm rewards. */
export const REFERRAL_CODE_LENGTH = 8

/**
 * Bounded retries when a freshly minted code hits the unique index.
 *
 * Shared by the two places that mint: provisioning (server/utils/users.ts) and
 * the lazy mint for accounts that predate the column (server/utils/referral.ts).
 * An unbounded loop turns a broken generator into a hung request; at 30^8 five
 * collisions means the randomness is broken and deserves to be thrown.
 */
export const REFERRAL_CODE_MINT_ATTEMPTS = 5

/** Exactly the shape the generator produces — anchored, so nothing longer passes. */
export const REFERRAL_CODE_PATTERN = new RegExp(
  `^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`,
)

/**
 * The one accepted spelling of a code, or `undefined`.
 *
 * Uppercases first, because the code travels through mail clients that
 * lowercase URLs and through people retyping it, and the alphabet is uppercase.
 * Everything else is rejected outright rather than repaired: this value is
 * about to decide whether somebody is credited with a customer, and a guess at
 * what a malformed code "probably meant" is a guess about money.
 */
export function normalizeReferralCode(raw: string | null | undefined): string | undefined {
  const candidate = raw?.trim().toUpperCase()
  if (!candidate || !REFERRAL_CODE_PATTERN.test(candidate)) return undefined
  return candidate
}

// ── What the loop pays, and to whom ─────────────────────────────────────────
// Stated as three numbers rather than one, because the two sides are paid for
// two different things and must not be tuned as if they were the same lever.

/**
 * Days the *referee* gets for arriving through someone's link.
 *
 * Deliberately NOT a whole 30-day pass, and this is the fraud decision in the
 * whole feature. Anything granted at signup costs the person receiving it
 * nothing but a fresh mailbox, so whatever this number is, it is the price of
 * the product to anyone willing to rotate email addresses. At 30 the paid
 * product is optional; at 7 it is a trial-length taste that still leaves a
 * reason to buy, and rotating a mailbox weekly is more work than $18.
 *
 * It is denominated in DAYS rather than passes for the same reason: a pass is
 * "the thing the customer would have bought" (see server/utils/admin-grants.ts
 * on why comps are counted in passes), and this is explicitly not that. It is a
 * trial, and calling it one keeps the whole-passes rule intact where it matters.
 */
export const REFERRAL_WELCOME_DAYS = 7

/**
 * Days the *referrer* earns, once, when their referee first pays.
 *
 * A full pass — the thing they would have bought — because unlike the welcome
 * grant this one is not free to obtain: somebody had to complete a real Paddle
 * transaction for it to exist. That trigger is the entire anti-fraud design.
 * Rewarding on signup instead would make N throwaway accounts an unlimited
 * supply of days for one attacker; rewarding on payment means farming the
 * program costs more than the product does.
 *
 * Asserted equal to PASS_DAYS by test/referral.test.ts, so the two cannot drift.
 */
export const REFERRAL_REWARD_DAYS = 30

/**
 * How many referees one account can ever be rewarded for.
 *
 * Not a business rule to tune — a blast radius. Ten rewarded referrals is most
 * of a year of free access; an account past that is either an affiliate or the
 * hub of a ring, and both of those need a human to look rather than a counter
 * to keep incrementing. There is no way to raise it from inside the product.
 */
export const REFERRAL_MAX_REWARDS = 10

/**
 * The link a person shares. Lands on the home page, where the attribution
 * plugin writes the code into the first-touch cookie
 * (app/plugins/attribution.client.ts) — any public route would work, and `/` is
 * the one that reads as an invitation rather than as a checkout.
 *
 * Returns '' when no origin is configured, so the UI can render the disabled
 * state instead of a link to `undefined/?ref=…`.
 */
export function referralShareUrl(origin: string | undefined, code: string): string {
  const base = (origin || '').replace(/\/+$/, '')
  if (!base || !normalizeReferralCode(code)) return ''
  return `${base}/?ref=${code}`
}
