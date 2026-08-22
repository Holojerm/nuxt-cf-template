<script setup lang="ts">
// The in-app feedback entry point. Mounted once in the default layout, so
// every page has it; pass `position="inline"` to drop it into a page instead
// (an account page, the end of onboarding, a cancellation flow).
//
// Deliberately open to signed-out visitors — asking people to log in before
// they can tell you something is the fastest way to hear nothing.

import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

interface Props {
  /** `floating` pins a button bottom-right; `inline` renders it in flow. */
  position?: 'floating' | 'inline'
  label?: string
}

const props = withDefaults(defineProps<Props>(), {
  position: 'floating',
  label: 'Feedback',
})

const open = ref(false)
const toast = useToast()
const { loggedIn } = useUserSession()
const { submit, pending } = useFeedback()

// Turnstile, for signed-out submitters only — matching what the server
// enforces (server/api/feedback.post.ts). Gated on the site key rather than on
// the module being installed, so a fork without a Turnstile account renders no
// widget and fetches no challenge script. `challengeRequired` is what the
// template branches on; both halves of that condition matter.
const turnstileSiteKey = useRuntimeConfig().public.turnstile.siteKey
const challengeRequired = computed(() => Boolean(turnstileSiteKey) && !loggedIn.value)
const turnstileToken = ref('')

/**
 * The widget instance, because clearing the v-model is NOT how you get a new
 * challenge.
 *
 * `<NuxtTurnstile>` writes into the model when Cloudflare hands it a token; it
 * never watches the model to decide whether to re-issue. Writing `''` back
 * therefore leaves the component holding a spent token and the submit button
 * disabled on `!turnstileToken` — with nothing to re-enable it until the
 * component's own ~4-minute refresh timer fires. One rejected challenge and the
 * form was dead for four minutes. `reset()` is the documented way to ask for
 * another, and it is what login.vue already does.
 */
const turnstile = ref<{ reset: () => void } | null>(null)

function resetChallenge() {
  turnstileToken.value = ''
  turnstile.value?.reset()
}

// Mirrors server/utils/feedback.ts — the server re-validates either way.
const schema = z.object({
  kind: z.enum(['bug', 'confusion', 'idea', 'praise']),
  message: z.string().trim().min(3, 'A few more words would help').max(2000),
  email: z.union([z.email('That email looks off'), z.literal('')]).optional(),
})

type Schema = z.output<typeof schema>
type Kind = Schema['kind']

const kinds: { value: Kind; label: string; icon: string }[] = [
  { value: 'bug', label: 'Something is broken', icon: 'i-lucide-bug' },
  { value: 'confusion', label: 'I got stuck', icon: 'i-lucide-circle-help' },
  { value: 'idea', label: 'I have an idea', icon: 'i-lucide-lightbulb' },
  { value: 'praise', label: 'Something I like', icon: 'i-lucide-heart' },
]

const state = reactive<{ kind: Kind; message: string; email: string }>({
  kind: 'idea',
  message: '',
  email: '',
})

function reset() {
  state.kind = 'idea'
  state.message = ''
  state.email = ''
  resetChallenge()
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  const sent = await submit({
    kind: event.data.kind,
    message: event.data.message,
    email: event.data.email || null,
    turnstileToken: turnstileToken.value || null,
  })

  if (!sent) {
    // A rejected challenge lands here too. Tokens are single-use and expire
    // after five minutes, so a retry has to start from a fresh one — and only
    // reset() asks for one. See resetChallenge().
    resetChallenge()
    toast.add({
      title: 'That didn’t send',
      description: 'Something went wrong on our end. Please try again.',
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
    return
  }

  open.value = false
  reset()
  toast.add({
    title: 'Thanks — got it',
    description: 'Every note gets read.',
    color: 'success',
    icon: 'i-lucide-check',
  })
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Send feedback"
    description="Bugs, ideas, or anything that felt wrong — it goes straight to the team."
  >
    <UButton
      class="min-touch"
      :icon="position === 'floating' ? 'i-lucide-message-square' : undefined"
      :label="props.label"
      :color="position === 'floating' ? 'neutral' : 'primary'"
      :variant="position === 'floating' ? 'outline' : 'solid'"
      :class="position === 'floating' ? 'fixed bottom-safe right-safe z-50 shadow-sm' : undefined"
    />

    <template #body>
      <UForm :schema="schema" :state="state" class="flex flex-col gap-4" @submit="onSubmit">
        <UFormField label="What kind of feedback?" name="kind">
          <USelect v-model="state.kind" :items="kinds" class="w-full" />
        </UFormField>

        <UFormField label="Tell us what happened" name="message">
          <UTextarea
            v-model="state.message"
            :rows="5"
            class="w-full"
            placeholder="The more specific, the more fixable."
            autoresize
          />
        </UFormField>

        <UFormField
          v-if="!loggedIn"
          label="Email"
          name="email"
          hint="Optional"
          description="Only so we can reply — nothing else."
        >
          <UInput v-model="state.email" type="email" class="w-full" placeholder="you@example.com" />
        </UFormField>

        <!-- Only for signed-out submitters, and only once a site key exists.
             Renders nothing — and loads nothing from challenges.cloudflare.com —
             in a fork that hasn't configured Turnstile. -->
        <UFormField
          v-if="challengeRequired"
          label="Confirm you’re human"
          name="turnstile"
          description="A quick automated check. Usually nothing to click."
        >
          <NuxtTurnstile ref="turnstile" v-model="turnstileToken" />
        </UFormField>

        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            type="submit"
            label="Send feedback"
            :loading="pending"
            :disabled="challengeRequired && !turnstileToken"
          />
        </div>
      </UForm>
    </template>
  </UModal>
</template>
