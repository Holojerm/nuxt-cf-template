// Runs the lifecycle steps once a day (server/utils/lifecycle.ts).
//
// Rides the existing 04:00 UTC cron rather than adding one: every step's window
// is days wide, so the hour only decides when mail lands — the small hours in
// the US, read with the morning's inbox.
//
// Hand-run in dev: curl https://my-app.localhost/_nitro/tasks/lifecycle-email

import { db } from '@nuxthub/db'

import { captureServerEvent } from '../utils/posthog'
import { emailBranding } from '../utils/email-templates'
import { sendEmail } from '../utils/email'
import { getRegisteredLifecycleSteps } from '../utils/extensions'
import { runLifecycle } from '../utils/lifecycle'
import { APP_LIFECYCLE_STEPS } from '../utils/lifecycle-app-steps'
import { TEMPLATE_LIFECYCLE_STEPS } from '../utils/lifecycle-steps'
import { buildUnsubscribeUrl } from '../utils/unsubscribe'
import { logEvent } from '../utils/log'

export default defineTask({
  meta: {
    name: 'lifecycle-email',
    description: 'Send the day’s lifecycle emails (activation nudge, pass expiring, app steps)',
  },
  async run() {
    const config = useRuntimeConfig()
    // Unconfigured, every send would claim, fail, and give the claim back —
    // correct, but a nightly D1 churn that looks like activity. Say so instead.
    if (!config.resend.apiKey || !config.resend.from) {
      logEvent('info', 'lifecycle_skipped', { reason: 'email_unconfigured' })
      return { result: 'skipped' }
    }

    const started = Date.now()
    // Template steps, then features' (billing's pass_expiring), then the app's.
    const steps = [
      ...TEMPLATE_LIFECYCLE_STEPS,
      ...getRegisteredLifecycleSteps(),
      ...APP_LIFECYCLE_STEPS,
    ]
    const reports = await runLifecycle(db, steps, {
      brand: emailBranding(),
      send: sendEmail,
      unsubscribeUrl: (userId, eventType) =>
        buildUnsubscribeUrl(config.sessionPassword, config.public.appUrl, userId, eventType),
      onSent: (recipient, step) =>
        captureServerEvent({
          distinctId: recipient.userId,
          event: 'lifecycle_email_sent',
          properties: { step: step.id },
        }),
    })

    logEvent('info', 'lifecycle_email', { reports, durationMs: Date.now() - started })
    return { result: reports }
  },
})
