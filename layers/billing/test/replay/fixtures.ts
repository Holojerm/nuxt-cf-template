// Webhook-replay fixtures: signed Paddle events in Paddle Billing's real
// shapes, for scripts that post them to a running Worker and compare what it
// did. Everything here is invented test data: price ids, customer ids and the
// signing secret are throwaway values, and no Paddle account is involved.
//
// Dates are far-future constants (2099) on purpose. A pass or period that ends
// "now + 30 days" would make `/api/billing/entitlement` differ from one run to
// the next; a constant keeps every dump byte-stable. Ordering between events
// is carried by `occurred_at`, which is what the server orders on.

export const REPLAY_SECRET = 'replay-test-secret-not-a-real-key'
export const PRICE_PASS = 'pri_replay_pass'
export const PRICE_MONTHLY = 'pri_replay_monthly'
/** The Paddle product this app sells (only consulted where a product filter exists). */
export const PRODUCT_OWN = 'pro_replay_own'
export const PRODUCT_FOREIGN = 'pro_replay_foreign'

export interface ReplayUser {
  id: string
  email: string
  name: string
  role: 'user' | 'admin'
}

export const USERS: Record<'buyer' | 'live' | 'free' | 'admin', ReplayUser> = {
  /** Runs the whole purchase / renewal / refund scenario. */
  buyer: { id: 'usr_replay_buyer', email: 'buyer@replay.test', name: 'Buyer', role: 'user' },
  /** Ends the run with a live subscription, to exercise the deletion guard. */
  live: { id: 'usr_replay_live', email: 'live@replay.test', name: 'Live', role: 'user' },
  /** Never buys anything: the paywall gate must refuse them. */
  free: { id: 'usr_replay_free', email: 'free@replay.test', name: 'Free', role: 'user' },
  admin: { id: 'usr_replay_admin', email: 'admin@replay.test', name: 'Admin', role: 'admin' },
}

/** `ts` offsets the signature timestamp from now, in seconds (negative = old). */
export type Signing =
  | { kind: 'valid' }
  | { kind: 'bad_signature' }
  | { kind: 'stale'; ageSeconds: number }

export interface WebhookStep {
  type: 'webhook'
  name: string
  /** The raw body, exactly as signed. */
  body: string
  signing: Signing
}

export interface RequestStep {
  type: 'request'
  name: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  as: keyof typeof USERS | 'fleet' | 'anonymous'
  json?: unknown
}

export type Step = WebhookStep | RequestStep

let seq = 0
const T = (day: number, hour = 0) =>
  new Date(Date.UTC(2099, 0, day, hour)).toISOString().replace('.000Z', 'Z')

interface EventOptions {
  id: string
  eventId?: string
  type: string
  at: string
  data: Record<string, unknown>
}

function event({ id, eventId, type, at, data }: EventOptions): string {
  seq += 1
  return JSON.stringify({
    event_id: eventId ?? `evt_replay_${String(seq).padStart(3, '0')}`,
    event_type: type,
    occurred_at: at,
    notification_id: `ntf_replay_${seq}`,
    data: { id, ...data },
  })
}

function item(priceId: string, productId: string) {
  return {
    status: 'active',
    quantity: 1,
    recurring: priceId === PRICE_MONTHLY,
    price: { id: priceId, product_id: productId, description: 'replay', type: 'standard' },
    product: { id: productId, name: 'replay' },
  }
}

function subscription(
  userId: string | null,
  id: string,
  status: string,
  periodEnds: string,
  extra: Record<string, unknown> = {},
  priceId = PRICE_MONTHLY,
  productId = PRODUCT_OWN,
) {
  return {
    status,
    customer_id: `ctm_${id}`,
    address_id: 'add_replay',
    currency_code: 'USD',
    collection_mode: 'automatic',
    custom_data: userId ? { userId } : null,
    items: [item(priceId, productId)],
    current_billing_period: { starts_at: T(1), ends_at: periodEnds },
    billing_cycle: { frequency: 1, interval: 'month' },
    scheduled_change: null,
    ...extra,
  }
}

