// The plans on /pricing.
//
// Copy lives here; the Paddle price ids live in runtime config
// (nuxt.config.ts › public.paddlePrice*) because sandbox and production issue
// different `pri_…` values and a fork shouldn't need a code change to switch.
// usePlans() joins the two and reports which plans are actually purchasable.
//
// The `pass` plan is a one-time 30-day purchase, not a subscription — the
// entitlement layer tells them apart by the Paddle ref (`txn_` vs `sub_`) and
// stacks passes rather than resetting them. See server/utils/entitlements.ts.

export interface Plan {
  id: 'monthly' | 'yearly' | 'pass'
  name: string
  /** Display price. Paddle is the source of truth for what's actually charged. */
  price: string
  /**
   * The same number, machine-readable, for the schema.org Offer on /pricing.
   * Kept alongside `price` rather than derived from it: parsing a currency
   * glyph out of display copy breaks the first time someone writes '€12' or
   * 'From $12', and silently publishing a wrong price to answer engines is a
   * worse failure than a duplicated digit.
   */
  amount: number
  /** ISO 4217, e.g. 'USD'. Must match what Paddle actually charges. */
  currency: string
  cadence: string
  description: string
  features: string[]
  /** One plan may be visually promoted. Exactly one, per DESIGN.md. */
  featured?: boolean
  /** Subscriptions renew; a pass expires. Changes the button + the fine print. */
  recurring: boolean
  /**
   * How much access `amount` buys, as a UN/CEFACT code schema.org understands:
   * MON = month, ANN = year, DAY = day. A $12/month subscription and a $12
   * one-off are the same number and completely different offers.
   */
  unit: { value: number; code: 'MON' | 'ANN' | 'DAY' }
}

export const PLANS: Plan[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    price: '$12',
    amount: 12,
    currency: 'USD',
    cadence: 'per month',
    description: 'Everything, billed month to month. Cancel from your account page.',
    features: ['Full access', 'Cancel any time', 'Email support'],
    recurring: true,
    unit: { value: 1, code: 'MON' },
  },
  {
    id: 'yearly',
    name: 'Yearly',
    price: '$120',
    amount: 120,
    currency: 'USD',
    cadence: 'per year',
    description: 'Two months free. Same product, longer commitment.',
    features: ['Everything in Monthly', 'Two months free', 'Priority support'],
    featured: true,
    recurring: true,
    unit: { value: 1, code: 'ANN' },
  },
  {
    id: 'pass',
    name: '30-day pass',
    price: '$18',
    amount: 18,
    currency: 'USD',
    cadence: 'one time',
    description: 'No subscription, no renewal. Buy another and the days stack.',
    features: ['30 days of full access', 'Never auto-renews', 'Stacks with time you have left'],
    recurring: false,
    unit: { value: 30, code: 'DAY' },
  },
]

export interface ResolvedPlan extends Plan {
  priceId: string
  /** False when no price id is configured — render the button disabled. */
  purchasable: boolean
}

export function usePlans(): ComputedRef<ResolvedPlan[]> {
  const config = useRuntimeConfig()
  return computed(() =>
    PLANS.map((plan) => {
      const priceId = {
        monthly: config.public.paddlePriceMonthly,
        yearly: config.public.paddlePriceYearly,
        pass: config.public.paddlePricePass,
      }[plan.id]
      return {
        ...plan,
        priceId,
        purchasable: Boolean(priceId && config.public.paddleClientToken),
      }
    }),
  )
}
