<script setup lang="ts">
import { z } from 'zod'

// The one page that must work before anything else does. Three paths, in the
// order a consumer meets them:
//
//   1. Magic link — the primary control, and the only one that needs nothing
//      from the visitor but an address they already know. No password to invent
//      now and none to reset in six months, which is the actual reason to do it
//      this way rather than to save a form field.
//   2. OAuth — Apple, Google, then GitHub, and only for providers a fork has
//      actually configured (an unconfigured one dead-ends in nuxt-auth-utils'
//      "missing configuration" error rather than a sign-in). GitHub sits last
//      and ships off: see server/api/auth/providers.get.ts for why a developer
//      credential does not belong at the top of a consumer sign-in page.
//   3. Dev sign-in — email, no password, dev builds only. It's what makes
//      `git clone && bun dev` land on a signed-in session instead of an OAuth
//      registration detour. See server/api/auth/dev.post.ts.

definePageMeta({ layout: 'default' })

const route = useRoute()
const { loggedIn, fetch: refreshSession } = useUserSession()
const toast = useToast()
const config = useRuntimeConfig()

const { data: auth } = await useFetch('/api/auth/providers')

// The OAuth round trip drops query params, so `?redirect=` can't survive it.
// A cookie can: the server reads and clears it in popRedirectTarget(). The
// magic-link path sets the same cookie, and additionally copies the destination
// onto the token row — the link may be opened on a different device, where this
// cookie does not exist (server/db/schema.ts › magic_link_tokens).
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
// The wording lives in app/utils/auth-errors.ts, shared with /auth/verify.
const errorMessage = computed(() => authErrorMessage(route.query.error))

const availableProviders = computed(() => auth.value?.providers.filter((p) => p.available) ?? [])
const canEmailLink = computed(() => auth.value?.emailSignIn ?? false)
const hasAnyMethod = computed(
  () => canEmailLink.value || availableProviders.value.length > 0 || auth.value?.devSignIn === true,
)

function signInWith(providerId: string) {
  redirectCookie.value = redirectTarget.value
  // External navigation: this is a server route that 302s off-origin, not a
  // Vue route. navigateTo without `external` would try to match it client-side.
  return navigateTo(`/api/auth/${providerId}`, { external: true })
}

// ── Magic link ──────────────────────────────────────────────────────────────
const linkSchema = z.object({ email: z.string().email('Enter a valid email address') })
const linkState = reactive({ email: '' })
const linkPending = ref(false)
const linkSent = ref(false)
const linkError = ref<string | null>(null)
/** Echoed back in the confirmation, so a typo is visible instead of silent. */
const sentTo = ref('')

async function sendMagicLink(resend = false) {
  linkPending.value = true
  linkError.value = null
  try {
    // Same cookie the OAuth buttons set, for the same reason.
    redirectCookie.value = redirectTarget.value
    await $fetch('/api/auth/magic-link', { method: 'POST', body: { email: linkState.email } })
    sentTo.value = linkState.email
    linkSent.value = true
    if (resend) toast.add({ title: 'Sent again', color: 'success', icon: 'i-lucide-mail-check' })
  } catch (error) {
    linkError.value = authErrorMessage(authErrorCode(error))
  } finally {
    linkPending.value = false
  }
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
      <p class="mt-2 text-muted">
        Enter your email and we'll send you a link. No password to create, and none to forget.
      </p>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="errorMessage"
    />

    <UCard v-if="canEmailLink">
      <!-- Sent state. Says "if that address has an account" rather than "sent to
           you", because the endpoint deliberately answers identically for an
           address it has never seen — see server/api/auth/magic-link.post.ts. -->
      <div v-if="linkSent" class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-mail-check" class="mt-1 size-5 shrink-0 text-primary" />
          <div>
            <p class="font-medium text-highlighted">Check your inbox</p>
            <p class="mt-1 text-sm text-muted">
              If <span class="text-default">{{ sentTo }}</span> can receive mail, a sign-in link is
              on its way. It works once and expires in 15 minutes.
            </p>
          </div>
        </div>

        <UAlert
          v-if="linkError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="linkError"
        />

        <div class="flex flex-col gap-2 sm:flex-row">
          <UButton
            color="neutral"
            variant="outline"
            block
            :loading="linkPending"
            @click="sendMagicLink(true)"
          >
            Send it again
          </UButton>
          <UButton color="neutral" variant="ghost" block @click="linkSent = false">
            Use a different address
          </UButton>
        </div>
      </div>

      <UForm
        v-else
        :schema="linkSchema"
        :state="linkState"
        class="flex flex-col gap-4"
        @submit="sendMagicLink()"
      >
        <UFormField label="Email" name="email">
          <UInput
            v-model="linkState.email"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            size="lg"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="linkError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="linkError"
        />

        <UButton type="submit" size="lg" icon="i-lucide-mail" block :loading="linkPending">
          Email me a sign-in link
        </UButton>
      </UForm>
    </UCard>

    <template v-if="availableProviders.length">
      <USeparator label="or" />

      <div class="flex flex-col gap-3">
        <!-- All neutral, all outline. One primary button per view (DESIGN.md ›
             Component behavior), and on this page that button is the magic
             link. -->
        <UButton
          v-for="provider in availableProviders"
          :key="provider.id"
          :icon="provider.icon"
          size="lg"
          color="neutral"
          variant="outline"
          block
          @click="signInWith(provider.id)"
        >
          Continue with {{ provider.label }}
        </UButton>
      </div>
    </template>

    <UAlert
      v-if="!hasAnyMethod"
      color="neutral"
      variant="subtle"
      icon="i-lucide-key-round"
      title="No sign-in method is configured"
      description="Set NUXT_RESEND_API_KEY and NUXT_RESEND_FROM to enable email sign-in, or add an OAuth provider. See .env.example."
    />

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
          With no Resend key set, the magic link above logs its URL to the dev server console
          instead of sending it.
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
