// Registers the referral loop's reactions to Paddle events with the billing
// layer (server/utils/referral-billing.ts) and its per-row `referralKind` on the
// billing history (server/utils/referral-view.ts). Referral requires billing:
// remove this file with referral (TEARDOWN.md), and the webhook and the
// entitlement view keep working.
import { registerBillingOutcomeHandler } from '#layers/billing/server/utils/billing-outcome'
import { registerEntitlementViewFields } from '#layers/billing/server/utils/entitlement-view-fields'
import { createReferralOutcomeHandler } from '../utils/referral-billing'
import { referralHistoryFields } from '../utils/referral-view'

export default defineNitroPlugin(() => {
  registerBillingOutcomeHandler('referral', createReferralOutcomeHandler())
  registerEntitlementViewFields({ key: 'referral', history: referralHistoryFields })
})
