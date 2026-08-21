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
  cadence: string
  description: string
  features: string[]
  /** One plan may be visually promoted. Exactly one, per DESIGN.md. */
  featured?: boolean
  /** Subscriptions renew; a pass expires. Changes the button + the fine print. */
  recurring: boolean
}

export const PLANS: Plan[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    price: '$12',
    cadence: 'per month',
    description: 'Everything, billed month to month. Cancel from your account page.',
    features: ['Full access', 'Cancel any time', 'Email support'],
    recurring: true,
  },
  {
    id: 'yearly',
    name: 'Yearly',
    price: '$120',
    cadence: 'per year',
    description: 'Two months free. Same product, longer commitment.',
    features: ['Everything in Monthly', 'Two months free', 'Priority support'],
    featured: true,
    recurring: true,
  },
  {
    id: 'pass',
    name: '30-day pass',
    price: '$18',
    cadence: 'one time',
    description: 'No subscription, no renewal. Buy another and the days stack.',
    features: ['30 days of full access', 'Never auto-renews', 'Stacks with time you have left'],
    recurring: false,
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
