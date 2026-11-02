// Registers the referral loop's reactions to Paddle events with the billing
// layer (server/utils/referral-billing.ts). Referral requires billing: remove
// this file with referral (TEARDOWN.md), and the webhook keeps working.
import { registerBillingOutcomeHandler } from '#layers/billing/server/utils/billing-outcome'
import { createReferralOutcomeHandler } from '../utils/referral-billing'

export default defineNitroPlugin(() => {
  registerBillingOutcomeHandler('referral', createReferralOutcomeHandler())
})
