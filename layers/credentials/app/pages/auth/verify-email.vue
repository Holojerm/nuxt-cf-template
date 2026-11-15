<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ layout: 'default', middleware: ['credentials'] })

const config = useRuntimeConfig()
const { completeSignUp } = useCredentials()

// The token rides in the fragment, which is never sent to a server, so it
// reaches no access log and no Referer.
const { params: fragment, resolved } = useFragmentParams()
const token = computed(() => (resolved.value ? (fragment.value?.get('token') ?? '') : ''))

const schema = z.object({ password: credentialsPasswordFieldSchema })
const state = reactive({ password: '' })
const pending = ref(false)
const failure = ref<string | null>(null)

// The password is chosen here, by whoever opened the mail, and the form is what
// spends the token: a mail gateway that fetches the link finishes nothing.
async function submit() {
  pending.value = true
  failure.value = null
  try {
    await completeSignUp({ token: token.value, password: state.password })
    await navigateTo('/dashboard')
  } catch (error) {
    failure.value = credentialsErrorMessage(error)
  } finally {
    pending.value = false
  }
}

useSeo({
  title: 'Choose your password',
  description: `Finish creating your ${config.public.appName} account with the link from your email.`,
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Choose your password</h1>
      <p class="mt-2 text-muted">
        Your password never leaves this device: we store a value derived from it, not the password.
      </p>
    </div>

    <UCard>
      <div v-if="!resolved" class="flex flex-col gap-3" aria-live="polite">
        <p class="text-sm text-muted">Checking your link…</p>
        <USkeleton class="h-10 w-full" />
      </div>

      <UForm
        v-else-if="token"
        :schema="schema"
        :state="state"
        class="flex flex-col gap-4"
        @submit="submit"
      >
        <UFormField
          label="Password"
          name="password"
          :help="`At least ${CREDENTIALS_MIN_PASSWORD_LENGTH} characters.`"
        >
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="new-password"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="failure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="failure"
        />
        <UButton type="submit" size="lg" block :loading="pending">Create account</UButton>
        <UButton to="/auth/sign-in" color="neutral" variant="ghost" block>Sign in instead</UButton>
      </UForm>

      <div v-else class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-circle-alert" class="mt-1 size-5 shrink-0 text-muted" />
          <p class="text-muted">
            This page needs the link from your sign-up email. Open it from the message, or sign up
            again to get a new one.
          </p>
        </div>
        <UButton to="/auth/sign-up" size="lg" block>Create an account</UButton>
      </div>
    </UCard>
  </div>
</template>
