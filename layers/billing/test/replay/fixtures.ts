// Webhook-replay fixtures: signed Stripe events in Stripe's real shapes, for
// scripts that post them to a running Worker and compare what it did. Everything
// here is invented test data: price ids, customer ids and the signing secret are
// throwaway values, and no Stripe account is involved. The two lookups the
// webhook makes (a session's line items, the invoice behind a payment) are
// answered by a stub the script starts; what it answers is recorded in
// LINE_ITEMS and PAYMENT_REFS as the steps are built.
//
// Dates are far-future constants (2099) on purpose. A pass or period that ends
// "now + 30 days" would make `/api/billing/entitlement` differ from one run to
// the next; a constant keeps every dump byte-stable. Ordering between events
// is carried by `created`, which is what the server orders on.

export const REPLAY_SECRET = 'whsec_replay_test_secret_not_a_real_key'
/** The key the Worker is given; only the stub ever sees it. */
export const STUB_SECRET_KEY = 'sk_test_replay_stub_key'
export const PRICE_PASS = 'price_replay_pass'
export const PRICE_MONTHLY = 'price_replay_monthly'
/** The Stripe product this app sells (only consulted where a product filter exists). */
export const PRODUCT_OWN = 'prod_replay_own'
export const PRODUCT_FOREIGN = 'prod_replay_foreign'

export interface ReplayUser {
  id: string
  email: string
  name: string
  role: 'user' | 'admin'
}

export const USERS: Record<'buyer' | 'live' | 'free' | 'admin', ReplayUser> = {
  /** Runs the whole purchase / renewal / refund scenario. */
  buyer: {
    id: 'usr_replay_buyer',
    email: 'buyer@replay.test',
    name: 'Buyer',
    role: 'user',
  },
  /** Ends the run with a live subscription, to exercise the deletion guard. */
  live: {
    id: 'usr_replay_live',
    email: 'live@replay.test',
    name: 'Live',
    role: 'user',
  },
  /** Never buys anything: the paywall gate must refuse them. */
  free: {
    id: 'usr_replay_free',
    email: 'free@replay.test',
    name: 'Free',
    role: 'user',
  },
  admin: {
    id: 'usr_replay_admin',
    email: 'admin@replay.test',
    name: 'Admin',
    role: 'admin',
  },
}

/**
 * Only in the `--cancel-on-deletion` run, each holding a live subscription the
 * stub Stripe API answers differently when account deletion tries to cancel it.
 * Kept out of USERS so the default run's users table is untouched.
 */
export const CANCEL_USERS: Record<'blocked' | 'settled', ReplayUser> = {
  /** The stub answers 403 (a key without Subscriptions: write): deletion must be refused. */
  blocked: {
    id: 'usr_replay_blocked',
    email: 'blocked@replay.test',
    name: 'Blocked',
    role: 'user',
  },
  /** The stub says the subscription is already cancelled: that counts as success. */
  settled: {
    id: 'usr_replay_settled',
    email: 'settled@replay.test',
    name: 'Settled',
    role: 'user',
  },
}

/**
 * The referral loop's cast. All inserted with the other users, so they exist
 * before the first request. `referredBy` is the referrer's code, resolved at
 * signup in a real app and written directly here.
 */
export const REFERRAL_CODE = 'RFRR2222'
/** Well-formed (so the attribution schema keeps it) but held by nobody. */
export const UNHELD_CODE = 'ZZZZ2222'

export interface ReferralReplayUser extends ReplayUser {
  referralCode: string | null
  referredBy: string | null
}

export const REFERRAL_USERS: Record<
  'referrer' | 'refereePass' | 'refereeSub' | 'twin',
  ReferralReplayUser
> = {
  /** Holds the code the others arrive on, and is paid when they do. */
  referrer: {
    id: 'usr_replay_referrer',
    email: 'referrer@replay.test',
    name: 'Referrer',
    role: 'user',
    referralCode: REFERRAL_CODE,
    referredBy: null,
  },
  /** Arrived on the code; buys a pass, which is later refunded. */
  refereePass: {
    id: 'usr_replay_referee_pass',
    email: 'referee.pass@replay.test',
    name: 'Referee Pass',
    role: 'user',
    referralCode: 'RFEP2222',
    referredBy: REFERRAL_CODE,
  },
  /** Arrived on the code; subscribes, then a chargeback is raised and won. */
  refereeSub: {
    id: 'usr_replay_referee_sub',
    email: 'referee.sub@replay.test',
    name: 'Referee Sub',
    role: 'user',
    referralCode: 'RFES2222',
    referredBy: REFERRAL_CODE,
  },
  /** The referrer's own mailbox under a +tag: a self-referral, paid nothing. */
  twin: {
    id: 'usr_replay_twin',
    email: 'referrer+twin@replay.test',
    name: 'Twin',
    role: 'user',
    referralCode: 'RTWN2222',
    referredBy: REFERRAL_CODE,
  },
}

