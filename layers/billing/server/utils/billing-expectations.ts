// Unknown-user events that are not a problem.
//
// An event naming an account that does not exist is alerted
// (`paddle_webhook_unknown_user`): money arriving for nobody is what a
// hard-deleted customer looks like. An app whose own flow causes such events on
// purpose (account deletion that cancels the subscription at Paddle first, so
// its `subscription.canceled` arrives after the user row is gone) says so here,
// and the webhook acknowledges it with an info log (`paddle_webhook_after_deletion`)
// instead of an ops event. Keep the check as narrow as the thing it expects: any
// event it does not name must keep alerting. Nothing registered, nothing changes.
//
// The handlers that react to an applied event live in core
// (server/utils/billing-outcome.ts); this registry stays here because it is
// about the Paddle event itself.

import type { PaddleEvent } from './entitlements'
import { logEvent } from '#server/utils/log'

export type UnknownUserExpectation = (event: PaddleEvent) => boolean

const expectations = new Map<string, UnknownUserExpectation>()

export function registerUnknownUserExpectation(key: string, check: UnknownUserExpectation): void {
  expectations.set(key, check)
}

/** True when any registered check says this event for a missing account is expected. */
export function isUnknownUserExpected(event: PaddleEvent): boolean {
  for (const [key, check] of expectations) {
    try {
      if (check(event)) return true
    } catch (error) {
      // A broken check must not silence an alert: treat it as "not expected".
      logEvent('error', 'billing_unknown_user_check_failed', { check: key, error: String(error) })
    }
  }
  return false
}

/** Test-only: forget every expectation. */
export function clearUnknownUserExpectationsForTest(): void {
  expectations.clear()
}
