// Registers the billing layer's contributions to core (deletion guard, export,
// admin views, fleet counters, funnel, onboarding, purge, lifecycle, paywall
// gate) and applies its options. Plugins run once per isolate before any
// request, cron or queue batch. Don't vendor the layer (or delete it, see
// TEARDOWN.md) and core keeps working as a free product.
import { registerBillingExtensions } from '../utils/billing-extensions'

export default defineNitroPlugin(() => {
  registerBillingExtensions(useRuntimeConfig().billing)
})