/**
 * Sign-ins that CREATE an account, through the real magic-link route: a token
 * row per person is written to D1 (its SHA-256 is all the server ever stores)
 * and redeemed with POST /api/auth/magic-link/verify. The response's session
 * cookie is kept under `key`, so later steps can be that person.
 */
export const MAGIC_LINK_SIGNUPS = {
  /** Arrives on the referrer's code: gets the welcome days. */
  invitee: {
    token: 'replay-token-invitee-0123456789abcdefghijklmn',
    email: 'invitee@replay.test',
    referralCode: REFERRAL_CODE,
  },
  /** Arrives on a code nobody holds: an ordinary signup. */
  stranger: {
    token: 'replay-token-stranger-0123456789abcdefghijklm',
    email: 'stranger@replay.test',
    referralCode: UNHELD_CODE,
  },
} as const

export type UserKey =
  | keyof typeof USERS
  | keyof typeof CANCEL_USERS
  | keyof typeof REFERRAL_USERS
  | keyof typeof MAGIC_LINK_SIGNUPS

/**
 * What the stub answers when the cancel-on-deletion run DELETEs a subscription;
 * everything else gets 200. A 400 also reads back as already cancelled.
 */
export const STUB_ANSWERS: Record<string, { status: number; code?: string }> = {
  sub_replay_blocked: { status: 403, code: 'permission' },
  sub_replay_settled: { status: 400, code: 'resource_already_canceled' },
}

/** Checkout Session id → what it sold, for the stub's line-items answer. */
export const LINE_ITEMS = new Map<string, { price: string; product: string }>()
/** PaymentIntent id → the invoice and subscription behind it, for the stub's invoice_payments answer. */
export const PAYMENT_REFS = new Map<string, { invoiceId: string; subscriptionId: string }>()

/** `ageSeconds` backdates the signature timestamp from now. */
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
  method: 'GET' | 'POST'
  path: string
  as: UserKey | 'fleet' | 'anonymous'
  json?: unknown
  /** Keep the session cookie this response sets, as this user. */
  capture?: keyof typeof MAGIC_LINK_SIGNUPS
}

export type Step = WebhookStep | RequestStep

let seq = 0
/** A 2099 instant in unix seconds: the unit Stripe stamps events and periods in. */
const S = (day: number, hour = 0) => Math.floor(Date.UTC(2099, 0, day, hour) / 1000)

function event(type: string, at: number, object: Record<string, unknown>): string {
  seq += 1
  return JSON.stringify({
    id: `evt_replay_${String(seq).padStart(3, '0')}`,
    type,
    created: at,
    livemode: false,
    data: { object },
  })
}

/** A Stripe subscription object, `extra` overriding any field. */
function subscription(
  userId: string | null,
  id: string,
  status: string,
  periodEnds: number,
  extra: Record<string, unknown> = {},
  priceId = PRICE_MONTHLY,
  productId = PRODUCT_OWN,
) {
  return {
    id,
    status,
    customer: `cus_${id}`,
    metadata: userId ? { userId } : {},
    cancel_at_period_end: false,
    cancel_at: null,
    latest_invoice: null,
    items: {
      data: [
        {
          current_period_end: periodEnds,
          price: { id: priceId, product: productId },
        },
      ],
    },
    ...extra,
  }
}

/**
 * A paid one-time Checkout Session. Registers what the stub will say it sold,
 * because the webhook asks: the payload carries no line items.
 */
function passSession(
  userId: string | null,
  name: string,
  priceId = PRICE_PASS,
  productId = PRODUCT_OWN,
) {
  const id = `cs_replay_${name}`
  LINE_ITEMS.set(id, { price: priceId, product: productId })
  return {
    id,
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: `pi_replay_${name}`,
    customer: `cus_replay_${name}`,
    client_reference_id: userId,
    metadata: userId ? { userId } : {},
  }
}

function charge(name: string) {
  return {
    id: `ch_replay_${name}`,
    payment_intent: `pi_replay_${name}`,
    refunded: true,
    amount_refunded: 1800,
  }
}

