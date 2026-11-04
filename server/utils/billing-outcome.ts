// Reactions to a billing event, registered by whoever cares what it did.
//
// The billing layer's webhook applies a provider event, sends its email, then
// hands the outcome to these handlers in registration order, before it logs and
// reports to PostHog. This is a core seam rather than a billing export so that
// a feature which reacts to money (the referral loop pays the referrer from
// here) never imports the billing layer, and billing never imports it. An app
// adds its own for anything that should follow money arriving or leaving:
//
//   registerBillingOutcomeHandler('hosting', async ({ db, outcome }) => { … })
//
// With billing absent nothing ever runs the handlers; with none registered the
// webhook does exactly what it did without them.
//
// ── The types are the contract, not billing's internals ─────────────────────
// `BillingOutcomeEvent` and `BillingOutcome` describe only what a handler may
// rely on. The layer's own richer types (PaddleEvent, PaddleEventOutcome) are
// assignable to them, so the webhook passes what it has and a handler written
// against this file compiles without the layer.
//
// ── Handlers must not throw, and this makes sure they cannot hurt ────────────
// A 500 from the webhook makes the provider replay a money event, so one
// handler's failure must not stop the next or fail the delivery. Each is
// awaited (the isolate may be torn down the moment the response is sent) and
// its error is logged as `billing_outcome_handler_failed`, never rethrown.
// Handlers are still expected to be idempotent: the same event can be delivered
// twice.

import type { ExtensionDb } from './extensions'
import { createRegistry } from './registry'
import { logEvent } from './log'

/** The verified event, as far as a handler may depend on it. */
export interface BillingOutcomeEvent {
  event_id: string
  event_type: string
  occurred_at: string
  data: { id: string; status?: string | null; [key: string]: unknown }
}

/** One derived row (a referral reward) a refund or chargeback revoked or restored. */
export interface BillingDerivedChange {
  ref: string
  userId: string
  /** The window as it stood before the change. */
  periodEnd: Date | null
}

/** What reversing a purchase did. `outcome` is `'reversed'` when a won chargeback put rows back. */
export interface BillingAdjustmentResult {
  outcome: string
  userId?: string
  paddleRef?: string
  derived?: BillingDerivedChange[]
}

/** What applying the event did, including the ignored cases (duplicate, stale, …). */
export type BillingOutcome =
  | {
      kind: 'subscription'
      userId: string
      status: string
      previousStatus: string | null
      /** What a referral reward for this subscription is keyed on; null falls back to the sub id. */
      firstTransactionId: string | null
    }
  | { kind: 'pass'; userId: string; granted: boolean; endsAt: Date; stackedOn: Date | null }
  | { kind: 'adjustment'; action: string; result: BillingAdjustmentResult }
  | { kind: 'ignored'; reason: string }

export interface BillingOutcomeContext {
  db: ExtensionDb
  event: BillingOutcomeEvent
  outcome: BillingOutcome
}

export type BillingOutcomeHandler = (context: BillingOutcomeContext) => Promise<void>

const handlers = createRegistry<BillingOutcomeHandler>()

export const registerBillingOutcomeHandler = (key: string, handler: BillingOutcomeHandler): void =>
  handlers.set(key, handler)

export async function runBillingOutcomeHandlers(context: BillingOutcomeContext): Promise<void> {
  for (const [key, handler] of handlers.entries()) {
    try {
      await handler(context)
    } catch (error) {
      logEvent('error', 'billing_outcome_handler_failed', { handler: key, error: String(error) })
    }
  }
}

/** Test-only: forget every handler. */
export const clearBillingOutcomeHandlersForTest = (): void => handlers.clear()
