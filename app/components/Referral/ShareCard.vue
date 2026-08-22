<script setup lang="ts">
// The referral card on /account — one link, one button, and the terms in a
// sentence somebody can actually check against what they get.
//
// The honesty here is the design. Two counts are shown, not one: "joined" and
// "earned you days". They are different numbers because the referrer is only
// paid when a referee actually pays (server/utils/referral.ts), and a card that
// showed only the first would be setting up the support ticket that asks where
// the days went. The gap between them IS the terms, rendered.
//
// `lazy` rather than a blocking fetch: this sits several cards down a page
// whose first job is to show somebody their plan, and it must never be what
// that page waits on. The skeleton is one line tall, so nothing below it moves.

const { data, status, error } = await useFetch('/api/referral/me', { lazy: true })

const toast = useToast()
const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

/**
 * `navigator.clipboard` is unavailable on insecure origins and can be refused
 * by permissions policy, and both failures are silent — the button appears to
 * work and nothing lands on the clipboard. So the failure path says so, and the
 * link stays visible and selectable either way.
 */
async function copyLink(): Promise<void> {
  const url = data.value?.shareUrl
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => (copied.value = false), 2000)
  } catch {
    toast.add({
      title: 'Could not copy the link',
      description: 'Select it and copy it by hand.',
      color: 'error',
    })
  }
}

onScopeDispose(() => clearTimeout(resetTimer))
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl text-highlighted">Invite a friend</h2>
    </template>

    <div class="flex flex-col gap-4">
      <!-- The terms, built from the same constants the grant path spends, so
           this sentence cannot promise a number the server won't write. -->
      <p class="text-muted">
        They get {{ REFERRAL_WELCOME_DAYS }} days free when they sign up through your link. You get
        {{ REFERRAL_REWARD_DAYS }} days the first time one of them pays — up to
        {{ REFERRAL_MAX_REWARDS }} times. Days stack on whatever you already have.
      </p>

      <!-- The sentence a subscriber needs, and the one the card used to leave
           out while quietly not paying them at all. Reward days stack from the
           end of whatever is already running, so for somebody on a subscription
           they are real days that simply start later. Saying so is the whole
           difference between a delayed reward and a broken promise. -->
      <p class="text-sm text-muted">
        Already subscribed? Your reward days stack too — they start when your subscription ends, so
        nothing is lost either way.
      </p>

      <div v-if="status === 'pending'" class="flex flex-col gap-3">
        <USkeleton class="h-9 w-full" />
        <USkeleton class="h-4 w-48" />
      </div>

      <UAlert
        v-else-if="error || !data?.shareUrl"
        color="neutral"
        variant="subtle"
        icon="i-lucide-link-2-off"
        title="Your link isn't available"
        description="Reload the page. If it stays this way, reply to any email from us."
      />

      <template v-else>
        <div class="flex items-center gap-2">
          <!-- Readonly rather than disabled: a disabled input is not focusable,
               so the manual select-and-copy fallback would be unreachable by
               keyboard on exactly the browsers where the copy button fails. -->
          <UInput
            :model-value="data.shareUrl"
            readonly
            aria-label="Your referral link"
            class="w-full font-mono"
            @focus="(event: FocusEvent) => (event.target as HTMLInputElement).select()"
          />
          <!-- The accessible name is STATIC even though the icon changes. A
               button whose name mutates under a screen reader gets re-announced
               as if it were a different control; the state belongs in the live
               region below, which is what that region is for. -->
          <UButton
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :color="copied ? 'success' : 'neutral'"
            variant="outline"
            class="min-touch shrink-0"
            aria-label="Copy referral link"
            @click="copyLink"
          />
        </div>

        <!-- Never state anything by colour alone (DESIGN.md › Accessibility):
             the button's icon changes, and this line is the word for it. It is
             also the ONLY announcement a screen reader gets, since the button's
             accessible name is deliberately static — hence `aria-live`. -->
        <p aria-live="polite" class="text-sm text-muted">
          <span v-if="copied">Copied to your clipboard.</span>
          <span v-else>Share it anywhere — the credit is recorded on their first visit.</span>
        </p>

        <dl class="grid grid-cols-2 gap-4 border-t border-default pt-4">
          <div>
            <dt class="text-sm text-muted">Signed up</dt>
            <dd class="font-mono text-default">{{ data.referredCount }}</dd>
          </div>
          <div>
            <dt class="text-sm text-muted">Earned you days</dt>
            <dd class="font-mono text-default">{{ data.rewardedCount }}</dd>
          </div>
        </dl>
      </template>
    </div>
  </UCard>
</template>
