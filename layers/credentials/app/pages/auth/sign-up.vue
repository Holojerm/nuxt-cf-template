<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ layout: 'default', middleware: ['credentials'] })

const route = useRoute()
const config = useRuntimeConfig()
const { loggedIn } = useUserSession()
const { signUp } = useCredentials()
const challenge = useCredentialsChallenge()

if (loggedIn.value) await navigateTo('/dashboard')

const schema = z.object({ email: z.string().email('Enter a valid email address') })
const state = reactive({ email: '' })
const pending = ref(false)
const failure = ref<string | null>(null)
const sentTo = ref('')
const devLink = ref<string | null>(null)

async function submit() {
  pending.value = true
  failure.value = null
  try {
    const answer = await signUp({ email: state.email, turnstileToken: challenge.token.value })
    devLink.value = answer.devLink ?? null
    sentTo.value = state.email
  } catch (error) {
    failure.value = credentialsErrorMessage(error)
  } finally {
    pending.value = false
    challenge.reset()
  }
}

useSeo({
  title: 'Create an account',
  description: `Create your ${config.public.appName} account.`,
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Create an account</h1>
      <p class="mt-2 text-muted">
        Enter your email and we'll send you a link. You choose your password when you open it.
      </p>
    </div>

    <UCard>
      <!-- "If that address can receive mail", not "sent": the endpoint answers the
           same for an address that already has an account. -->
      <div v-if="sentTo" class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-mail-check" class="mt-1 size-5 shrink-0 text-primary" />
          <div>
            <p class="font-medium text-highlighted">Check your inbox</p>
            <p class="mt-1 text-sm text-muted">
              If <span class="text-default" data-private>{{ sentTo }}</span> can receive mail, a
              link to finish creating your account is on its way. It works once and expires in an
              hour.
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
              Open the confirmation link
            </ULink>
          </template>
        </UAlert>
        <UButton color="neutral" variant="ghost" block @click="sentTo = ''">
          Use a different address
        </UButton>
      </div>

      <UForm v-else :schema="schema" :state="state" class="flex flex-col gap-4" @submit="submit">
        <UFormField label="Email" name="email">
          <UInput
            v-model="state.email"
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
          Email me a link
        </UButton>
      </UForm>
    </UCard>

    <p class="text-center text-sm text-muted">
      Already have an account?
      <ULink
        :to="{ path: '/auth/sign-in', query: route.query }"
        class="text-primary underline underline-offset-2"
      >
        Sign in
      </ULink>
    </p>
    <p class="text-center text-sm text-muted">
      By creating an account you agree to our
      <ULink to="/terms" class="text-primary underline underline-offset-2">Terms</ULink>
      and
      <ULink to="/privacy" class="text-primary underline underline-offset-2">Privacy Policy</ULink>.
    </p>
  </div>
</template>
