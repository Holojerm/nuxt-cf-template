// Which Stripe price grants what. Built from runtime config, used by the
// checkout route to pick the price for a plan and by the webhook before any
// entitlement row is created.
//
// The price id is the one thing on an event Stripe sets from what was actually
// paid for, so the price decides the kind of grant and the product it unlocks.
// Metadata names the account and nothing else. A price not in this table grants
// nothing: the event is acknowledged and logged, never applied. That covers a
// payment link or a dashboard-made subscription for something the app does not
// sell, on the same Stripe account.

export type PriceKind = 'subscription' | 'pass'

export interface PriceEntry {
  kind: PriceKind
  productKey: string
}

export type PriceCatalogue = Readonly<Record<string, PriceEntry>>

/** The `NUXT_PUBLIC_STRIPE_PRICE_*` ids, the same two layers/billing/app/utils/plans.ts renders. */
export interface PriceConfig {
  stripePriceMonthly?: string
  stripePricePass?: string
}

/**
 * Monthly is a subscription, the pass is a one-time charge; that
 * split mirrors `recurring` on the plans in layers/billing/app/utils/plans.ts. Every price
 * unlocks the one `productKey`: a fork selling a second product adds a
 * config key and a row here, not a branch on metadata.
 */
export function priceCatalogue(config: PriceConfig, productKey = 'default'): PriceCatalogue {
  const configured: [string | undefined, PriceKind][] = [
    [config.stripePriceMonthly, 'subscription'],
    [config.stripePricePass, 'pass'],
  ]
  const catalogue: Record<string, PriceEntry> = {}
  for (const [id, kind] of configured) {
    if (id) catalogue[id] = { kind, productKey }
  }
  return catalogue
}

/** The price a plan on /pricing sells, or null when it is not configured. */
export function priceForPlan(
  config: PriceConfig,
  plan: 'monthly' | 'pass',
): { priceId: string; kind: PriceKind } | null {
  const priceId = plan === 'monthly' ? config.stripePriceMonthly : config.stripePricePass
  if (!priceId) return null
  return { priceId, kind: plan === 'monthly' ? 'subscription' : 'pass' }
}

/** One priced item of a purchase: the price id and the product it belongs to. */
export interface BillingItemLike {
  price?: { id: string; product_id?: string | null } | null
}

export type PriceResolution =
  | { ok: true; entry: PriceEntry }
  | { ok: false; reason: 'no_items' | 'unknown_price' | 'wrong_kind'; priceIds: string[] }

/**
 * The single entry a purchase resolves to.
 *
 * Every item must be a configured price of the expected kind for the same
 * product. One stranger in the basket rejects the whole event rather than
 * granting on the items we do recognise.
 */
export function resolvePrice(
  items: BillingItemLike[] | null | undefined,
  expected: PriceKind,
  catalogue: PriceCatalogue,
): PriceResolution {
  const priceIds = (items ?? [])
    .map((item) => item.price?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (priceIds.length === 0) return { ok: false, reason: 'no_items', priceIds }

  const entries: PriceEntry[] = []
  for (const id of priceIds) {
    const entry = catalogue[id]
    if (!entry) return { ok: false, reason: 'unknown_price', priceIds }
    entries.push(entry)
  }
  const first = entries[0]!
  const consistent = entries.every(
    (entry) => entry.kind === expected && entry.productKey === first.productKey,
  )
  if (!consistent) return { ok: false, reason: 'wrong_kind', priceIds }
  return { ok: true, entry: first }
}

/**
 * True when every item is a price on a product other than `productId`.
 *
 * One Stripe account sells several apps, and an endpoint receives every event
 * on the account, so a sibling app's purchase reaches this webhook too. It
 * still grants nothing (resolvePrice has already said no); this only decides it
 * is not worth an alert. Unset `productId`, or any item without a product,
 * keeps the alert.
 */
export function isForeignProduct(
  items: BillingItemLike[] | null | undefined,
  productId: string | undefined,
): boolean {
  if (!productId || !items?.length) return false
  return items.every((item) => {
    const owner = item.price?.product_id
    return typeof owner === 'string' && owner.length > 0 && owner !== productId
  })
}
