// Registers the billing feature's contributions to core (deletion guard,
// export, admin views, fleet counters, funnel, onboarding, purge, lifecycle,
// paywall gate). Plugins run once per isolate before any request, cron or queue
// batch. Remove billing (TEARDOWN.md) and this file goes with it; core keeps
// working as a free product.
import { registerBillingExtensions } from '../utils/billing-extensions'

export default defineNitroPlugin(() => {
  registerBillingExtensions()
})
