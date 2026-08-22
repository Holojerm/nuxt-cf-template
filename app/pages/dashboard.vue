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
// the two arms look like and why they share one card. `ONBOARDING_LAYOUT_VARIANTS`
// (shared/utils/onboarding.ts) is the one list both this clamp and
// POST /api/onboarding/activated's Zod body validate against — see that
// file for why an unrecognized arm has to degrade to the fallback here
// rather than being passed through.
const { variant, settled } = useFlagVariant(
  'onboarding-layout',
  'control',
  ONBOARDING_LAYOUT_VARIANTS,
)

// Read-only, fetched exactly once. `watch: false` is the load-bearing part:
// without it, any reactive value this call happened to reference would make
// useFetch refetch on the client after the flag resolves in onMounted, and
// this page used to pass `variant` as a query param for exactly that reason
// — which meant every load fetched twice. GET /api/onboarding no longer
// takes a variant at all (it's a pure read now — see that file and
// server/utils/onboarding.ts for why), so there's nothing left to react to,
// but `watch: false` stays as the explicit guarantee rather than an
// accident of there being no reactive params left to trip over.
//
// `refresh` IS used, deliberately not left destructured-away: see
// handleFeedbackSubmitted below.
const { data: progress, refresh: refreshProgress } = await useFetch('/api/onboarding', {
  watch: false,
})

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

// The embedded FeedbackWidget on the "send feedback" step is the one way to
// finish the checklist without navigating anywhere — every other step's
// action is a real link to /pricing or /account. Without this, completing
// via that widget would only ever show up after a reload: `progress` isn't
// otherwise reactive once fetched.
function handleFeedbackSubmitted(): void {
  void refreshProgress()
}

// ── Activation ───────────────────────────────────────────────────────────
// POST /api/onboarding/activated once this page has established BOTH facts
// an activation record needs: `useFlagVariant`'s flag has actually settled
// (not merely changed — see app/composables/useFlag.ts for why those are
// different questions, and why "changed" is the wrong one) and the
// checklist is complete (server-verified on arrival, not assumed — see
// server/utils/onboarding.ts › activateIfComplete). `progress.value.activated`
// is the third gate: GET /api/onboarding already reports whether this
// account has been recorded before, so a returning visitor who activated
// last week never even attempts the call.
//
// A `watch` over `[settled, complete]` with `immediate: true`, not an
// `onMounted` callback plus a separate `watch(variant, …)`. The two used to
// be needed because firing straight from `onMounted` fires before
// `useFlagVariant` has necessarily resolved anything — but that is exactly
// the bug: for a cold-cache visitor (no PostHog decision cached in this
// browser yet), `settled` is what actually tells us the flag has reported
// something, and `variant` merely CHANGING is not a reliable proxy for
// that — posthog-js returns `undefined` from `getFeatureFlag`
// deterministically, not intermittently, until its `/flags` request
// resolves, so there may be no "change" to observe within the window an
// `onMounted`-fired attempt would see. One watcher over the two real
// preconditions, evaluated with `immediate: true` (a no-op the first time,
// since `settled` starts false — see below), replaces both former triggers
// and is also what re-evaluates correctly after handleFeedbackSubmitted's
// refresh flips `progress.value.complete` live.
let activationAttempted = false

async function tryRecordActivation(): Promise<void> {
  const shouldAttempt = shouldAttemptActivation({
    settled: settled.value,
    complete: progress.value?.complete ?? false,
    activated: progress.value?.activated ?? false,
  })
  if (activationAttempted || !shouldAttempt) return
  // Set before the await, not after: this function can be re-entered by the
  // same watcher firing again (settled and complete can each trigger it),
  // and setting the guard synchronously — before yielding to the network
  // round trip below — is what stops two attempts from ever being in
  // flight together.
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

// `immediate: true` fires this synchronously during setup — including
// during SSR — but `settled` starts `false` there and stays `false` through
// hydration (app/composables/useFlag.ts), so that first firing is always a
// no-op. The real firing happens once `settled` (or `progress.complete`,
// via handleFeedbackSubmitted) actually changes.
watch(
  [settled, () => progress.value?.complete],
  () => {
    void tryRecordActivation()
  },
  { immediate: true },
)

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
        @submitted="handleFeedbackSubmitted"
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
