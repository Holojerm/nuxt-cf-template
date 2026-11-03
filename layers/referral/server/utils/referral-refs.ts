// What the referral loop's refs mean.
//
// The loop writes its grants into the billing layer's `entitlements` table, in
// the same `paddle_subscription_id` column as every other ref (billing's
// server/utils/paddle-refs.ts explains the column). Billing treats these two
// prefixes as any other date-expiring ref and never reads them; everything that
// knows what they mean lives here.
//
// The one place in this table where a ref is DERIVED rather than minted, and
// that is the whole point. Every other prefix here randomises (`comp_` uses a
// UUID) or copies an id Paddle issued; these two are a pure function of the
// account the grant is about, so the unique index on `paddle_subscription_id`
// becomes the idempotency guarantee itself. A Paddle webhook redelivered five
// times computes the same ref five times and writes one row — no ledger table,
// no "have we already paid this out" flag that a race can read stale.
//
// Two prefixes rather than one because they are counted differently: the cap in
// server/utils/referral.ts counts a referrer's EARNED rewards with a LIKE on
// `referral_`, and a welcome grant the referrer once received for their own
// arrival must not eat into that budget.

/** The referrer's reward, one per referee they brought: `referral_<refereeId>`. */
export const REFERRAL_REF_PREFIX = 'referral_'

/** The referee's arrival bonus, one per MAILBOX: `welcome_<salted mailbox hash>`. */
export const REFERRAL_WELCOME_REF_PREFIX = 'welcome_'

/**
 * The referrer's reward for one referee. Keyed by the REFEREE, not the
 * referrer: "this referral has been paid for" is the fact that must be unique,
 * and keying it the other way would cap a referrer at exactly one reward ever.
 */
export function referralRewardRef(refereeId: string): string {
  return `${REFERRAL_REF_PREFIX}${refereeId}`
}

/**
 * The arrival bonus for one MAILBOX. One per mailbox, forever.
 *
 * ── Why not the user id ──────────────────────────────────────────────────────
 * Because a user id is renewable and a mailbox is not. Deleting an account
 * anonymizes the row and frees the address (server/utils/account.ts), so
 * signing up again on the same address takes the INSERT branch and mints a
 * fresh id — and a welcome ref keyed on that id is a fresh 7 days, every time,
 * forever. Two mailboxes taking turns is then permanent free access, which is
 * precisely the arithmetic REFERRAL_WELCOME_DAYS is sized against.
 *
 * The argument is a SALTED HASH of the canonical mailbox, never the address
 * itself: this string lands in `entitlements.paddle_subscription_id`, which is
 * rendered in the admin console and exported in "download your data". An email
 * frozen there would outlive the account it belongs to. Salted rather than bare
 * SHA-256 for the reason server/utils/hash.ts gives — an unsalted digest of an
 * address is rainbow-tableable against a mailing list.
 *
 * Note this deliberately survives deletion. That is the point, and it is worth
 * stating plainly: a deleted account's trial is spent, and coming back does not
 * refill it.
 */
export function referralWelcomeRef(mailboxHash: string): string {
  return `${REFERRAL_WELCOME_REF_PREFIX}${mailboxHash}`
}

/** Is this row access somebody earned through the referral loop? Labels history. */
export function isReferralRef(paddleRef: string): boolean {
  return (
    paddleRef.startsWith(REFERRAL_REF_PREFIX) || paddleRef.startsWith(REFERRAL_WELCOME_REF_PREFIX)
  )
}

/**
 * Which side of the loop a referral row came from, or null if it isn't one.
 *
 * The two need different words on screen: a welcome grant is days somebody was
 * GIVEN for arriving, an earned reward is days they were PAID for bringing
 * somebody. Telling a brand-new user they "earned" days for an invite they
 * received reads as a mistake, which is what /account said before this existed.
 */
export function referralRefKind(paddleRef: string): 'welcome' | 'reward' | null {
  if (paddleRef.startsWith(REFERRAL_WELCOME_REF_PREFIX)) return 'welcome'
  if (paddleRef.startsWith(REFERRAL_REF_PREFIX)) return 'reward'
  return null
}
