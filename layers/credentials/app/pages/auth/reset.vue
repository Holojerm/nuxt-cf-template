<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ layout: 'default', middleware: ['credentials'] })

const config = useRuntimeConfig()
const { requestReset, completeReset } = useCredentials()
const challenge = useCredentialsChallenge()

// One page, two steps: with no token it asks for an address; with the mailed
// token (in the fragment, so it reaches no log) it asks for the new password.
const { params: fragment, resolved } = useFragmentParams()
const token = computed(() => (resolved.value ? (fragment.value?.get('token') ?? '') : ''))

const pending = ref(false)
const failure = ref<string | null>(null)

const requestSchema = z.object({ email: z.string().email('Enter a valid email address') })
const requestState = reactive({ email: '' })
const sentTo = ref('')
const devLink = ref<string | null>(null)

async function request() {
  pending.value = true
  failure.value = null
  try {
    const answer = await requestReset({
      email: requestState.email,
      turnstileToken: challenge.token.value,
    })
    devLink.value = answer.devLink ?? null
    sentTo.value = requestState.email
  } catch (error) {
    failure.value = credentialsErrorMessage(error)
  } finally {
    pending.value = false
    challenge.reset()
  }
}

const passwordSchema = z.object({ password: credentialsPasswordFieldSchema })
const passwordState = reactive({ password: '' })

async function confirm() {
  pending.value = true
  failure.value = null
  try {
    await completeReset({ token: token.value, password: passwordState.password })
    await navigateTo('/dashboard')
  } catch (error) {
    failure.value = credentialsErrorMessage(error)
  } finally {
    pending.value = false
  }
}

useSeo({
  title: 'Reset your password',
  description: `Choose a new password for your ${config.public.appName} account.`,
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Reset your password</h1>
      <p class="mt-2 text-muted">
        {{
          token
            ? 'Choose a new password. Every device signed in with the old one is signed out.'
            : "Enter your email and we'll send you a link to choose a new one."
        }}
      </p>
    </div>

    <UCard>
      <div v-if="!resolved" class="flex flex-col gap-3" aria-live="polite">
        <p class="text-sm text-muted">Checking your link…</p>
        <USkeleton class="h-10 w-full" />
      </div>

      <UForm
        v-else-if="token"
        :schema="passwordSchema"
        :state="passwordState"
        class="flex flex-col gap-4"
        @submit="confirm"
      >
        <UFormField
          label="New password"
          name="password"
          :help="`At least ${CREDENTIALS_MIN_PASSWORD_LENGTH} characters.`"
        >
          <UInput
            v-model="passwordState.password"
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
        <UButton type="submit" size="lg" block :loading="pending">Set new password</UButton>
        <UButton to="/auth/reset" color="neutral" variant="ghost" block>
          Request a new link
        </UButton>
      </UForm>

      <!-- "If that address has an account": the endpoint answers the same for one that does not. -->
      <div v-else-if="sentTo" class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-mail-check" class="mt-1 size-5 shrink-0 text-primary" />
          <div>
            <p class="font-medium text-highlighted">Check your inbox</p>
            <p class="mt-1 text-sm text-muted">
              If <span class="text-default" data-private>{{ sentTo }}</span> has an account, a reset
              link is on its way. It works once and expires in 30 minutes.
            </p>
          </div>
        </div>
        <UAlert
          v-if="devLink"
          color="neutral"
          variant="subtle"
          icon="i-lucide-flask-conical"
          title="Development: no mail provider is configured"
        >
          <template #description>
            <ULink :to="devLink" external class="text-primary underline underline-offset-2">
              Open the reset link
            </ULink>
          </template>
        </UAlert>
        <UButton color="neutral" variant="ghost" block @click="sentTo = ''">
          Use a different address
        </UButton>
      </div>

      <UForm
        v-else
        :schema="requestSchema"
        :state="requestState"
        class="flex flex-col gap-4"
        @submit="request"
      >
        <UFormField label="Email" name="email">
          <UInput
            v-model="requestState.email"
            type="email"
            autocomplete="username"
            placeholder="you@example.com"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <NuxtTurnstile
          v-if="challenge.required"
          :ref="challenge.widget"
          v-model="challenge.token.value"
        />
        <UAlert
          v-if="failure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="failure"
        />
        <UButton
          type="submit"
          size="lg"
          icon="i-lucide-mail"
          block
          :loading="pending"
          :disabled="challenge.blocked.value"
        >
          Email me a reset link
        </UButton>
      </UForm>
    </UCard>

    <p class="text-center text-sm text-muted">
      <ULink to="/auth/sign-in" class="text-primary underline underline-offset-2">
        Back to sign in
      </ULink>
    </p>
  </div>
</template>
