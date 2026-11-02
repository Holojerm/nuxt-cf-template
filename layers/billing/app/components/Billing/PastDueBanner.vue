<script setup lang="ts">
// The in-app half of dunning: the thing that makes a failed payment impossible
// to miss without making anyone feel chased.
//
// Before this, `decideNotification()` sent exactly one payment-failed email and
// the product said nothing at all. Email is the channel most likely to be
// filtered, sent to an address nobody reads, or lost under everything else —
// so the observable symptom was a paying customer opening the app, finding
// their features 402ing, and having no idea why. The fix for a failed card is
// the customer updating it; the product's job is to make that one action
// unmissable.
//
// ── How the layout learns the state, and what it costs ──────────────────────
// useEntitlement(): client-only, one GET after hydration per full page load,
// shared with the nav and the avatar menu under one key. The trade is that the
// banner arrives a beat after the page does, and an SPA session running when a
// payment fails won't notice until the next load — the right side of it, since
// the customer already has the email and nobody should pay a D1 round-trip on
// every marketing page render for a banner almost no one will ever see.

const { loggedIn } = useUserSession()
const route = useRoute()

const { data: billing } = useEntitlement()

// Not on /account: that page says all of this louder, with the billing history
// under it. The same alert twice, a scroll apart, reads as a rendering bug
// rather than urgency.
const show = computed(
  () => loggedIn.value && billing.value?.state === 'past_due' && route.path !== '/account',
)
</script>

<template>
  <BillingPastDueAlert
    v-if="show"
    class="mb-8"
    :portal-available="billing?.portalAvailable ?? false"
  />
</template>
