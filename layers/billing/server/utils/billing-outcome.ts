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

/** Test-only: forget every handler. */
export function clearBillingOutcomeHandlersForTest(): void {
  handlers.clear()
}
