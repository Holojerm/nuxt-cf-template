<script setup lang="ts">
// The buy page. Three things it has to get right:
//   1. Never open a checkout that will fail — a plan with no configured price id
//      renders disabled with the reason, rather than throwing at Paddle.
//   2. Signed-out visitors can read prices; clicking a plan sends them to sign
//      in first, because the checkout threads `custom_data.userId` and a
//      purchase without one can't be mapped back to an account by the webhook.
//   3. Existing subscribers get told they already have access instead of being
//      sold a second subscription.
//
// It is also the page answer engines care most about, so it carries the Offer
// nodes and the FAQPage — both built from the same arrays the template renders
// (app/utils/plans.ts, app/utils/faq.ts), never from a second copy of the copy.
//
// ── The `pricing-layout` experiment ──────────────────────────────────────────
// `pass-first` leads with the one-time pass instead of the yearly subscription,
// on the consumer hypothesis that a first-time visitor buys a thing more
// readily than a commitment. Three properties keep it from being a mess:
//
//   1. It reorders with CSS `order` on the same grid. The DOM is identical in
//      both variants, so the one frame of control that useFlagVariant always
//      renders (see app/composables/useFlag.ts) swaps class strings and nothing
//      else — no elements are created, destroyed, or moved by Vue, and the grid
//      cells keep their size, so nothing below the fold shifts.
//   2. Exactly one plan is featured in either variant (DESIGN.md › Component
//      behavior: one primary button per view). The badge follows the promotion
//      rather than sitting on `plan.featured`, which is the control's answer.
//   3. The Offer JSON-LD is built from PLANS, not from the rendered order, so
//      the structured data an answer engine quotes is identical for everyone.
//      A page whose machine-readable prices depend on a client-side flag is a
//      page that publishes two different price lists.

definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '0.8',
    title: 'Pricing',
    summary:
      'Every plan and what it costs — a monthly subscription, a yearly subscription, and a one-time 30-day pass — plus answers on billing, cancellation, and refunds.',
  },
})

const config = useRuntimeConfig()
const { loggedIn } = useUserSession()
const { openCheckout, ready: paddleReady } = usePaddle()
const plans = usePlans()
const site = useSiteContext()
const toast = useToast()
const route = useRoute()

// Only signed-in users have an entitlement to look up. `immediate` keeps this
// from firing a guaranteed 401 for anonymous visitors.
const { data: entitlement, refresh: refreshEntitlement } = await useFetch(
  '/api/billing/entitlement',
  { immediate: loggedIn.value, watch: [loggedIn] },
)

watch(loggedIn, (value) => {
  if (value) refreshEntitlement()
})

const pending = ref<string | null>(null)

// 'control' | 'pass-first'. Resolves in onMounted, so it is 'control' during
// SSR and for the first client frame — which is why the variant may only
// change `order` classes and copy, never structure.
const pricingLayout = useFlagVariant('pricing-layout', 'control')
const passFirst = computed(() => pricingLayout.value === 'pass-first')

/** The control's promoted plan comes from the data, not from a second literal. */
const CONTROL_FEATURED_ID = PLANS.find((plan) => plan.featured)?.id ?? null

const featuredId = computed(() => (passFirst.value ? 'pass' : CONTROL_FEATURED_ID))

/**
 * Static class strings, because Tailwind scans source text — a computed
 * `order-${n}` produces no CSS at all and the grid silently stops reordering.
 */
const ORDER_CLASSES = ['order-1', 'order-2', 'order-3'] as const

/** Where each plan sits in `pass-first`. Control keeps the array's own order. */
const PASS_FIRST_ORDER: Record<string, number> = { pass: 0, monthly: 1, yearly: 2 }

function orderClass(planId: string, index: number): string {
  const position = passFirst.value ? (PASS_FIRST_ORDER[planId] ?? index) : index
  return ORDER_CLASSES[position] ?? ORDER_CLASSES[index] ?? ''
}

async function choose(plan: (typeof plans.value)[number]) {
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: '/pricing' } })
  }
  if (!plan.purchasable) return

  pending.value = plan.id
  // The variant rides on `checkout_started` — the funnel's denominator — so the
  // experiment is measurable as "which layout sold which plan" rather than as
  // two unrelated event streams.
  const opened = await openCheckout(plan.priceId, 'default', {
    pricing_variant: pricingLayout.value,
    plan_id: plan.id,
  })
  pending.value = null

  if (!opened) {
    toast.add({
      title: 'Checkout unavailable',
      description: 'Paddle did not load. Check the client token and try again.',
      color: 'error',
    })
  }
}

// Set by the `subscription` route middleware when it turns someone away.
const gatedFrom = computed(() => (typeof route.query.from === 'string' ? route.query.from : null))

