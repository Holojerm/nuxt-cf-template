// The referral loop's part in creating an account, registered with core's
// signup seam (server/utils/signup-contributors.ts) by server/plugins/referral.ts.
//
//   resolve      the visitor's `?ref=` claim becomes `users.referred_by`, or is dropped
//   mint         every new account gets its own code, retried on a collision
//   afterSignUp  the new MAILBOX gets its welcome days, once
//
// Core's users.ts and auth.ts know none of this; without the registration an
// account is created with no code and no referrer, and nothing is granted.

import { REFERRAL_CODE_MINT_ATTEMPTS } from '#shared/utils/referral'
import { generateReferralCode, findReferrerByCode, isReferralCodeCollision } from './referral-codes'
import { grantRefereeWelcome } from './referral'
import type { SignupContributor } from './signup-contributors'

export interface ReferralSignupOptions {
  /** Test seam: the code generator. Production uses generateReferralCode. */
  mintCode?: () => string
}

export function createReferralSignup(options: ReferralSignupOptions = {}): SignupContributor {
  const mintCode = options.mintCode ?? generateReferralCode
  return {
    key: 'referral',
    mintAttempts: REFERRAL_CODE_MINT_ATTEMPTS,
    isCollision: isReferralCodeCollision,

    // ── Referral credit, resolved exactly once ───────────────────────────────
    // The code has to name a real, live, other account or it is simply dropped
    // (findReferrerByCode). The COLUMN stores the referrer's code, not their
    // id, which is what the schema comment specifies: it is deliberately not a
    // foreign key, so that a referrer deleting their account cannot take
    // somebody else's attribution down with it. Deletion nulls the code, so the
    // claim stops resolving and no further reward is ever paid on it — which is
    // the behaviour we want anyway.
    async resolve(db, { email, attribution }) {
      const referrer = await findReferrerByCode(db, attribution?.referralCode, email)
      return { referredBy: referrer?.referralCode ?? null }
    },

    // Every account is minted a referral code at creation, so no later code path
    // has to handle "user without a code" — the column is nullable only for rows
    // that predate it.
    mint: () => ({ referralCode: mintCode() }),

    // ── The referee's half of the referral loop ──────────────────────────────
    // Only on a brand-new account that resolved a referral code moments ago
    // (upsertOAuthUser writes `referred_by` on the INSERT branch, and only when
    // the code named a real, live, other account).
    //
    // Run inside afterSignIn for the reason that helper exists: the session
    // cookie is already sealed, so a throw here would tell someone sign-in
    // failed while they are, in fact, signed in — and on the magic-link path
    // their token is already spent. grantRefereeWelcome() never throws either;
    // both guards are deliberate, because free trial days are never worth an
    // account creation.
    afterSignUpLabel: 'referral_welcome',
    async afterSignUp({ db, event, user }) {
      if (!user.referredBy) return
      // The welcome ref is a salted hash of the MAILBOX — that is what makes
      // the trial once-per-inbox instead of once-per-account, and therefore not
      // renewable by deleting and re-registering. Its salt is provisioned in D1
      // rather than configured (server/utils/identity.ts); `sessionPassword` is
      // passed for one job only, recognising refs minted under the previous
      // construction, and can be deleted with that check.
      await grantRefereeWelcome(db, user, {
        sessionPassword: useRuntimeConfig(event).sessionPassword,
      })
    },
  }
}
