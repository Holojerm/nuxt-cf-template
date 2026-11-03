// Registers the referral loop with core's seams: the signup contributor (a code
// per account, `referred_by`, the welcome days), the reactions to billing events
// (server/utils/referral-billing.ts: the referrer's reward and the clawback's
// paperwork) and the referral fields on the billing view
// (server/utils/referral-view.ts). Billing registers the earned-access provider
// these call. Remove this file with the loop (TEARDOWN.md) and core, the webhook
// and the entitlement view keep working.
import { registerBillingOutcomeHandler } from '../utils/billing-outcome'
import { registerEntitlementViewFields } from '../utils/entitlement-view-fields'
import { registerSignupContributor } from '../utils/signup-contributors'
import { createReferralOutcomeHandler } from '../utils/referral-billing'
import { createReferralSignup } from '../utils/referral-signup'
import { referralHistoryFields, referralViewFields } from '../utils/referral-view'

export default defineNitroPlugin(() => {
  registerSignupContributor(createReferralSignup())
  registerBillingOutcomeHandler('referral', createReferralOutcomeHandler())
  registerEntitlementViewFields({
    key: 'referral',
    view: referralViewFields,
    history: referralHistoryFields,
  })
})
