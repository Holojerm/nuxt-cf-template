<script setup lang="ts">
// <UpdatesForm /> — "email me when something new ships", for a visitor with no
// account. Drop it on any public page; it renders nothing for someone signed in,
// whose account already has a Product updates switch.
//
// Submitting sends one confirmation email and nothing else: the address is only
// added once its owner confirms from that email (server/utils/subscribers.ts).
// The copy says so, and says how to stop, before anyone types anything.

import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

const config = useRuntimeConfig()
const { loggedIn } = useUserSession()
const headingId = useId()

const schema = z.object({ email: z.string().trim().email('Enter a valid email address') })
type Schema = z.output<typeof schema>

const state = reactive({ email: '' })
const pending = ref(false)
const sent = ref(false)
const failed = ref(false)

// Mounted on first focus, not on page load: the widget pulls a script from
// challenges.cloudflare.com, and most readers of a page never touch this form.
const challengeRequired = Boolean(config.public.turnstile.siteKey)
const challengeShown = ref(false)
const turnstileToken = ref('')
const turnstile = ref<{ reset: () => void } | null>(null)

async function onSubmit(event: FormSubmitEvent<Schema>) {
  pending.value = true
  failed.value = false
  try {
    await $fetch('/api/email/updates', {
      method: 'POST',
      body: { email: event.data.email, turnstileToken: turnstileToken.value || null },
    })
    sent.value = true
  } catch {
    failed.value = true
    // A token is single-use: the failed request spent this one.
    turnstileToken.value = ''
    turnstile.value?.reset()
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <section
    v-if="!loggedIn"
    :aria-labelledby="headingId"
    class="flex flex-col gap-4 rounded-lg border border-default p-6"
  >
    <div class="flex flex-col gap-1">
      <h2 :id="headingId" class="text-lg text-highlighted">Product updates by email</h2>
      <p class="text-sm text-muted">
        An occasional email when something new ships in {{ config.public.appName }}. No account
        needed, and every email has a link that removes your address.
      </p>
    </div>

    <div v-if="sent" class="flex items-start gap-3" role="status">
      <UIcon name="i-lucide-mail-check" class="mt-1 size-5 shrink-0 text-primary" />
      <p class="text-sm text-muted">
        Check your inbox for a link to confirm. Nothing else is sent until you do, and an address
        that is never confirmed is deleted after a week.
      </p>
    </div>

    <UForm v-else :schema="schema" :state="state" class="flex flex-col gap-3" @submit="onSubmit">
      <UFormField label="Email address" name="email">
        <UInput
          v-model="state.email"
          type="email"
          autocomplete="email"
          placeholder="you@example.com"
          class="w-full"
          @focus="challengeShown = true"
        />
      </UFormField>

      <NuxtTurnstile
        v-if="challengeRequired && challengeShown"
        ref="turnstile"
        v-model="turnstileToken"
      />

      <UAlert
        v-if="failed"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        description="That didn't go through. Please try again in a moment."
      />

      <div>
        <UButton
          type="submit"
          :loading="pending"
          :disabled="challengeRequired && challengeShown && !turnstileToken"
        >
          Send me updates
        </UButton>
      </div>
    </UForm>
  </section>
</template>