function dispute(name: string, status: string) {
  return {
    id: `dp_replay_${name}`,
    status,
    charge: `ch_replay_${name}`,
    payment_intent: `pi_replay_${name}`,
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

const post = (
  name: string,
  path: string,
  as: RequestStep['as'],
  json: unknown,
  capture?: RequestStep['capture'],
): RequestStep => ({
  type: 'request',
  name,
  method: 'POST',
  path,
  as,
  json,
  ...(capture ? { capture } : {}),
})

export interface BuildOptions {
  /**
   * Include the referral loop: welcome days through a real sign-in, a
   * referrer's reward on a referee's first payment, its clawback and restore,
   * a self-referral, and the share card's endpoint. Default true. A fork whose
   * `users` table has no referral columns passes false (`--no-referral`).
   */
  referral?: boolean
  /**
   * Run as an app with `billing.cancelOnDeletion` on: deletion cancels live
   * subscriptions at the stub Stripe API first. Off (the default), the steps are
   * exactly those of a build without the option.
   */
  cancelOnDeletion?: boolean
}

/** The full replay, in delivery order. */
export function buildSteps(options: BuildOptions = {}): Step[] {
  seq = 0
  LINE_ITEMS.clear()
  PAYMENT_REFS.clear()
  const buyer = USERS.buyer.id
  const live = USERS.live.id
  const steps: Step[] = []

  // ── Before anything is bought ───────────────────────────────────────────────
  // Pages the billing UI provides. SSR status and title only: markup is build-specific.
  steps.push(get('page: /pricing (public)', '/pricing', 'anonymous'))
  steps.push(
    get('page: /pricing (returned from Stripe)', '/pricing?checkout=canceled', 'anonymous'),
  )
  steps.push(get('page: /dashboard (signed out)', '/dashboard', 'anonymous'))
  steps.push(get('page: /files (signed out)', '/files', 'anonymous'))
  steps.push(get('seo: sitemap lists the pricing page', '/sitemap.xml', 'anonymous'))
  steps.push(get('seo: llms.txt', '/llms.txt', 'anonymous'))
  steps.push(get('entitlement: nothing bought yet', '/api/billing/entitlement', 'buyer'))
  steps.push(get('paywall gate: free user is refused (402)', '/api/files', 'free'))
  steps.push(get('onboarding: plan step open', '/api/onboarding', 'buyer'))
  steps.push(
    post('checkout: signed out is refused (401)', '/api/billing/checkout', 'anonymous', {
      plan: 'pass',
    }),
    post('checkout: an unknown plan is refused (400)', '/api/billing/checkout', 'buyer', {
      plan: 'lifetime',
    }),
    post('checkout: a session for the pass (200)', '/api/billing/checkout', 'buyer', {
      plan: 'pass',
    }),
  )

  // ── A one-time pass (checkout.session.completed in payment mode) ────────────
  const pass1 = hook(
    'pass purchase',
    event('checkout.session.completed', S(1, 1), passSession(buyer, 'pass1')),
  )
  steps.push(pass1)
  steps.push(get('entitlement: after pass', '/api/billing/entitlement', 'buyer'))
  // Same delivery again (a Stripe retry): must be a no-op.
  steps.push({
    ...pass1,
    name: 'duplicate delivery of the pass (same event id)',
  })
  // A new event id for the same payment: grantPass' unique ref refuses it.
  steps.push(
    hook(
      'same payment under a new event id',
      event('checkout.session.completed', S(1, 2), passSession(buyer, 'pass1')),
    ),
  )
  // A second pass bought while the first runs: stacks on the first's end.
  steps.push(
    hook(
      'second pass stacks',
      event('checkout.session.completed', S(2, 1), passSession(buyer, 'pass2')),
    ),
  )
  // A card that settles later: `completed` arrives unpaid and grants nothing,
  // the async event is the one that says the money landed.
  steps.push(
    hook(
      'delayed-payment session completed unpaid (grants nothing)',
      event('checkout.session.completed', S(2, 2), {
        ...passSession(buyer, 'delayed'),
        payment_status: 'unpaid',
      }),
    ),
    hook(
      'delayed payment succeeds (grants the pass)',
      event('checkout.session.async_payment_succeeded', S(2, 3), passSession(buyer, 'delayed')),
    ),
  )

  // ── A monthly subscription: created, renewed, past_due, recovered, cancelled ─
  const subA = 'sub_replay_a'
  steps.push(
    hook(
      'subscription A created',
      event(
        'customer.subscription.created',
        S(3, 1),
        subscription(buyer, subA, 'active', S(10), {
          latest_invoice: 'in_replay_a_first',
        }),
      ),
    ),
  )
  steps.push(
    hook(
      'subscription A first payment confirmed (updated, same status)',
      event(
        'customer.subscription.updated',
        S(3, 2),
        subscription(buyer, subA, 'active', S(10), {
          latest_invoice: 'in_replay_a_first',
        }),
      ),
    ),
  )
  steps.push(get('entitlement: subscription live', '/api/billing/entitlement', 'buyer'))
  // A renewal's invoice: owned by customer.subscription.* events, not subscribed to.
  steps.push(
    hook(
      'renewal invoice.paid (not handled, acknowledged)',
      event('invoice.paid', S(10, 1), {
        id: 'in_replay_a_renewal',
        subscription: subA,
      }),
    ),
  )
  steps.push(
    hook(
      'subscription A renewed (new period)',
      event(
        'customer.subscription.updated',
        S(10, 2),
        subscription(buyer, subA, 'active', S(17), {
          latest_invoice: 'in_replay_a_renewal',
        }),
      ),
    ),
  )
  steps.push(
    hook(
      'subscription A past_due',
      event(
        'customer.subscription.updated',
        S(17, 1),
        subscription(buyer, subA, 'past_due', S(17)),
      ),
    ),
  )
  steps.push(get('entitlement: past_due', '/api/billing/entitlement', 'buyer'))
  steps.push(
    hook(
      'subscription A recovered',
      event('customer.subscription.updated', S(18, 1), subscription(buyer, subA, 'active', S(24))),
    ),
  )
  steps.push(
    hook(
      'subscription A cancel scheduled',
      event(
        'customer.subscription.updated',
        S(19, 1),
        subscription(buyer, subA, 'active', S(24), {
          cancel_at_period_end: true,
          cancel_at: S(24),
        }),
      ),
    ),
  )
  steps.push(get('entitlement: cancel scheduled', '/api/billing/entitlement', 'buyer'))
  // Out of order: a delayed older `active` update arrives after the cancel was scheduled.
  steps.push(
    hook(
      'out of order: older update arrives late (stale)',
      event('customer.subscription.updated', S(18, 12), subscription(buyer, subA, 'active', S(24))),
    ),
  )
  steps.push(
    hook(
      'subscription A deleted (scheduled cancel applied)',
      event(
        'customer.subscription.deleted',
        S(24, 1),
        subscription(buyer, subA, 'canceled', S(24)),
      ),
    ),
  )

  // Immediate cancel: B is created and cancelled straight away.
  const subB = 'sub_replay_b'
  steps.push(
    hook(
      'subscription B created',
      event('customer.subscription.created', S(5, 1), subscription(buyer, subB, 'active', S(12))),
    ),
  )
  steps.push(
    hook(
      'subscription B deleted immediately',
      event('customer.subscription.deleted', S(5, 2), subscription(buyer, subB, 'canceled', S(12))),
    ),
  )

  // A card that needs a challenge: nothing is bought until the first payment lands.
  steps.push(
    hook(
      'subscription D created incomplete (no row)',
      event(
        'customer.subscription.created',
        S(6, 1),
        subscription(buyer, 'sub_replay_d', 'incomplete', S(13)),
      ),
    ),
  )

  // Out of order the other way: the update is delivered BEFORE the create.
  const subC = 'sub_replay_c'
  steps.push(
    hook(
      'out of order: subscription C updated (past_due) first',
      event('customer.subscription.updated', S(8, 2), subscription(buyer, subC, 'past_due', S(15))),
    ),
  )
  steps.push(
    hook(
      'out of order: subscription C created arrives late (stale)',
      event('customer.subscription.created', S(8, 1), subscription(buyer, subC, 'active', S(15))),
    ),
  )

  // ── Refunds ─────────────────────────────────────────────────────────────────
  steps.push(hook('refund of the first pass', event('charge.refunded', S(20, 1), charge('pass1'))))
  steps.push(get('entitlement: after refund', '/api/billing/entitlement', 'buyer'))
  steps.push(
    hook(
      'refund matching nothing (unmatched adjustment)',
      event('charge.refunded', S(20, 2), charge('nobody')),
    ),
  )

  // ── Events that must grant nothing ──────────────────────────────────────────
  steps.push(
    hook(
      'foreign product (another app sharing the account)',
      event(
        'checkout.session.completed',
        S(21, 1),
        passSession(buyer, 'foreign', 'price_replay_other', PRODUCT_FOREIGN),
      ),
    ),
  )
  steps.push(
    hook(
      'unrecognised price on our own product',
      event(
        'checkout.session.completed',
        S(21, 2),
        passSession(buyer, 'unpriced', 'price_replay_unlisted', PRODUCT_OWN),
      ),
    ),
  )
  steps.push(
    hook(
      'unknown user (metadata names no account)',
      event('checkout.session.completed', S(21, 3), passSession('usr_replay_ghost', 'ghost')),
    ),
  )
  steps.push(
    hook(
      'no user (no metadata at all)',
      event('checkout.session.completed', S(21, 4), passSession(null, 'anon')),
    ),
  )
  steps.push(
    hook('unhandled event type', event('customer.updated', S(21, 5), { id: 'cus_replay_1' })),
  )

  // ── Hostile deliveries ──────────────────────────────────────────────────────
  steps.push(hook('malformed body (signed, not JSON)', '{ this is not json'))
  steps.push(hook('well-formed JSON, wrong shape', JSON.stringify({ hello: 'world' })))
  steps.push(
    hook(
      'handled type with an unreadable object',
      event('charge.refunded', S(22, 3), { nope: true }),
    ),
  )
  steps.push(
    hook(
      'bad signature',
      event('checkout.session.completed', S(22, 1), passSession(buyer, 'forged')),
      { kind: 'bad_signature' },
    ),
  )
  steps.push(
    hook(
      'stale timestamp (10 minutes old)',
      event('checkout.session.completed', S(22, 2), passSession(buyer, 'late')),
      { kind: 'stale', ageSeconds: 600 },
    ),
  )

  // ── A second customer ends the run with a live subscription ─────────────────
  steps.push(
    hook(
      'live customer: subscription created',
      event(
        'customer.subscription.created',
        S(25, 1),
        subscription(live, 'sub_replay_live', 'active', S(28)),
      ),
    ),
  )

  if (options.cancelOnDeletion) {
    for (const user of Object.values(CANCEL_USERS)) {
      const id = `sub_replay_${user.id.replace('usr_replay_', '')}`
      steps.push(
        hook(
          `${user.name.toLowerCase()} customer: subscription created`,
          event(
            'customer.subscription.created',
            S(25, 2),
            subscription(user.id, id, 'active', S(28)),
          ),
        ),
      )
    }
  }

  if (options.referral !== false) steps.push(...referralSteps())

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
  // ── Account deletion, through the built Worker ──────────────────────────────
  // POST /api/account/delete, not DELETE: a DELETE body never reaches the handler on
  // Workers (the request hangs). A wrong confirmation changes nothing, a customer with
  // a live subscription is refused by billing's guard, and a plain account is deleted.
  // The deleted row's tombstone shows in the users dump.
  steps.push(
    post('delete account: wrong confirmation (400)', '/api/account/delete', 'free', {
      confirmEmail: 'someone-else@replay.test',
    }),
    post('delete account: signed out (401)', '/api/account/delete', 'anonymous', {
      confirmEmail: USERS.free.email,
    }),
  )
  if (options.cancelOnDeletion) {
    // With the option on the same customer is not refused: Stripe (the stub) is
    // asked to cancel, then the account is deleted; a refused cancel refuses the
    // deletion; and the cancel's echo for a deleted customer is a 200 no-op.
    steps.push(
      post(
        'delete account: stub refuses the cancel, nothing deleted (409)',
        '/api/account/delete',
        'blocked',
        {
          confirmEmail: CANCEL_USERS.blocked.email,
        },
      ),
      post(
        'delete account: live subscription cancelled, then deleted (200)',
        '/api/account/delete',
        'live',
        {
          confirmEmail: USERS.live.email,
        },
      ),
      hook(
        'the cancel’s echo for the deleted customer (200, no alert)',
        event(
          'customer.subscription.deleted',
          S(26, 1),
          subscription(live, 'sub_replay_live', 'canceled', S(28)),
        ),
      ),
      post(
        'delete account: already cancelled at Stripe counts as cancelled (200)',
        '/api/account/delete',
        'settled',
        {
          confirmEmail: CANCEL_USERS.settled.email,
        },
      ),
    )
  } else {
    steps.push(
      post('delete account: live subscription refused (409)', '/api/account/delete', 'live', {
        confirmEmail: USERS.live.email,
      }),
    )
  }
  steps.push(
    post('delete account: plain account (200)', '/api/account/delete', 'free', {
      confirmEmail: USERS.free.email,
    }),
  )
  // The stub mints the portal sessions. A customer with no billing history has
  // nothing to open.
  steps.push(
    post('portal links for the buyer (200)', '/api/billing/portal', 'buyer', {}),
    post('portal links with no billing history (404)', '/api/billing/portal', 'admin', {}),
  )
  return steps
}

/**
 * The referral loop, end to end. Every payout here is a decision the loop makes
 * on its own, so each step is one: who gets days, who does not, and what a
 * reversal puts back.
 */
function referralSteps(): Step[] {
  const { referrer, refereePass, refereeSub, twin } = REFERRAL_USERS
  const steps: Step[] = []

  // ── The referee's half: welcome days through a real sign-in ─────────────────
  steps.push(
    post(
      'sign-in: new account on the referrer’s code (welcome days)',
      '/api/auth/magic-link/verify',
      'anonymous',
      { token: MAGIC_LINK_SIGNUPS.invitee.token },
      'invitee',
    ),
    post(
      'sign-in: new account on a code nobody holds (no welcome days)',
      '/api/auth/magic-link/verify',
      'anonymous',
      { token: MAGIC_LINK_SIGNUPS.stranger.token },
      'stranger',
    ),
    get('entitlement: invitee holds welcome days', '/api/billing/entitlement', 'invitee'),
    get('entitlement: stranger holds nothing', '/api/billing/entitlement', 'stranger'),
    get('share card: invitee', '/api/referral/me', 'invitee'),
    get('share card: referrer before any reward', '/api/referral/me', 'referrer'),
  )

  // ── The referrer's half: paid when a referee first pays ────────────────────
  steps.push(
    hook(
      'referee buys a pass (referrer is rewarded)',
      event('checkout.session.completed', S(3, 3), passSession(refereePass.id, 'ref_pass')),
    ),
  )
  steps.push(
    hook(
      'the same payment under a new event id (no second reward)',
      event('checkout.session.completed', S(3, 4), passSession(refereePass.id, 'ref_pass')),
    ),
  )
  const subId = 'sub_replay_ref_sub'
  const subFirstInvoice = 'in_replay_ref_sub_first'
  steps.push(
    hook(
      'referee subscribes (second reward, keyed on the first invoice)',
      event(
        'customer.subscription.created',
        S(4, 3),
        subscription(refereeSub.id, subId, 'active', S(11), {
          latest_invoice: subFirstInvoice,
        }),
      ),
    ),
  )
  steps.push(
    hook(
      'the twin buys a pass (self-referral, no reward)',
      event('checkout.session.completed', S(4, 4), passSession(twin.id, 'ref_twin')),
    ),
  )
  steps.push(
    get('entitlement: referrer after two rewards', '/api/billing/entitlement', 'referrer'),
    get('share card: referrer after two rewards', '/api/referral/me', 'referrer'),
  )

  // ── Reversals: the reward goes with the purchase, and comes back with it ────
  // The subscription's first payment: a dispute names its PaymentIntent, and the
  // stub says which invoice and subscription that was.
  PAYMENT_REFS.set('pi_replay_ref_sub_first', {
    invoiceId: subFirstInvoice,
    subscriptionId: subId,
  })
  steps.push(
    hook(
      'refund of the referee’s pass (reward revoked)',
      event('charge.refunded', S(6, 1), charge('ref_pass')),
    ),
    get('entitlement: referrer after the refund', '/api/billing/entitlement', 'referrer'),
    get('share card: referrer after the refund', '/api/referral/me', 'referrer'),
    hook(
      'chargeback on the referee’s subscription (reward revoked)',
      event('charge.dispute.created', S(6, 2), dispute('ref_sub_first', 'needs_response')),
    ),
    hook(
      'the chargeback is won (reward restored)',
      event('charge.dispute.closed', S(6, 3), dispute('ref_sub_first', 'won')),
    ),
    get('entitlement: referrer after the reversal', '/api/billing/entitlement', 'referrer'),
    get('share card: referrer after the reversal', '/api/referral/me', 'referrer'),
    get('data export: referrer', '/api/account/export', 'referrer'),
    get('admin: one-customer view of the referrer', `/api/admin/users/${referrer.id}`, 'admin'),
    get('admin: view as the referrer', `/api/admin/users/${referrer.id}/view-as`, 'admin'),
  )
  return steps
}
