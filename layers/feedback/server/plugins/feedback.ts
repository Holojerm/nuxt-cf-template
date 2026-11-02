// Registers the feedback feature's contributions to core (account export and
// deletion, admin user view, fleet counters, onboarding). Plugins run once per
// isolate before any request, cron or queue batch. Delete this file and the
// feedback feature's other files to remove it; core keeps working.
import { registerFeedbackExtensions } from '../utils/feedback-extensions'

export default defineNitroPlugin(() => {
  registerFeedbackExtensions(useRuntimeConfig().feedback)
})
