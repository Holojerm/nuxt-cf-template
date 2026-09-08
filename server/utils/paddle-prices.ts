// Which Paddle price grants what. Built from runtime config and consulted by
// the webhook before any entitlement row is created.
//
// Why the webhook cannot take the buyer's word for it: `custom_data` on a
// checkout is set by the browser (app/composables/usePaddle.ts), so a signed,
// genuine `transaction.completed` can still carry any `productKey` the buyer
// typed into Paddle.Checkout.open(). The price id is the one thing on the
// event Paddle sets from what was actually paid for, so the price decides the
// kind of grant and the product it unlocks. A price not in this table grants
// nothing — the event is acknowledged and logged, never applied.

export type PaddlePriceKind = 'subscription' | 'pass'

export interface PaddlePriceEntry {
  kind: PaddlePriceKind
  productKey: string
}

export type PaddlePriceCatalogue = Readonly<Record<string, PaddlePriceEntry>>

/** The `NUXT_PUBLIC_PADDLE_PRICE_*` ids — the same three app/utils/plans.ts renders. */
export interface PaddlePriceConfig {
  paddlePriceMonthly?: string
  paddlePriceYearly?: string
  paddlePricePass?: string
}

/**
 * Monthly and yearly are subscriptions, the pass is a one-time charge; that
 * split mirrors `recurring` on the plans in app/utils/plans.ts. Every price
 * unlocks the one `productKey` — a fork selling a second product adds a
 * config key and a row here, not a branch on `custom_data`.
 */
export function paddlePriceCatalogue(
  config: PaddlePriceConfig,
  productKey = 'default',
): PaddlePriceCatalogue {
  const configured: [string | undefined, PaddlePriceKind][] = [
    [config.paddlePriceMonthly, 'subscription'],
    [config.paddlePriceYearly, 'subscription'],
    [config.paddlePricePass, 'pass'],
  ]
  const catalogue: Record<string, PaddlePriceEntry> = {}
  for (const [id, kind] of configured) {
    if (id) catalogue[id] = { kind, productKey }
  }
  return catalogue
}

/** The slice of a Paddle `items[]` entry the check reads. */
export interface PaddleItemLike {
  price?: { id: string } | null
}

export type PriceResolution =
  | { ok: true; entry: PaddlePriceEntry }
  | { ok: false; reason: 'no_items' | 'unknown_price' | 'wrong_kind'; priceIds: string[] }

/**
 * The single entry a purchase resolves to.
 *
 * Every item must be a configured price of the expected kind for the same
 * product. One stranger in the basket rejects the whole event rather than
 * granting on the items we do recognise, because "one known pass plus one
 * unknown thing" is exactly what a crafted checkout looks like.
 */
export function resolvePaddlePrice(
  items: PaddleItemLike[] | null | undefined,
  expected: PaddlePriceKind,
  catalogue: PaddlePriceCatalogue,
): PriceResolution {
  const priceIds = (items ?? [])
    .map((item) => item.price?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (priceIds.length === 0) return { ok: false, reason: 'no_items', priceIds }

  const entries: PaddlePriceEntry[] = []
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
