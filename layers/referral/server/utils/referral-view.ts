// How the referral loop shows up on the billing view: GET /api/billing/entitlement
// and the admin views that share it. Registered with core's view-field seam
// (server/utils/entitlement-view-fields.ts) by server/plugins/referral.ts, so
// the billing layer's view carries none of it unless the loop is present.
//
// Three fields, all additive:
//   history[].referral      true when the loop granted the row, either side of it
//   history[].referralKind  which side: 'welcome' | 'reward' | null
//   referralKind            the same, for the row that DESCRIBES the plan
//
// `referral` is a sibling of `comped` rather than a widening of it, because they
// are different facts with different consequences: a comp is revocable from the
// admin console (revokeCompPass refuses anything else), a referral grant is
// not. Collapsing them into one "free" flag would put a revoke button on a row
// the server will always refuse to revoke. Unlabelled, these rows read as
// purchases in billing history, which starts a support conversation about a
// charge that never happened — the same problem `comped` exists to solve.
//
// The account page needs the two sides apart ("Welcome days" for the person who
// was invited, a reward for the one who invited): without `referralKind` /account
// told somebody whose only access was a welcome grant "You have a one-time pass.
// It will not renew." — technically the shape of the row and completely wrong
// about where it came from, to a person who had just signed up through a
// friend's link and bought nothing.

import type {
  EntitlementViewFieldsContext,
  EntitlementViewRow,
} from '#server/utils/entitlement-view-fields'
import { isReferralRef, referralRefKind } from './referral-refs'

declare module '#server/utils/entitlement-view-fields' {
  interface EntitlementViewFields {
    /** Which side of the referral loop the DESCRIBING row came from, or null. */
    referralKind: 'welcome' | 'reward' | null
  }
  interface EntitlementHistoryFields {
    /** True when the referral loop granted this row — either side of it. */
    referral: boolean
    /** Which side of the referral loop granted this row, or null for a purchase or comp. */
    referralKind: 'welcome' | 'reward' | null
  }
}

export function referralHistoryFields(entitlement: EntitlementViewRow) {
  return {
    referral: isReferralRef(entitlement.paddleSubscriptionId),
    referralKind: referralRefKind(entitlement.paddleSubscriptionId),
  }
}

export function referralViewFields({ describing }: EntitlementViewFieldsContext) {
  return {
    referralKind: describing ? referralRefKind(describing.paddleSubscriptionId) : null,
  }
}
