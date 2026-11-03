// Reactions to a Paddle event, registered by whoever cares what it did.
//
// The webhook applies an event (applyPaddleEvent), sends its email, then hands
// the outcome to these handlers in registration order, before it logs and
// reports to PostHog. Referral is the shipped user: it lives in core and pays
// the referrer from here (server/utils/referral-billing.ts). An app adds its
// own for anything that should follow money arriving or leaving:
//
//   registerBillingOutcomeHandler('hosting', async ({ db, outcome }) => { … })
//
// ── Handlers must not throw, and this makes sure they cannot hurt ────────────
// A 500 from the webhook makes Paddle replay a money event, so one handler's
// failure must not stop the next or fail the delivery. Each is awaited (the
// isolate may be torn down the moment the response is sent) and its error is
// logged as `billing_outcome_handler_failed`, never rethrown. Handlers are
// still expected to be idempotent: the same event can be delivered twice.

import type { EntitlementDb, PaddleEvent, PaddleEventOutcome } from './entitlements'

export interface BillingOutcomeContext {
  db: EntitlementDb
  /** The verified event, as parsed by paddleEventSchema. */
  event: PaddleEvent
  /** What applying it did, including the ignored cases (duplicate, stale, …). */
  outcome: PaddleEventOutcome
}

export type BillingOutcomeHandler = (context: BillingOutcomeContext) => Promise<void>

// Keyed, so a Nitro plugin and a test (or a dev reload) registering the same
// handler replace rather than duplicate it.
const handlers = new Map<string, BillingOutcomeHandler>()

export function registerBillingOutcomeHandler(key: string, handler: BillingOutcomeHandler): void {
  handlers.set(key, handler)
}

export async function runBillingOutcomeHandlers(context: BillingOutcomeContext): Promise<void> {
  for (const [key, handler] of handlers) {
    try {
      await handler(context)
    } catch (error) {
      console.error(
        JSON.stringify({
          kind: 'billing_outcome_handler_failed',
          handler: key,
          error: String(error),
        }),
      )
    }
  }
}

// ── Unknown-user events that are not a problem ───────────────────────────────
// An event naming an account that does not exist is alerted
// (`paddle_webhook_unknown_user`): money arriving for nobody is what a
// hard-deleted customer looks like. An app whose own flow causes such events on
// purpose (account deletion that cancels the subscription at Paddle first, so
// its `subscription.canceled` arrives after the user row is gone) says so here,
// and the webhook acknowledges it with an info log (`paddle_webhook_after_deletion`)
// instead of an ops event. Keep the check as narrow as the thing it expects: any
// event it does not name must keep alerting. Nothing registered, nothing changes.

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
      console.error(
        JSON.stringify({
          kind: 'billing_unknown_user_check_failed',
          check: key,
          error: String(error),
        }),
      )
    }
  }
  return false
}

/** Test-only: forget every handler and expectation. */
export function clearBillingOutcomeHandlersForTest(): void {
  handlers.clear()
  expectations.clear()
}
