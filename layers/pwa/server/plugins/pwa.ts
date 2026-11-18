// Registers the pwa layer's contributions to core (account deletion and
// export cover push subscriptions). Plugins run once per isolate before any
// request, cron or queue batch.
import { registerPwaExtensions } from '../utils/pwa-extensions'

export default defineNitroPlugin(() => {
  registerPwaExtensions()
})
