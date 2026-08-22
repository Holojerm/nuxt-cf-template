<script setup lang="ts">
// The gated page — the one that proves the whole chain works end to end:
// sign in → buy → get in. Replace its contents with your actual product.
//
// Both middlewares run in order: `auth` bounces signed-out visitors to /login
// (carrying `?redirect=/dashboard`), then `subscription` bounces signed-in
// visitors without an entitlement to /pricing.
//
// Neither is the security boundary. The API route this page calls does the real
// check with `await requireSubscription(event)`, which 402s. Delete the client
// middleware and this page still can't show paid data; delete the server check
// and it can.
//
// ── Onboarding ───────────────────────────────────────────────────────────
// The checklist's fetch, dismissal state, and activation POST live here
// rather than inside OnboardingChecklist.vue, on purpose: this page also
// decides whether the empty state below shows, and that decision has to
// agree with the checklist's own visibility in the exact same render —
// computing both from one ref in one component rules out the two ever
// disagreeing for a frame, which a child-emits-to-parent-ref design would
// not.

definePageMeta({ middleware: ['auth', 'subscription'] })

const { user } = useUserSession()
const toast = useToast()

// 'onboarding-layout' — see app/components/Onboarding/Checklist.vue for what
// the two arms look like and why they share one card.
const variant = useFlagVariant('onboarding-layout', 'control')

// Read-only, fetched exactly once. `watch: false` is the load-bearing part:
// without it, any reactive value this call happened to reference would make
// useFetch refetch on the client after the flag resolves in onMounted, and
// this page used to pass `variant` as a query param for exactly that reason
// — which meant every load fetched twice. GET /api/onboarding no longer
// takes a variant at all (it's a pure read now — see that file and
// server/utils/onboarding.ts for why), so there's nothing left to react to,
// but `watch: false` stays as the explicit guarantee rather than an
// accident of there being no reactive params left to trip over.
const { data: progress } = await useFetch('/api/onboarding', { watch: false })

// ── Dismissal ────────────────────────────────────────────────────────────
// Client-side only (localStorage), for the same hydration reason the flag
// above is: reading it during setup would render different markup on the
// server (no localStorage there) than on the client's first paint, and Vue
// would discard the mismatched subtree. So every load starts "not
// dismissed", and the real value is read in onMounted — see
// app/composables/useFlag.ts's header for the identical trade-off.
const dismissed = ref(false)

function dismissalStorageKey(): string | null {
  const id = user.value && 'id' in user.value ? String(user.value.id) : null
  // Scoped per-account, not just per-browser: a shared or demo device
  // shouldn't have one person's dismissal hide the checklist for the next
  // person who signs in on it.
  return id ? `onboarding-dismissed:${id}` : null
}

onMounted(() => {
  const key = dismissalStorageKey()
  if (key && localStorage.getItem(key) === '1') dismissed.value = true
})

function dismissChecklist(): void {
  dismissed.value = true
  const key = dismissalStorageKey()
  if (key) localStorage.setItem(key, '1')
}

// The checklist hides itself the moment every step is done — nothing left to
// act on, so nothing left to keep showing — or earlier, if dismissed
// explicitly.
const checklistVisible = computed(() => !dismissed.value && progress.value?.complete !== true)

// ── Activation ───────────────────────────────────────────────────────────
// POST /api/onboarding/activated once this page has BOTH facts an
// activation record needs: the checklist is complete (known as soon as the
// GET above resolves — server-verified, not assumed) and the A/B variant
// has resolved past its fallback (only true from onMounted onward). Firing
// this from the GET itself, tagged with whatever `variant` held at the
// time, used to mean almost every real activation was mistagged with the
// fallback arm — see server/utils/onboarding.ts › recordActivationOnce for
// the full story. The server re-verifies completion and owns the
// idempotency guard; this is just "tell it once, with the right tag".
//
// Two triggers, not one, because `variant` can settle at two different
// points depending on whether PostHog already had flags cached: onMounted
// covers both "PostHog isn't configured, so `variant` never changes past
// its fallback" (the guard below still only lets this run once) and "flags
// were already cached, so `variant` is correct by the time onMounted
// fires" (useFlagVariant's own onMounted runs first, having been set up
// earlier in this file — Vue invokes onMounted callbacks in registration
// order). The `watch` covers the remaining case: flags resolving
// asynchronously a moment after mount.
let activationAttempted = false

async function tryRecordActivation(): Promise<void> {
  if (activationAttempted || !progress.value?.complete) return
  // Set before the await, not after: this function can be re-entered from
  // either trigger, and setting the guard synchronously — before yielding
  // to the network round trip below — is what stops both triggers firing
  // at once from ever being in flight together.
  activationAttempted = true
  try {
    const result = await $fetch('/api/onboarding/activated', {
      method: 'POST',
      body: { variant: variant.value },
    })
    if (result.activated) {
      toast.add({
        title: 'You’re all set',
        description: 'Nice — every step is done.',
        icon: 'i-lucide-party-popper',
        color: 'success',
      })
    }
  } catch {
    // Transient failure — allow a later trigger (or the next page load) to
    // retry rather than losing the event for this account permanently.
    activationAttempted = false
  }
}

onMounted(() => {
  void tryRecordActivation()
})

watch(variant, () => {
  void tryRecordActivation()
})

useSeo({ title: 'Dashboard', description: 'The gated example page.', noindex: true })
</script>

<template>
  <div class="flex flex-col gap-8 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Welcome back, {{ user?.name }}</h1>
      <p class="mt-2 text-muted">
        You're signed in with an active plan — this page is only reachable in that state.
      </p>
    </div>

    <!-- Shared min-height across both children: the checklist card and the
         empty state below occupy the same reserved box. Without this,
         `dismissed` flipping true in onMounted (a returning visitor who
         dismissed on a previous visit) swaps a ~300px card for a ~50px
         empty state one frame after hydration, with no user action to
         explain the jump — the same "swap content, not layout" problem
         useFlag.ts warns about for the A/B variant, just triggered by
         localStorage instead of by the flag. -->
    <div class="min-h-72">
      <OnboardingChecklist
        v-if="checklistVisible"
        :progress="progress"
        :variant="variant"
        @dismiss="dismissChecklist"
      />

      <!-- The one real empty state in this template — see DESIGN.md ›
           Component behavior: one text-muted line, one action, no
           illustration. Shown once onboarding is out of the way (dismissed
           or complete), because until then the checklist above is the
           page's actual content. -->
      <div v-else class="flex flex-col items-start gap-3 py-8">
        <p class="text-muted">Nothing here yet — this is where your product's content goes.</p>
        <UButton to="/design-system" color="neutral" variant="outline"
          >Browse the design system</UButton
        >
      </div>
    </div>
  </div>
</template>
