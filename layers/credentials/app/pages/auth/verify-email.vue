<script setup lang="ts">
import { z } from 'zod'

import { PRF_UNAVAILABLE } from '../../utils/passkey-ceremony'

definePageMeta({ layout: 'default', middleware: ['credentials'] })

const config = useRuntimeConfig()
const { completeSignUp } = useCredentials()
const passkeys = usePasskeys()

// The token rides in the fragment, which is never sent to a server, so it
// reaches no access log and no Referer.
const { params: fragment, resolved } = useFragmentParams()
const token = computed(() => (resolved.value ? (fragment.value?.get('token') ?? '') : ''))

// A passkey first where this device can make one: nothing to remember. The
// password stays one press away, and is the only way where it cannot.
const usePassword = ref(false)
const offerPasskey = computed(() => passkeys.canCreateAccount.value && !usePassword.value)

const schema = z.object({ password: credentialsPasswordFieldSchema })
const state = reactive({ password: '' })
const pending = ref(false)
const failure = ref<string | null>(null)
const notice = ref<string | null>(null)

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

async function createWithPasskey() {
  pending.value = true
  failure.value = null
  try {
    await passkeys.createAccount({ token: token.value })
    await navigateTo('/dashboard')
  } catch (error) {
    if (credentialsErrorCode(error) === PRF_UNAVAILABLE) {
      usePassword.value = true
      notice.value = `${passkeys.device.value.method} can't be used for this account on this device. Choose a password instead.`
    } else {
      failure.value = credentialsErrorMessage(error)
    }
  } finally {
    pending.value = false
  }
}

useSeo({
  title: 'Finish creating your account',
  description: `Finish creating your ${config.public.appName} account with the link from your email.`,
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Finish creating your account</h1>
      <p v-if="offerPasskey" class="mt-2 text-muted">
        No password to remember: you'll sign in the way you unlock this device.
      </p>
      <p v-else class="mt-2 text-muted">
        Your password never leaves this device: we store a value derived from it, not the password.
      </p>
    </div>

    <UCard>
      <div v-if="!resolved" class="flex flex-col gap-3" aria-live="polite">
        <p class="text-sm text-muted">Checking your link…</p>
        <USkeleton class="h-10 w-full" />
      </div>

      <div v-else-if="token && offerPasskey" class="flex flex-col gap-4">
        <UAlert
          v-if="failure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="failure"
        />
        <UButton
          size="lg"
          block
          icon="i-lucide-fingerprint"
          :loading="pending"
          @click="createWithPasskey"
        >
          Continue with {{ passkeys.device.value.method }}
        </UButton>
        <UButton color="neutral" variant="ghost" block @click="usePassword = true">
          Use a password instead
        </UButton>
      </div>

      <UForm
        v-else-if="token"
        :schema="schema"
        :state="state"
        class="flex flex-col gap-4"
        @submit="submit"
      >
        <UAlert
          v-if="notice"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          :description="notice"
        />
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
