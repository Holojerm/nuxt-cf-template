<script setup lang="ts">
import { z } from 'zod'

// The one page that must work before anything else does. Two paths:
//   1. OAuth — the real flow. Buttons only appear for providers that are
//      actually configured, because an unconfigured one dead-ends in
//      nuxt-auth-utils' "missing configuration" error rather than a sign-in.
//   2. Dev sign-in — email, no password, dev builds only. It's what makes
//      `git clone && bun dev` land on a signed-in session instead of an OAuth
//      registration detour. See server/api/auth/dev.post.ts.

definePageMeta({ layout: 'default' })

const route = useRoute()
const { loggedIn, fetch: refreshSession } = useUserSession()
const toast = useToast()
const config = useRuntimeConfig()

const { data: auth } = await useFetch('/api/auth/providers')

// The OAuth round trip drops query params, so `?redirect=` can't survive it.
// A cookie can: the server reads and clears it in popRedirectTarget().
const redirectCookie = useCookie('auth-redirect', {
  path: '/',
  sameSite: 'lax',
  maxAge: 600,
})

const redirectTarget = computed(() => {
  const value = route.query.redirect
  return typeof value === 'string' && value.startsWith('/') ? value : '/dashboard'
})

// Already signed in? Nothing here to do.
watchEffect(() => {
  if (loggedIn.value) navigateTo(redirectTarget.value)
})

// Provider errors come back as a code so the URL never carries a raw message.
const ERROR_MESSAGES: Record<string, string> = {
  no_email: "That provider didn't share an email address, so we can't create an account.",
  unverified_email:
    'That email address is unverified. Verify it with your provider, then try again.',
  provider_error: "The sign-in provider returned an error. That's usually temporary — try again.",
  sign_in_failed: 'Something went wrong signing you in. Try again.',
}

const errorMessage = computed(() => {
  const code = route.query.error
  if (typeof code !== 'string') return null
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.sign_in_failed
})

const availableProviders = computed(() => auth.value?.providers.filter((p) => p.available) ?? [])

function signInWith(providerId: string) {
  redirectCookie.value = redirectTarget.value
  // External navigation: this is a server route that 302s off-origin, not a
  // Vue route. navigateTo without `external` would try to match it client-side.
  return navigateTo(`/api/auth/${providerId}`, { external: true })
}

// ── Dev sign-in ─────────────────────────────────────────────────────────────
const devSchema = z.object({ email: z.string().email('Enter a valid email address') })
const devState = reactive({ email: 'demo@example.com' })
const devPending = ref(false)

async function signInAsDev() {
  devPending.value = true
  try {
    await $fetch('/api/auth/dev', { method: 'POST', body: { email: devState.email } })
    await refreshSession()
    await navigateTo(redirectTarget.value)
  } catch {
    toast.add({ title: 'Could not sign in', color: 'error' })
  } finally {
    devPending.value = false
  }
}

useSeo({
  title: 'Sign in',
  description: `Sign in to ${config.public.appName}.`,
  // Nothing here is useful in an index, and an indexed login page competes with
  // the landing page for brand queries.
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Sign in</h1>
      <p class="mt-2 text-muted">No password to remember — we use the account you already have.</p>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="errorMessage"
    />

    <UCard>
      <div class="flex flex-col gap-3">
        <UButton
          v-for="provider in availableProviders"
          :key="provider.id"
          :icon="provider.icon"
          size="lg"
          block
          :color="provider.id === availableProviders[0]?.id ? 'primary' : 'neutral'"
          :variant="provider.id === availableProviders[0]?.id ? 'solid' : 'outline'"
          @click="signInWith(provider.id)"
        >
          Continue with {{ provider.label }}
        </UButton>

        <UAlert
          v-if="!availableProviders.length"
          color="neutral"
          variant="subtle"
          icon="i-lucide-key-round"
          title="No sign-in provider is configured"
          description="Set NUXT_OAUTH_GITHUB_CLIENT_ID and NUXT_OAUTH_GITHUB_CLIENT_SECRET (or the Google pair) to enable real sign-in. See .env.example."
        />
      </div>
    </UCard>

    <!-- Dev-only. `devSignIn` is a compile-time constant on the server, so this
         block is unreachable in a production build. -->
    <UCard v-if="auth?.devSignIn">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-flask-conical" class="text-muted" />
          <span class="text-sm font-medium text-highlighted">Development sign-in</span>
        </div>
      </template>

      <UForm
        :schema="devSchema"
        :state="devState"
        class="flex flex-col gap-4"
        @submit="signInAsDev"
      >
        <p class="text-sm text-muted">
          Any email signs you in — no password, no provider. This route returns 404 in production.
        </p>
        <UFormField label="Email" name="email">
          <UInput v-model="devState.email" type="email" autocomplete="off" class="w-full" />
        </UFormField>
        <UButton type="submit" color="neutral" variant="outline" :loading="devPending" block>
          Sign in as this user
        </UButton>
      </UForm>
    </UCard>

    <p class="text-center text-sm text-muted">
      By signing in you agree to our
      <ULink to="/terms" class="text-primary underline underline-offset-2">Terms</ULink>
      and
      <ULink to="/privacy" class="text-primary underline underline-offset-2">Privacy Policy</ULink>.
    </p>
  </div>
</template>
