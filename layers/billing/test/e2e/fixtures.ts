// Billing's E2E fixtures: everything about the Stripe money path the browser
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
// create or end entitlements by POSTing signed Stripe webhooks to
// /stripe/webhook — the exact path a real purchase or cancellation takes,
// signature check and all. That's slower than an INSERT and is the point:
// it's the only way to prove the money path works end to end rather than
// asserting on state nothing real ever produced.

import type { APIRequestContext, APIResponse, Page } from '@playwright/test'

import { playwrightPort } from '../../../../scripts/worktree-port'
import { expect as baseExpect, test as base } from '../../../../test/e2e/fixtures'
import { workerAddressHeaders } from '../../../../test/lib/worker-address'
import { billingE2e } from './fork-config'
import { signStripeWebhook } from './sign'
import { E2E_STRIPE_PRICES } from './stripe-prices'
import { registerWithStub } from './stripe-stub'

export { expect, uniqueEmail, watchForViolations } from '../../../../test/e2e/fixtures'
export { signStripeWebhook }

export const DAY_MS = 24 * 60 * 60 * 1000

// Per worker process, like test/e2e/fixtures.ts's RUN_TOKEN: unique within a run
// and across reruns, so a ref collides only with itself.
const REF_TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A realistic-shaped, unique Stripe id for one scenario. */
export function uniqueStripeRef(prefix: 'sub_' | 'pi_' | 'cs_', caseName: string): string {
  return `${prefix}e2e_${REF_TOKEN}_${caseName}`
}

// ─── Stripe event builders ───────────────────────────────────────────────────
// Stripe's envelope (`id`, `type`, `created` in seconds, `data.object`), with
// only the fields layers/billing/server/utils/stripe-events.ts reads.

export interface StripeWebhookEvent {
  id: string
  type: string
  created: number
  data: { object: Record<string, unknown> }
}

export function buildStripeEvent(
  type: string,
  object: Record<string, unknown>,
): StripeWebhookEvent {
  return {
    id: `evt_e2e_${crypto.randomUUID()}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  }
}

/**
 * A one-time pass purchase: `checkout.session.completed` in payment mode. The
 * webhook asks Stripe (the stub) what the session sold, so register the session
 * with `registerPassSession` first. The pass's ref is the PaymentIntent id.
 */
export function passPurchaseEvent(params: {
  userId: string
  sessionId: string
  paymentIntentId: string
}): StripeWebhookEvent {
  return buildStripeEvent('checkout.session.completed', {
    id: params.sessionId,
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: params.paymentIntentId,
    customer: `cus_${params.sessionId}`,
    client_reference_id: params.userId,
    metadata: { userId: params.userId },
  })
}

/** Tell the Stripe stub the session sold the pass price. */
export async function registerPassSession(sessionId: string): Promise<void> {
  await registerWithStub({
    sessions: { [sessionId]: [E2E_STRIPE_PRICES.pass] },
  })
}

/** Any `customer.subscription.*` transition: activation, dunning, cancellation, all one shape. */
export function subscriptionEvent(params: {
  eventType:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted'
  userId: string
  subscriptionId: string
  status: string
  currentPeriodEndsAt?: Date | null
  cancelAt?: Date | null
}): StripeWebhookEvent {
  return buildStripeEvent(params.eventType, {
    id: params.subscriptionId,
    status: params.status,
    customer: `cus_${params.subscriptionId}`,
    metadata: { userId: params.userId },
    cancel_at: params.cancelAt ? Math.floor(params.cancelAt.getTime() / 1000) : null,
    items: {
      data: [
        {
          price: { id: E2E_STRIPE_PRICES.monthly, product: 'prod_e2e' },
          current_period_end: params.currentPeriodEndsAt
            ? Math.floor(params.currentPeriodEndsAt.getTime() / 1000)
            : null,
        },
      ],
    },
  })
}

/** Throws with the response body attached — a rejected webhook mid-flow is a confusing failure otherwise. */
export async function expectWebhookAccepted(response: APIResponse): Promise<void> {
  if (!response.ok()) {
    throw new Error(`Stripe webhook rejected: ${response.status()} ${await response.text()}`)
  }
}

// ─── Fork seam helpers (see fork-config.ts) ──────────────────────────────────

/** True when the product has a plan-gated page; false = page-level assertions are skipped. */
export const hasGatedPage = billingE2e.gatedPath !== null

/** Assert the entitlement endpoint's answer, then the fork's own probe if it set one. */
export async function expectAccess(
  { page, request }: { page: Page; request: APIRequestContext },
  expected: 'granted' | 'denied',
): Promise<void> {
  await billingE2e.accessProbe?.({ page, request }, expected)
}

/** The gated page rendered for an entitled user. */
export async function expectUnlocked(page: Page, opts: { full?: boolean } = {}): Promise<void> {
  if (!billingE2e.gatedPath) return
  await page.goto(billingE2e.gatedPath)
  await baseExpect(page).toHaveURL(new RegExp(`${billingE2e.gatedPath}$`))
  if (billingE2e.unlockedHeading) {
    await baseExpect(page.getByRole('heading', { name: billingE2e.unlockedHeading })).toBeVisible()
  }
  if (opts.full && billingE2e.unlockedText) {
    await baseExpect(page.getByText(billingE2e.unlockedText)).toBeVisible()
  }
}

/** Visit the gated page without a plan and expect to be bounced to `where`, remembering where from. */
export async function expectBounced(page: Page, where: string): Promise<URL> {
  const gated = billingE2e.gatedPath
  if (!gated) throw new Error('expectBounced needs a gated page')
  await page.goto(gated)
  await page.waitForURL(new RegExp(where))
  const url = new URL(page.url())
  baseExpect(url.pathname).toBe(where)
  baseExpect(url.searchParams.get('from')).toBe(gated)
  return url
}

export { billingE2e }

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>
interface WorkerOverrides {
  signInCache: (
    email: string,
    name?: string,
  ) => Promise<{ userId: string; storageState: StorageState }>
}

export const test = base.extend<
  {
    /** POST a signed, schema-valid Stripe event to /stripe/webhook. */
    sendStripeEvent: (event: StripeWebhookEvent) => Promise<APIResponse>
  },
  WorkerOverrides
>({
  // A fork's own sign-in replaces core's POST /api/auth/dev. Same worker-scoped
  // cache by email (see test/e2e/fixtures.ts), but each user signs in on a fresh
  // request context so sessions never share a cookie jar.
  ...(billingE2e.signIn
    ? {
        signInCache: [
          async ({ playwright }, use) => {
            const signIn = billingE2e.signIn!
            const cache = new Map<string, { userId: string; storageState: StorageState }>()
            await use(async (email, name) => {
              const cached = cache.get(email)
              if (cached) return cached
              const request = await playwright.request.newContext({
                baseURL: `http://localhost:${playwrightPort()}`,
                extraHTTPHeaders: workerAddressHeaders(),
              })
              const { userId } = await signIn(request, { email, name })
              const session = {
                userId,
                storageState: await request.storageState(),
              }
              await request.dispose()
              cache.set(email, session)
              return session
            })
          },
          { scope: 'worker' as const },
        ],
      }
    : {}),
  sendStripeEvent: async ({ apiRequest }, use) => {
    await use(async (event) => {
      // Build the payload, THEN sign, THEN post. The server tolerates five
      // minutes of clock difference, but a signature is still only valid for
      // the exact bytes it was made over.
      const body = JSON.stringify(event)
      const signature = await signStripeWebhook(body)
      return apiRequest.post('/stripe/webhook', {
        data: body,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
        },
      })
    })
  },
})
