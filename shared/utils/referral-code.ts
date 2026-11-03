// The shape of a referral code, in the one place the validator and the generator
// both read.
//
// This is core's, not the referral feature's, because the first-touch
// attribution cookie (shared/utils/attribution.ts) carries a `?ref=` claim and
// validates it against this shape before the value reaches a database write.
// The feature that mints and redeems codes (server/utils/referral-codes.ts)
// generates from the same alphabet; a validator and a generator that disagree
// produce codes nobody can redeem, and the symptom is a referral program that
// silently credits nobody. Core carries the claim; what a code is worth, who
// holds one and what it pays is the referral feature's.

/**
 * A referral code ends up in a URL, in a group chat, and read aloud over a
 * phone, so the alphabet drops every character people confuse when
 * transcribing: 0/O, 1/I/L, and U (which is heard as "you"). What's left is 30
 * symbols, all URL-safe without escaping.
 */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 30^8 ≈ 6.6e11 — unguessable enough that codes can't be enumerated to farm rewards. */
export const REFERRAL_CODE_LENGTH = 8

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
