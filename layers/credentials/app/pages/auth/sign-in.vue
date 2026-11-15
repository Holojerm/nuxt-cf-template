<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ layout: 'default', middleware: ['credentials'] })

const route = useRoute()
const config = useRuntimeConfig()
const { loggedIn } = useUserSession()
const { signIn } = useCredentials()
const passkeys = usePasskeys()
const challenge = useCredentialsChallenge()

const redirectTarget = computed(() => {
  const value = route.query.redirect
  return safeRedirectPath(typeof value === 'string' ? value : undefined, '/dashboard')
})

// Once, for someone who arrives already signed in. Not a watcher: after a
// sign-in the composable navigates itself, when the unlock hook has finished.
if (loggedIn.value) await navigateTo(redirectTarget.value)

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
})
const state = reactive({ email: '', password: '' })
const pending = ref(false)
const passkeyPending = ref(false)
const failure = ref<string | null>(null)

async function submit() {
  pending.value = true
  failure.value = null
  try {
    await signIn({ ...state, turnstileToken: challenge.token.value })
    await navigateTo(redirectTarget.value)
  } catch (error) {
    failure.value = credentialsErrorMessage(error)
  } finally {
    pending.value = false
    challenge.reset()
  }
}

async function usePasskey() {
  passkeyPending.value = true
  failure.value = null
  try {
    await passkeys.signIn()
    await navigateTo(redirectTarget.value)
  } catch (error) {
    failure.value = credentialsErrorMessage(error)
  } finally {
    passkeyPending.value = false
  }
}

useSeo({
  title: 'Sign in',
  description: `Sign in to ${config.public.appName} with your password or a passkey.`,
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Sign in</h1>
      <p class="mt-2 text-muted">Use your password, or a passkey saved on this device.</p>
    </div>

    <UAlert
      v-if="failure"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="failure"
    />

    <UCard>
      <UForm :schema="schema" :state="state" class="flex flex-col gap-4" @submit="submit">
        <UFormField label="Email" name="email">
          <UInput
            v-model="state.email"
            type="email"
            autocomplete="username webauthn"
            placeholder="you@example.com"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Password" name="password">
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="current-password"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <NuxtTurnstile
          v-if="challenge.required"
          :ref="challenge.widget"
          v-model="challenge.token.value"
        />
        <UButton
          type="submit"
          size="lg"
          block
          :loading="pending"
          :disabled="challenge.blocked.value"
        >
          Sign in
        </UButton>
      </UForm>
    </UCard>

    <template v-if="passkeys.isSupported.value">
      <USeparator label="or" />
      <!-- Neutral and outlined: one primary button per view (DESIGN.md › Component behavior). -->
      <UButton
        icon="i-lucide-fingerprint"
        size="lg"
        color="neutral"
        variant="outline"
        block
        :loading="passkeyPending"
        @click="usePasskey"
      >
        Sign in with a passkey
      </UButton>
    </template>

    <p class="text-center text-sm text-muted">
      <ULink to="/auth/reset" class="text-primary underline underline-offset-2">
        Forgot password?
      </ULink>
      <span aria-hidden="true"> · </span>
      <ULink
        :to="{ path: '/auth/sign-up', query: route.query }"
        class="text-primary underline underline-offset-2"
      >
        Create an account
      </ULink>
    </p>
  </div>
</template>
