// The lifecycle runner's real dependencies, built from runtime config, and the
// one send that does not wait for the daily task: the steps due at sign-up.
//
// Apart from lifecycle.ts so that file stays free of Nitro and the workerd test
// suite can drive the runner with fakes.

import type { H3Event } from 'h3'

import type { User } from '../db/schema'
import { emailBranding } from './email-templates'
import { sendEmail } from './email'
import { deliverLifecycleStep, type LifecycleDb, type LifecycleDeps } from './lifecycle'
import { IMMEDIATE_LIFECYCLE_STEPS } from './lifecycle-steps'
import { captureServerEvent } from './posthog'
import { buildUnsubscribeUrl } from './unsubscribe'

/** `event` when there is a request (sign-up); the daily task has none. */
export function lifecycleDeps(event?: H3Event): LifecycleDeps {
  const config = useRuntimeConfig(event)
  return {
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
  }
}

/**
 * Send a brand-new account the steps that are due at once (the welcome),
 * through the same claim, preference check and unsubscribe link as the daily
 * run. A send that fails gives its claim back, and the next daily run retries
 * inside the step's window.
 */
export async function sendSignupSteps(
  db: LifecycleDb,
  user: Pick<User, 'id' | 'email' | 'name'>,
  deps: LifecycleDeps,
): Promise<void> {
  for (const step of IMMEDIATE_LIFECYCLE_STEPS) {
    await deliverLifecycleStep(
      db,
      step,
      { userId: user.id, email: user.email, name: user.name, subjectKey: '' },
      deps,
    )
  }
}
