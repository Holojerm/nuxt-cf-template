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
// The default layout renders on every page, marketing pages included, so the
// cost of asking has to be near zero:
//
//   - Signed out: the layout never mounts this (`v-if="loggedIn"`). No request,
//     no server work, no bundle path taken.
//   - Signed in: `server: false` keeps the lookup off the server render
//     entirely, so first paint pays nothing for it. One GET after hydration —
//     once per full page load, not once per navigation, because the default
//     layout persists across client-side routing and this component is never
//     remounted.
//
// The trade is that the banner arrives a beat after the page does, and that an
// SPA session running when a payment fails won't notice until the next load.
// Both are the right side of the trade: this state is rare, the customer
// already has the email, and nobody should pay a D1 round-trip on every
// marketing page render for a banner almost no one will ever see.

const { loggedIn } = useUserSession()
const route = useRoute()

const { data: billing } = useFetch('/api/billing/entitlement', {
  key: 'billing-past-due-banner',
  // Client-only and non-blocking. Deliberately its own key rather than sharing
  // /account's — two useFetch calls on one key are one shared request, and the
  // layout's setup runs first, so sharing would hand the page this call's
  // (empty) server-side result and break its SSR data.
  server: false,
  lazy: true,
})

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
