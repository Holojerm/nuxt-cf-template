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

/**
 * Only in the `--cancel-on-deletion` run, each holding a live subscription the
 * stub Paddle API answers differently when account deletion tries to cancel it.
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

/** What the stub answers for a subscription id; everything else gets 200. */
export const STUB_ANSWERS: Record<string, { status: number; code?: string }> = {
  sub_replay_blocked: { status: 403, code: 'forbidden' },
  sub_replay_settled: { status: 400, code: 'subscription_is_canceled_action_invalid' },
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
  method: 'GET' | 'POST'
  path: string
  as: UserKey | 'fleet' | 'anonymous'
  json?: unknown
  /** Keep the session cookie this response sets, as this user. */
  capture?: keyof typeof MAGIC_LINK_SIGNUPS
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
   * Run as an app with `billing.cancelOnDeletion` on, against a stub Paddle API:
   * deletion cancels live subscriptions first. Off (the default), the steps are
   * exactly those of a build without the option.
   */
  cancelOnDeletion?: boolean
}

/** The full replay, in delivery order. */
export function buildSteps(options: BuildOptions = {}): Step[] {
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

  if (options.cancelOnDeletion) {
    for (const user of Object.values(CANCEL_USERS)) {
      const id = `sub_replay_${user.id.replace('usr_replay_', '')}`
      steps.push(
        hook(
          `${user.name.toLowerCase()} customer: subscription created`,
          event({
            id,
            type: 'subscription.created',
            at: T(25, 2),
            data: subscription(user.id, id, 'active', T(28)),
          }),
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
    // With the option on the same customer is not refused: Paddle (the stub) is
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
        event({
          id: 'sub_replay_live',
          type: 'subscription.canceled',
          at: T(26, 1),
          data: subscription(live, 'sub_replay_live', 'canceled', T(28), {
            canceled_at: T(26, 1),
          }),
        }),
      ),
      post(
        'delete account: already cancelled at Paddle counts as cancelled (200)',
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
  // The stub run has a key configured; this step is the no-key refusal.
  if (!options.cancelOnDeletion) {
    steps.push({
      type: 'request',
      name: 'portal link without an API key (503)',
      method: 'POST',
      path: '/api/billing/portal',
      as: 'buyer',
      json: {},
    })
  }
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
  const passTxn = 'txn_replay_ref_pass'
  const passPurchase = event({
    id: passTxn,
    type: 'transaction.completed',
    at: T(3, 3),
    data: transaction(refereePass.id, passTxn, { billed_at: T(3, 3) }),
  })
  steps.push(hook('referee buys a pass (referrer is rewarded)', passPurchase))
  steps.push(
    hook(
      'the same transaction under a new event id (no second reward)',
      event({
        id: passTxn,
        type: 'transaction.completed',
        at: T(3, 4),
        data: transaction(refereePass.id, passTxn, { billed_at: T(3, 3) }),
      }),
    ),
  )
  const subId = 'sub_replay_ref_sub'
  const subFirstTxn = 'txn_replay_ref_sub_first'
  steps.push(
    hook(
      'referee subscribes (second reward, keyed on the first transaction)',
      event({
        id: subId,
        type: 'subscription.created',
        at: T(4, 3),
        data: subscription(refereeSub.id, subId, 'active', T(11), {
          transaction_id: subFirstTxn,
        }),
      }),
    ),
  )
  steps.push(
    hook(
      'the twin buys a pass (self-referral, no reward)',
      event({
        id: 'txn_replay_ref_twin',
        type: 'transaction.completed',
        at: T(4, 4),
        data: transaction(twin.id, 'txn_replay_ref_twin', { billed_at: T(4, 4) }),
      }),
    ),
  )
  steps.push(
    get('entitlement: referrer after two rewards', '/api/billing/entitlement', 'referrer'),
    get('share card: referrer after two rewards', '/api/referral/me', 'referrer'),
  )

  // ── Reversals: the reward goes with the purchase, and comes back with it ────
  steps.push(
    hook(
      'refund of the referee’s pass (reward revoked)',
      event({
        id: 'adj_replay_ref_1',
        type: 'adjustment.created',
        at: T(6, 1),
        data: adjustment('adj_replay_ref_1', passTxn),
      }),
    ),
    get('entitlement: referrer after the refund', '/api/billing/entitlement', 'referrer'),
    get('share card: referrer after the refund', '/api/referral/me', 'referrer'),
    hook(
      'chargeback on the referee’s subscription (reward revoked)',
      event({
        id: 'adj_replay_ref_2',
        type: 'adjustment.created',
        at: T(6, 2),
        data: adjustment('adj_replay_ref_2', subFirstTxn, {
          action: 'chargeback',
          subscription_id: subId,
        }),
      }),
    ),
    hook(
      'the chargeback is won (reward restored)',
      event({
        id: 'adj_replay_ref_3',
        type: 'adjustment.updated',
        at: T(6, 3),
        data: adjustment('adj_replay_ref_3', subFirstTxn, {
          action: 'chargeback_reverse',
          subscription_id: subId,
        }),
      }),
    ),
    get('entitlement: referrer after the reversal', '/api/billing/entitlement', 'referrer'),
    get('share card: referrer after the reversal', '/api/referral/me', 'referrer'),
    get('data export: referrer', '/api/account/export', 'referrer'),
    get('admin: one-customer view of the referrer', `/api/admin/users/${referrer.id}`, 'admin'),
    get('admin: view as the referrer', `/api/admin/users/${referrer.id}/view-as`, 'admin'),
  )
  return steps
}
