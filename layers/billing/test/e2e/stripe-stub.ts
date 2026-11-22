// A stand-in for api.stripe.com for the billing E2E suite.
//
// The webhook asks Stripe two things a payload does not carry: the line items
// of a completed Checkout Session (a pass purchase) and the invoice behind a
// refunded payment. The dev server is pointed here through NUXT_STRIPE_API_BASE
// (e2e.config.ts), and a spec tells the stub what to answer by POSTing to
// /__register before it sends the event. The stub holds no state between runs
// and answers 404 for anything nobody registered, as Stripe would.
//
// Started in globalSetup (the Playwright runner process) and stopped in
// globalTeardown; specs run in worker processes, so they reach it over HTTP.

import { createServer, type Server } from 'node:http'

import { playwrightPort } from '../../../../scripts/worktree-port'

/** Clear of every port `playwrightPort()` can hand out (3100–3899). */
export function stripeStubPort(): number {
  return playwrightPort() + 1000
}

export const stripeStubUrl = (): string => `http://127.0.0.1:${stripeStubPort()}`

export interface StubRegistration {
  /** Checkout Session id → the price ids it sold. */
  sessions?: Record<string, string[]>
  /** PaymentIntent id → the invoice and subscription behind it. */
  payments?: Record<string, { invoiceId: string; subscriptionId: string | null }>
}

const sessions = new Map<string, string[]>()
const payments = new Map<string, { invoiceId: string; subscriptionId: string | null }>()
let server: Server | null = null

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startStripeStub(): Promise<void> {
  if (server) return
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/__register') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as StubRegistration
        for (const [id, prices] of Object.entries(body.sessions ?? {})) sessions.set(id, prices)
        for (const [id, refs] of Object.entries(body.payments ?? {})) payments.set(id, refs)
        return json(res, 200, { ok: true })
      }
      const items = /^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/.exec(url.pathname)
      if (req.method === 'GET' && items) {
        const prices = sessions.get(decodeURIComponent(items[1]!))
        if (!prices) return json(res, 404, { error: { code: 'resource_missing' } })
        return json(res, 200, {
          data: prices.map((id) => ({ price: { id, product: 'prod_e2e' } })),
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/invoice_payments') {
        const refs = payments.get(url.searchParams.get('payment[payment_intent]') ?? '')
        if (!refs) return json(res, 200, { data: [] })
        return json(res, 200, {
          data: [
            {
              invoice: {
                id: refs.invoiceId,
                parent: refs.subscriptionId
                  ? {
                      subscription_details: {
                        subscription: refs.subscriptionId,
                      },
                    }
                  : null,
              },
            },
          ],
        })
      }
      return json(res, 404, { error: { code: 'resource_missing' } })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(stripeStubPort(), '127.0.0.1', resolve)
  })
  // Never the reason the runner stays alive.
  server.unref()
}

export async function stopStripeStub(): Promise<void> {
  const current = server
  server = null
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

/** Tell the stub what to answer. Called from specs (worker processes). */
export async function registerWithStub(registration: StubRegistration): Promise<void> {
  const res = await fetch(`${stripeStubUrl()}/__register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registration),
  })
  if (!res.ok) throw new Error(`Stripe stub refused a registration: ${res.status}`)
}