function transaction(
  userId: string | null,
  id: string,
  extra: Record<string, unknown> = {},
  priceId = PRICE_PASS,
  productId = PRODUCT_OWN,
) {
  return {
    status: 'completed',
    customer_id: `ctm_${id}`,
    address_id: 'add_replay',
    currency_code: 'USD',
    origin: 'web',
    subscription_id: null,
    custom_data: userId ? { userId } : null,
    items: [{ price: { id: priceId, product_id: productId }, quantity: 1 }],
    billed_at: T(1),
    ...extra,
  }
}

function adjustment(id: string, transactionId: string, extra: Record<string, unknown> = {}) {
  return {
    action: 'refund',
    type: 'full',
    status: 'approved',
    transaction_id: transactionId,
    subscription_id: null,
    customer_id: `ctm_${transactionId}`,
    reason: 'replay',
    currency_code: 'USD',
    ...extra,
  }
}

const hook = (name: string, body: string, signing: Signing = { kind: 'valid' }): WebhookStep => ({
  type: 'webhook',
  name,
  body,
  signing,
})
const get = (name: string, path: string, as: RequestStep['as']): RequestStep => ({
  type: 'request',
  name,
  method: 'GET',
  path,
  as,
})

/** The full replay, in delivery order. */
export function buildSteps(): Step[] {
  seq = 0
  const buyer = USERS.buyer.id
  const live = USERS.live.id
  const steps: Step[] = []

  // ── Before anything is bought ───────────────────────────────────────────────
  // Pages the billing UI provides. SSR status and title only: markup is build-specific.
  steps.push(get('page: /pricing (public)', '/pricing', 'anonymous'))
  steps.push(get('page: /dashboard (signed out)', '/dashboard', 'anonymous'))
  steps.push(get('page: /files (signed out)', '/files', 'anonymous'))
  steps.push(get('seo: sitemap lists the pricing page', '/sitemap.xml', 'anonymous'))
  steps.push(get('seo: llms.txt', '/llms.txt', 'anonymous'))
  steps.push(get('entitlement: nothing bought yet', '/api/billing/entitlement', 'buyer'))
  steps.push(get('paywall gate: free user is refused (402)', '/api/files', 'free'))
  steps.push(get('onboarding: plan step open', '/api/onboarding', 'buyer'))

  // ── A one-time pass (transaction.completed, not recurring) ──────────────────
  const pass1 = hook(
    'pass purchase',
    event({
      id: 'txn_replay_pass1',
      type: 'transaction.completed',
      at: T(1, 1),
      data: transaction(buyer, 'txn_replay_pass1', { billed_at: T(1, 1) }),
    }),
  )
  steps.push(pass1)
  steps.push(get('entitlement: after pass', '/api/billing/entitlement', 'buyer'))
  // Same delivery again (Paddle retry): must be a no-op.
  steps.push({ ...pass1, name: 'duplicate delivery of the pass (same event_id)' })
  // A new event id for the same transaction: grantPass' unique ref refuses it.
  steps.push(
    hook(
      'same transaction under a new event id',
      event({
        id: 'txn_replay_pass1',
        type: 'transaction.completed',
        at: T(1, 2),
        data: transaction(buyer, 'txn_replay_pass1', { billed_at: T(1, 1) }),
      }),
    ),
  )
  // A second pass bought while the first runs: stacks on the first's end.
  steps.push(
    hook(
      'second pass stacks',
      event({
        id: 'txn_replay_pass2',
        type: 'transaction.completed',
        at: T(2, 1),
        data: transaction(buyer, 'txn_replay_pass2', { billed_at: T(2, 1) }),
      }),
    ),
  )

  // ── A monthly subscription: created, renewed, past_due, recovered, cancelled ─
  const subA = 'sub_replay_a'
  steps.push(
    hook(
      'subscription A created',
      event({
        id: subA,
        type: 'subscription.created',
        at: T(3, 1),
        data: subscription(buyer, subA, 'active', T(10), { transaction_id: 'txn_replay_a_first' }),
      }),
    ),
  )
  steps.push(
    hook(
      'subscription A activated',
      event({
        id: subA,
        type: 'subscription.activated',
        at: T(3, 2),
        data: subscription(buyer, subA, 'active', T(10)),
      }),
    ),
  )
  steps.push(get('entitlement: subscription live', '/api/billing/entitlement', 'buyer'))
  // The renewal's transaction: owned by subscription.* events, so ignored here.
  steps.push(
    hook(
      'renewal transaction.completed (ignored)',
      event({
        id: 'txn_replay_a_renewal',
        type: 'transaction.completed',
        at: T(10, 1),
        data: transaction(buyer, 'txn_replay_a_renewal', { subscription_id: subA }, PRICE_MONTHLY),
      }),
    ),
  )
  steps.push(
    hook(
      'subscription A renewed (new period)',
      event({
        id: subA,
        type: 'subscription.updated',
        at: T(10, 2),
        data: subscription(buyer, subA, 'active', T(17)),
      }),
    ),
  )
  steps.push(
    hook(
      'subscription A past_due',
      event({
        id: subA,
        type: 'subscription.past_due',
        at: T(17, 1),
        data: subscription(buyer, subA, 'past_due', T(17)),
      }),
    ),
  )
  steps.push(get('entitlement: past_due', '/api/billing/entitlement', 'buyer'))
  steps.push(
    hook(
      'subscription A recovered',
      event({
        id: subA,
        type: 'subscription.updated',
        at: T(18, 1),
        data: subscription(buyer, subA, 'active', T(24)),
      }),
    ),
  )
  const subAUpdated = event({
    id: subA,
    type: 'subscription.updated',
    at: T(19, 1),
    data: subscription(buyer, subA, 'active', T(24), {
      scheduled_change: { action: 'cancel', effective_at: T(24) },
    }),
  })
  steps.push(hook('subscription A cancel scheduled', subAUpdated))
  steps.push(get('entitlement: cancel scheduled', '/api/billing/entitlement', 'buyer'))
  // Out of order: a delayed older `active` update arrives after the cancel was scheduled.
  steps.push(
    hook(
      'out of order: older update arrives late (stale)',
      event({
        id: subA,
        type: 'subscription.updated',
        at: T(18, 12),
        data: subscription(buyer, subA, 'active', T(24)),
      }),
    ),
  )
  steps.push(
    hook(
      'subscription A canceled (scheduled change applied)',
      event({
        id: subA,
        type: 'subscription.canceled',
        at: T(24, 1),
        data: subscription(buyer, subA, 'canceled', T(24)),
      }),
    ),
  )

  // Immediate cancel: B is created and cancelled straight away.
  const subB = 'sub_replay_b'
  steps.push(
    hook(
      'subscription B created',
      event({
        id: subB,
        type: 'subscription.created',
        at: T(5, 1),
        data: subscription(buyer, subB, 'active', T(12)),
      }),
    ),
  )
  steps.push(
    hook(
      'subscription B canceled immediately',
      event({
        id: subB,
        type: 'subscription.canceled',
        at: T(5, 2),
        data: subscription(buyer, subB, 'canceled', T(12), {
          canceled_at: T(5, 2),
        }),
      }),
    ),
  )

  // Out of order the other way: the update is delivered BEFORE the create.
  const subC = 'sub_replay_c'
  steps.push(
    hook(
      'out of order: subscription C updated (past_due) first',
      event({
        id: subC,
        type: 'subscription.updated',
        at: T(8, 2),
        data: subscription(buyer, subC, 'past_due', T(15)),
      }),
    ),
  )
  steps.push(
    hook(
      'out of order: subscription C created arrives late (stale)',
      event({
        id: subC,
        type: 'subscription.created',
        at: T(8, 1),
        data: subscription(buyer, subC, 'active', T(15)),
      }),
    ),
  )

  // ── Refunds ─────────────────────────────────────────────────────────────────
  steps.push(
    hook(
      'refund of the first pass',
      event({
        id: 'adj_replay_1',
        type: 'adjustment.created',
        at: T(20, 1),
        data: adjustment('adj_replay_1', 'txn_replay_pass1'),
      }),
    ),
  )
  steps.push(get('entitlement: after refund', '/api/billing/entitlement', 'buyer'))
  steps.push(
    hook(
      'refund matching nothing (unmatched adjustment)',
      event({
        id: 'adj_replay_2',
        type: 'adjustment.created',
        at: T(20, 2),
        data: adjustment('adj_replay_2', 'txn_replay_nobody'),
      }),
    ),
  )

  // ── Events that must grant nothing ──────────────────────────────────────────
  steps.push(
    hook(
      'foreign product (another app sharing the account)',
      event({
        id: 'txn_replay_foreign',
        type: 'transaction.completed',
        at: T(21, 1),
        data: transaction(buyer, 'txn_replay_foreign', {}, 'pri_replay_other', PRODUCT_FOREIGN),
      }),
    ),
  )
  steps.push(
    hook(
      'unrecognised price on our own product',
      event({
        id: 'txn_replay_unpriced',
        type: 'transaction.completed',
        at: T(21, 2),
        data: transaction(buyer, 'txn_replay_unpriced', {}, 'pri_replay_unlisted', PRODUCT_OWN),
      }),
    ),
  )
  steps.push(
    hook(
      'unknown user (custom_data names no account)',
      event({
        id: 'txn_replay_ghost',
        type: 'transaction.completed',
        at: T(21, 3),
        data: transaction('usr_replay_ghost', 'txn_replay_ghost'),
      }),
    ),
  )
  steps.push(
    hook(
      'no user (no custom_data at all)',
      event({
        id: 'txn_replay_anon',
        type: 'transaction.completed',
        at: T(21, 4),
        data: transaction(null, 'txn_replay_anon'),
      }),
    ),
  )
  steps.push(
    hook(
      'unhandled event type',
      event({ id: 'cus_replay_1', type: 'customer.updated', at: T(21, 5), data: {} }),
    ),
  )

  // ── Hostile deliveries ──────────────────────────────────────────────────────
  steps.push(hook('malformed body (signed, not JSON)', '{ this is not json'))
  steps.push(hook('well-formed JSON, wrong shape', JSON.stringify({ hello: 'world' })))
  steps.push(
    hook(
      'bad signature',
      event({
        id: 'txn_replay_forged',
        type: 'transaction.completed',
        at: T(22, 1),
        data: transaction(buyer, 'txn_replay_forged'),
      }),
      { kind: 'bad_signature' },
    ),
  )
  steps.push(
    hook(
      'stale timestamp (60s old)',
      event({
        id: 'txn_replay_late',
        type: 'transaction.completed',
        at: T(22, 2),
        data: transaction(buyer, 'txn_replay_late'),
      }),
      { kind: 'stale', ageSeconds: 60 },
    ),
  )

  // ── A second customer ends the run with a live subscription ─────────────────
  steps.push(
    hook(
      'live customer: subscription created',
      event({
        id: 'sub_replay_live',
        type: 'subscription.created',
        at: T(25, 1),
        data: subscription(live, 'sub_replay_live', 'active', T(28)),
      }),
    ),
  )

  // ── What the rest of the app says once all that has happened ────────────────
  steps.push(get('entitlement: final (buyer)', '/api/billing/entitlement', 'buyer'))
  steps.push(get('entitlement: final (live customer)', '/api/billing/entitlement', 'live'))
  steps.push(get('entitlement: signed out', '/api/billing/entitlement', 'anonymous'))
  steps.push(get('paywall gate: subscriber passes the gate', '/api/files', 'live'))
  steps.push(get('onboarding: plan step done', '/api/onboarding', 'live'))
  steps.push(get('data export', '/api/account/export', 'buyer'))
  steps.push(get('admin: one-customer view', `/api/admin/users/${buyer}`, 'admin'))
  steps.push(get('admin: view as', `/api/admin/users/${buyer}/view-as`, 'admin'))
  steps.push(get('fleet counters', '/api/fleet', 'fleet'))
  // Not replayed: DELETE /api/account. A DELETE request with a body hangs under
  // `wrangler dev` (workerd reports "Worker's code had hung" before the handler
  // runs, on origin/main too), so the deletion guard is pinned by
  // test/account.test.ts and layers/billing/test/billing-extensions.test.ts instead.
  steps.push({
    type: 'request',
    name: 'portal link without an API key (503)',
    method: 'POST',
    path: '/api/billing/portal',
    as: 'buyer',
    json: {},
  })
  return steps
}
