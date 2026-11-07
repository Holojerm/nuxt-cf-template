// Billing's E2E fixtures: everything about the Paddle money path the browser
// suite drives. The generic half (sign-in, unique emails, the console watcher)
// stays in test/e2e/fixtures.ts, which every layer's specs build on.
//
// ── Why the webhook, not a direct D1 write ───────────────────────────────────
// .claude/docs/gotchas.md's "The dev server caches its DB connection" entry is the whole
// reason this file looks the way it does: `nuxt dev` holds its own libsql
// connection open, and an external `bun:sqlite` write after boot is invisible
// to it until a restart. Seeding an entitlement the way `bun seed` does would
// therefore just never show up while the suite's server is running.
//
// So state is driven THROUGH the server: sign in via POST /api/auth/dev, then
// create or end entitlements by POSTing signed Paddle webhooks to
// /paddle/webhook — the exact path a real purchase or cancellation takes,
// signature check and all. That's slower than an INSERT and is the point:
// it's the only way to prove the money path works end to end rather than
// asserting on state nothing real ever produced.

import type { APIResponse } from '@playwright/test'

import { test as base } from '../../../../test/e2e/fixtures'
import { E2E_PADDLE_PRICES } from './paddle-prices'
import { signPaddleWebhook } from './sign'

export { expect, uniqueEmail, watchForViolations } from '../../../../test/e2e/fixtures'
export { signPaddleWebhook }

export const DAY_MS = 24 * 60 * 60 * 1000

// Per worker process, like test/e2e/fixtures.ts's RUN_TOKEN: unique within a run
// and across reruns, so a ref collides only with itself.
const REF_TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A realistic-shaped, unique Paddle ref for one scenario. */
export function uniquePaddleRef(prefix: 'sub_' | 'txn_', caseName: string): string {
  return `${prefix}e2e_${REF_TOKEN}_${caseName}`
}

// ─── Paddle event builders ───────────────────────────────────────────────────
// Snake_case, matching layers/billing/server/utils/entitlements.ts's `paddleEventSchema` wire
// shape field-for-field — see layers/billing/test/entitlements.test.ts for the same
// convention on the vitest side.

export interface PaddleEventData {
  id: string
  status?: string | null
  customer_id?: string | null
  subscription_id?: string | null
  billed_at?: string | null
  custom_data?: { userId?: string } | null
  items?: { price: { id: string } }[] | null
  current_billing_period?: { ends_at: string } | null
  scheduled_change?: { action: string; effective_at?: string | null } | null
  action?: string | null
  type?: string | null
  transaction_id?: string | null
}

export interface PaddleWebhookEvent {
  event_id: string
  event_type: string
  occurred_at: string
  data: PaddleEventData
}

export function buildPaddleEvent(eventType: string, data: PaddleEventData): PaddleWebhookEvent {
  return {
    event_id: `evt_e2e_${crypto.randomUUID()}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data,
  }
}

/** A one-time pass purchase — `transaction.completed` with no `subscription_id`. */
export function transactionCompletedEvent(params: {
  userId: string
  transactionId: string
  billedAt?: Date
}): PaddleWebhookEvent {
  return buildPaddleEvent('transaction.completed', {
    id: params.transactionId,
    status: 'completed',
    customer_id: `ctm_${params.transactionId}`,
    custom_data: { userId: params.userId },
    items: [{ price: { id: E2E_PADDLE_PRICES.pass } }],
    billed_at: (params.billedAt ?? new Date()).toISOString(),
  })
}

/** Any `subscription.*` transition — activation, dunning, cancellation, all one shape. */
export function subscriptionEvent(params: {
  eventType: string
  userId: string
  subscriptionId: string
  status: string
  currentPeriodEndsAt?: Date | null
  scheduledChange?: { action: string; effectiveAt?: Date | null } | null
}): PaddleWebhookEvent {
  return buildPaddleEvent(params.eventType, {
    id: params.subscriptionId,
    status: params.status,
    customer_id: `ctm_${params.subscriptionId}`,
    custom_data: { userId: params.userId },
    items: [{ price: { id: E2E_PADDLE_PRICES.monthly } }],
    current_billing_period: params.currentPeriodEndsAt
      ? { ends_at: params.currentPeriodEndsAt.toISOString() }
      : null,
    scheduled_change: params.scheduledChange
      ? {
          action: params.scheduledChange.action,
          effective_at: params.scheduledChange.effectiveAt?.toISOString() ?? null,
        }
      : null,
  })
}

/** Throws with the response body attached — a rejected webhook mid-flow is a confusing failure otherwise. */
export async function expectWebhookAccepted(response: APIResponse): Promise<void> {
  if (!response.ok()) {
    throw new Error(`Paddle webhook rejected: ${response.status()} ${await response.text()}`)
  }
}

export const test = base.extend<{
  /** POST a signed, schema-valid Paddle event to /paddle/webhook. */
  sendPaddleEvent: (event: PaddleWebhookEvent) => Promise<APIResponse>
}>({
  sendPaddleEvent: async ({ apiRequest }, use) => {
    await use(async (event) => {
      // Build the payload, THEN stamp+sign, THEN post — no step in between
      // that could let the clock drift past the server's 5s tolerance before
      // the request actually leaves. See signPaddleWebhook's timing contract.
      const body = JSON.stringify(event)
      const signature = await signPaddleWebhook(body)
      return apiRequest.post('/paddle/webhook', {
        data: body,
        headers: { 'content-type': 'application/json', 'paddle-signature': signature },
      })
    })
  },
})
