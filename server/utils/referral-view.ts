// Which side of the referral loop a billing-history row came from, as a field on
// GET /api/billing/entitlement (and the admin views that share it). Registered
// with the billing layer's view-field seam by server/plugins/referral.ts.
//
// The view already says `referral: boolean` per row, which is enough to label a
// row "free"; the account page needs the two sides apart ("Welcome days" for the
// person who was invited, a reward for the one who invited) and so reads this.

import type { Entitlement } from '#layers/billing/server/db/schema'
import { referralRefKind } from '#layers/billing/server/utils/paddle-refs'

declare module '#layers/billing/server/utils/entitlement-view-fields' {
  interface EntitlementHistoryFields {
    /** Which side of the referral loop granted this row, or null for a purchase or comp. */
    referralKind: 'welcome' | 'reward' | null
  }
}

export function referralHistoryFields(entitlement: Entitlement) {
  return { referralKind: referralRefKind(entitlement.paddleSubscriptionId) }
}
