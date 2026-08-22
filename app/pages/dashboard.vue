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
// The checklist's fetch and dismissal state live here rather than inside
// OnboardingChecklist.vue, on purpose: this page also decides whether the
// empty state below shows, and that decision has to agree with the
// checklist's own visibility in the exact same render — computing both from
// one ref in one component rules out the two ever disagreeing for a frame,
// which a child-emits-to-parent-ref design would not.

definePageMeta({ middleware: ['auth', 'subscription'] })

const { user } = useUserSession()
const toast = useToast()

// 'onboarding-layout' — see app/components/Onboarding/Checklist.vue for what
// the two variants look like and why they share one wrapper.
const variant = useFlagVariant('onboarding-layout', 'control')

const { data: progress } = await useFetch('/api/onboarding', {
  query: computed(() => ({ variant: variant.value })),
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
// explicitly. Either way this toast is the only "nice, you're set" moment;
// there's no separate completed-state screen to click through first.
watch(
  () => progress.value?.complete,
  (complete, previousComplete) => {
    if (complete && previousComplete === false) {
      toast.add({
        title: 'You’re all set',
        description: 'Nice — every step is done.',
        icon: 'i-lucide-party-popper',
        color: 'success',
      })
    }
  },
)

const checklistVisible = computed(() => !dismissed.value && progress.value?.complete !== true)

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

    <OnboardingChecklist
      v-if="checklistVisible"
      :progress="progress"
      :variant="variant"
      @dismiss="dismissChecklist"
    />

    <!-- The one real empty state in this template — see DESIGN.md › Component
         behavior: one text-muted line, one action, no illustration. Shown
         once onboarding is out of the way (dismissed or complete), because
         until then the checklist above is the page's actual content. -->
    <div v-else class="flex flex-col items-start gap-3 py-8">
      <p class="text-muted">Nothing here yet — this is where your product's content goes.</p>
      <UButton to="/design-system" color="neutral" variant="outline"
        >Browse the design system</UButton
      >
    </div>
  </div>
</template>
