// Runs the lifecycle steps (server/utils/lifecycle.ts), then the announcements
// (server/utils/announcements.ts), once a day.
//
// Rides the existing 04:00 UTC cron rather than adding one: every step's window
// is days wide, so the hour only decides when mail lands — the small hours in
// the US, read with the morning's inbox.
//
// Hand-run in dev: curl https://my-app.localhost/_nitro/tasks/lifecycle-email

import { db } from '@nuxthub/db'

import { ANNOUNCEMENTS } from '../emails/announcements.generated'
import { runAnnouncements, type AnnouncementReport } from '../utils/announcements'
import { getRegisteredLifecycleSteps } from '../utils/extensions'
import { runLifecycle, type LifecycleStepReport } from '../utils/lifecycle'
import { APP_LIFECYCLE_STEPS } from '../utils/lifecycle-app-steps'
import { lifecycleDeps } from '../utils/lifecycle-runtime'
import { ANNOUNCEMENTS_PER_WEEK } from '../utils/lifecycle-sequence'
import { TEMPLATE_LIFECYCLE_STEPS } from '../utils/lifecycle-steps'
import { logEvent } from '../utils/log'
import { captureServerEvent } from '../utils/posthog'
import { buildSubscriberUnsubscribeUrl } from '../utils/subscriber-tokens'

interface LifecycleRunResult {
  steps: Record<string, LifecycleStepReport>
  announcements: Record<string, AnnouncementReport>
}

// The result type is spelled out because TypeScript infers it from the first
// `return` alone, and this task has two shapes.
export default defineTask<'skipped' | LifecycleRunResult>({
  meta: {
    name: 'lifecycle-email',
    description: 'Send the day’s lifecycle emails and any announcement not yet sent',
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
    const deps = lifecycleDeps()
    // Sequence steps, then features' (billing's pass_expiring), then the app's.
    const steps = await runLifecycle(
      db,
      [...TEMPLATE_LIFECYCLE_STEPS, ...getRegisteredLifecycleSteps(), ...APP_LIFECYCLE_STEPS],
      deps,
    )
    logEvent('info', 'lifecycle_email', { reports: steps, durationMs: Date.now() - started })

    const announcements = await runAnnouncements(db, ANNOUNCEMENTS, {
      brand: deps.brand,
      send: deps.send,
      unsubscribeUrl: deps.unsubscribeUrl,
      subscriberUnsubscribeUrl: (id) =>
        buildSubscriberUnsubscribeUrl(config.sessionPassword, config.public.appUrl, id),
      onSent: (userId, step) =>
        captureServerEvent({
          distinctId: userId,
          event: 'lifecycle_email_sent',
          properties: { step },
        }),
      weeklyCap: ANNOUNCEMENTS_PER_WEEK,
    })
    // Ids and counts only; a recipient never reaches a log line.
    if (Object.keys(announcements).length) {
      logEvent('info', 'announcement_email', { reports: announcements })
    }

    return { result: { steps, announcements } }
  },
})
