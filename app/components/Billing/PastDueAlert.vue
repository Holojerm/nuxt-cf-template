<script setup lang="ts">
// The dunning notice itself — one component so the two places that show it (the
// layout banner and the Plan card on /account) cannot drift apart in either the
// copy or the action. Both are looking at the same failed payment; hearing two
// different stories about it is how a customer decides the product is confused
// about whether they owe money.
//
// Every claim here is checked against what the server actually does:
//
//   - "paused" — ACTIVE_STATUSES in server/utils/entitlements.ts is
//     ['active', 'trialing'], so requireSubscription 402s for the whole of
//     dunning. Access is genuinely gone. Nothing here says "you still have
//     access until…", because the code does not grant it.
//   - "Paddle retries the card automatically" — true, on Paddle's dunning
//     schedule. The schedule itself is not stated: it's configured in Paddle,
//     not here, so a number in this copy would be a guess that reads as a
//     promise.
//   - No date. `current_period_end` on a past_due row may be the period that
//     went unpaid or the one Paddle already rolled into — we can't tell from
//     the column, so any sentence built on it would be a coin flip. The billing
//     history table below shows the raw value under its own neutral label,
//     which is the honest way to present a field you can't interpret.
//
// And nothing here nags. There is one thing to do, it is a button, and the
// alternative (cancelling instead) is named rather than hidden — see
// app/utils/churn.ts for why this product does not do retention pressure.
//
// Presentation: `warning`, not `error` — a failed card is reversible risk
// (DESIGN.md › Color). The icon names both the thing that broke and the thing
// that fixes it, so the state never rests on the amber alone.
//
// One more constraint, and it is not stylistic: the template below must have a
// single root node with NO comment above it. Vue's SSR compiler drops template
// comments while the client compiler keeps them in dev, so a leading comment
// makes this a fragment-root component on the client and a single-node one on
// the server — which hydrates as "Hydration node mismatch" on exactly the page
// this component exists to get right. Rationale goes here, not up there.

interface Props {
  /** False when NUXT_PADDLE_API_KEY is unset — show the fallback, not a dead button. */
  portalAvailable: boolean
}

defineProps<Props>()

const toast = useToast()
const pending = ref(false)

/**
 * Mint a fresh portal session and leave for it. The link is short-lived and
 * logs the customer straight in, so it is minted per click and never cached.
 */
async function updatePaymentMethod(): Promise<void> {
  pending.value = true
  try {
    const links = await $fetch('/api/billing/portal', { method: 'POST' })
    // Never `cancelUrl` — someone who clicked "Update payment method" has not
    // said they're leaving, and dropping them on a cancellation screen is the
    // mirror image of the dark pattern /account exists to avoid.
    //
    // In practice this resolves to the overview URL: the payment-method deep
    // link only comes back when the portal session was minted with subscription
    // ids, and getBillingOverview only lists subscriptions that are currently
    // granting access — which a past_due one, by definition, is not. The
    // overview page carries the same action one click in.
    const target = links.updatePaymentMethodUrl || links.overviewUrl
    if (!target) throw new Error('No portal URL returned')
    await navigateTo(target, { external: true })
  } catch (error) {
    const code = (error as { data?: { data?: { code?: string } } }).data?.data?.code
    toast.add({
      title: 'Could not open the billing portal',
      description:
        code === 'portal_unconfigured'
          ? 'NUXT_PADDLE_API_KEY is not set on the server.'
          : 'Reply to your Paddle receipt email and we can update the card with you.',
      color: 'error',
    })
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-credit-card"
    title="Your last payment didn't go through"
  >
    <template #description>
      <div class="flex flex-col gap-3">
        <p>
          Your subscription is paused while it's unpaid. Paddle, our payment processor, retries
          the card automatically.
        </p>

        <!-- Longer explanation on /account, where there's room for it. -->
        <slot />

        <!-- Both ways out, not just the one that keeps us paid.
             With NUXT_PADDLE_API_KEY unset there is no button on this alert at
             all, so this paragraph IS the entire set of available actions — and
             it used to name only "update the card". Someone who wanted to stop
             paying was left with no route at all on the one screen that exists
             because their payment failed, which is precisely the dark pattern
             the header of app/pages/account.vue commits against. Naming the
             cancellation path costs nothing and is the difference between a
             fallback and a trap. -->
        <p v-if="!portalAvailable" class="text-sm">
          The self-serve billing portal isn't configured on this deployment. Reply to your Paddle
          receipt email and we'll do it with you — either update the card to restore access, or
          cancel the subscription. Whichever you ask for, we action it the same day.
        </p>
      </div>
    </template>

    <template v-if="portalAvailable" #actions>
      <!-- The one primary button anywhere on the page while this is showing.
           min-touch because on a phone this is the primary action of the
           session (DESIGN.md › Accessibility › Viewport and touch). -->
      <UButton
        class="min-touch"
        icon="i-lucide-external-link"
        :loading="pending"
        @click="updatePaymentMethod"
      >
        Update payment method
      </UButton>
    </template>
  </UAlert>
</template>