useSeo({
  title: 'Pricing',
  description: `Plans and pricing for ${config.public.appName}: a monthly subscription, a yearly subscription, and a one-time 30-day pass. Every plan includes everything.`,
  breadcrumb: [{ name: 'Pricing', path: '/pricing' }],
  schema: [
    softwareApplicationSchema(site, {
      description: `Plans and pricing for ${config.public.appName}.`,
      offers: plans.value.map((plan) => ({
        name: plan.name,
        description: plan.description,
        amount: plan.amount,
        currency: plan.currency,
        unit: plan.unit,
        recurring: plan.recurring,
      })),
    }),
    // Valid only because the same array is rendered below — see app/utils/faq.ts.
    faqSchema(PRICING_FAQ),
  ],
})
</script>

<template>
  <div class="flex flex-col gap-10 py-12">
    <div class="mx-auto max-w-2xl text-center">
      <h1 class="text-4xl text-highlighted">Pricing</h1>
      <p class="mt-4 text-lg text-muted">
        One product, three ways to pay for it. Every plan includes everything.
      </p>
    </div>

    <UAlert
      v-if="gatedFrom"
      color="info"
      variant="subtle"
      icon="i-lucide-lock"
      title="That page needs an active plan"
      :description="`Pick one below and you'll land back on ${gatedFrom}.`"
      class="mx-auto max-w-2xl"
    />

    <UAlert
      v-else-if="entitlement?.active"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      title="You already have access"
      description="Manage or cancel your plan from your account page."
      class="mx-auto max-w-2xl"
    >
      <template #actions>
        <UButton to="/account" color="neutral" variant="outline" size="sm">Go to account</UButton>
      </template>
    </UAlert>

    <div class="grid gap-6 md:grid-cols-3">
      <UCard
        v-for="(plan, index) in plans"
        :key="plan.id"
        :class="[orderClass(plan.id, index), plan.id === featuredId ? 'ring-2 ring-primary' : '']"
      >
        <div class="flex h-full flex-col gap-6">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-xl text-highlighted">{{ plan.name }}</h2>
              <!-- Solid, never subtle: clay-600 on a clay tint is 4.04:1 and
                   fails AA (DESIGN.md › Color). -->
              <UBadge v-if="plan.id === featuredId" color="primary" variant="solid">
                {{ passFirst ? 'Start here' : 'Best value' }}
              </UBadge>
            </div>
            <p class="mt-3 flex items-baseline gap-2">
              <span class="font-display text-3xl text-highlighted">{{ plan.price }}</span>
              <span class="text-sm text-muted">{{ plan.cadence }}</span>
            </p>
            <p class="mt-3 text-sm text-muted">{{ plan.description }}</p>
          </div>

          <ul class="flex flex-col gap-2 text-sm">
            <li v-for="feature in plan.features" :key="feature" class="flex items-start gap-2">
              <UIcon name="i-lucide-check" class="mt-1 shrink-0 text-primary" />
              <span class="text-default">{{ feature }}</span>
            </li>
          </ul>

          <div class="mt-auto flex flex-col gap-2">
            <UButton
              block
              size="lg"
              :color="plan.id === featuredId ? 'primary' : 'neutral'"
              :variant="plan.id === featuredId ? 'solid' : 'outline'"
              :disabled="!plan.purchasable"
              :loading="pending === plan.id"
              @click="choose(plan)"
            >
              {{ loggedIn ? `Get ${plan.name}` : 'Sign in to continue' }}
            </UButton>
            <p v-if="!plan.purchasable" class="text-xs text-muted">
              {{
                paddleReady
                  ? 'No price ID configured for this plan yet.'
                  : 'Set NUXT_PUBLIC_PADDLE_CLIENT_TOKEN to enable checkout.'
              }}
            </p>
            <p v-else-if="!plan.recurring" class="text-xs text-muted">
              One-time charge. Never renews.
            </p>
          </div>
        </div>
      </UCard>
    </div>

    <!--
      The FAQ is rendered from the same PRICING_FAQ array that feeds the
      FAQPage JSON-LD above. Answer engines quote these strings; visitors read
      them. Edit app/utils/faq.ts and both change together.
    -->
    <section class="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h2 class="text-2xl text-highlighted">Common questions</h2>
      <dl class="flex flex-col gap-6">
        <div v-for="item in PRICING_FAQ" :key="item.question" class="flex flex-col gap-2">
          <dt class="font-medium text-highlighted">{{ item.question }}</dt>
          <dd class="text-sm text-muted">{{ item.answer }}</dd>
        </div>
      </dl>
      <p class="text-sm text-muted">
        The <ULink to="/terms" class="text-primary underline underline-offset-2">Terms</ULink> carry
        the full refund and cancellation policy.
      </p>
    </section>
  </div>
</template>
