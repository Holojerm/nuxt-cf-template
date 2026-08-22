<script setup lang="ts">
// /auth/verify#token=… — the page a sign-in link opens.
//
// ── Why the token is in the fragment ─────────────────────────────────────────
// A URL fragment is the one part of a URL the browser never puts on the wire.
// As `?token=` the live credential was written to Cloudflare Logs on every
// visit, forwarded to PostHog as a same-origin `Referer` by the /ingest proxy,
// and attached to every autocaptured event as `window.location.href` — so it sat
// in the analytics warehouse, readable by everyone with project access, for the
// whole fifteen-minute window and *before* the user had clicked confirm. As a
// fragment it reaches no log and no proxy, and only this page ever sees it.
// The layers behind this one are in app/utils/analytics-privacy.ts.
//
// ── Why the link lands on a page with a button, and not on an API route ──────
// Because opening the link is not proof that a person opened it. Mail security
// gateways (Defender Safe Links, Proofpoint, Mimecast) fetch every URL in an
// incoming message before the recipient sees it, and browsers and mail clients
// prefetch links speculatively. All of that is GET traffic. A link that signs
// you in by being fetched is a link a robot spends: the human clicks and is told
// it was already used, and the session went to a scanner.
//
// So the token is only ever spent by the POST behind this button. The GET this
// page makes on load merely *asks* about the token — see
// server/api/auth/magic-link/verify.get.ts. The cost is one click, which reads
// as a confirmation step rather than as friction, and it is also where we get to
// show which address is about to be signed in.
//
// ── Why that lookup is client-only ──────────────────────────────────────────
// `server: false`, and deliberately. Rendered on the server, this fetch would be
// an internal request whose client IP the auth surface's per-IP rate limiter
// cannot see, so every visitor's lookup would share one bucket and a busy minute
// would 429 real sign-ins. Client-side it is one request from the real address,
// counted against the real caller. It also keeps the token out of the SSR
// payload, and leaves this page's HTML identical for everyone.

definePageMeta({ layout: 'default' })

const route = useRoute()
const { fetch: refreshSession } = useUserSession()
const config = useRuntimeConfig()

const token = ref('')
/** Has the browser had a chance to read the URL yet? False through SSR. */
const resolved = ref(false)

const { data: link, status, execute } = await useFetch('/api/auth/magic-link/verify', {
  query: { token },
  server: false,
  // Not `Boolean(token)`: a fragment is not sent to the server, so during SSR
  // there is nothing to test and the token can only be read after mount.
  immediate: false,
})

function syncToken() {
  token.value = readToken()
  resolved.value = true
  if (token.value) execute()
}

// Read on mount because the fragment does not exist during SSR, and re-read on
// change because a hash-only navigation does not remount the component — so
// without the watcher a second link opened in the same tab would be checked
// against the first link's token.
onMounted(syncToken)
watch(() => route.hash, syncToken)

/**
 * Fragment first, query second.
 *
 * The query fallback is not a second supported spelling — nothing mints one any
 * more. It is there for a link created by an older deploy, and for a URL
 * reassembled by hand, both of which should still work rather than read as
 * "invalid". Anything arriving that way is scrubbed out of analytics by
 * app/utils/analytics-privacy.ts.
 */
function readToken(): string {
  const fragment = new URLSearchParams(route.hash.replace(/^#/, '')).get('token')
  if (fragment) return fragment
  return typeof route.query.token === 'string' ? route.query.token : ''
}

// Before mount there is nothing to say yet — rendering the failure state during
// SSR would flash "we don't recognise that link" at every valid link.
const checking = computed(
  () => !resolved.value || (Boolean(token.value) && ['idle', 'pending'].includes(status.value)),
)
const valid = computed(() => link.value?.status === 'valid')

/** The reason this link is unusable, as a code the shared error map knows. */
const problem = computed(() => {
  if (checking.value || valid.value) return null
  if (!token.value) return 'link_invalid'
  // A failed request is not the same as an expired link, but it is the same
  // dead end for the reader, and the recovery is identical: ask for a new one.
  if (status.value === 'error' || !link.value) return 'link_invalid'
  return `link_${link.value.status}`
})

const pending = ref(false)
const failure = ref<string | null>(null)

async function confirm() {
  pending.value = true
  failure.value = null
  try {
    const result = await $fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      body: { token: token.value },
    })
    await refreshSession()
    // Resolved server-side through popRedirectTarget() + safeRedirectPath(), so
    // this is a same-origin path and not a value from the URL we were opened
    // with.
    await navigateTo(result.redirectTo)
  } catch (error) {
    failure.value = authErrorMessage(authErrorCode(error))
  } finally {
    pending.value = false
  }
}

useSeo({
  title: 'Confirm sign-in',
  description: `Finish signing in to ${config.public.appName} with the link from your email.`,
  // A token URL. Nothing here should ever be crawled, indexed, or shared.
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <h1 class="text-3xl text-highlighted">Confirm sign-in</h1>

    <UCard>
      <!-- Checking. A skeleton rather than a spinner (DESIGN.md › Motion), and
           it lasts one round trip. -->
      <div v-if="checking" class="flex flex-col gap-3" aria-live="polite">
        <p class="text-sm text-muted">Checking your link…</p>
        <USkeleton class="h-5 w-3/4" />
        <USkeleton class="h-10 w-full" />
      </div>

      <div v-else-if="valid" class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-mail-open" class="mt-1 size-5 shrink-0 text-primary" />
          <p class="text-muted">
            You're about to sign in as
            <!-- data-private is the maskTextSelector configured in
                 app/plugins/posthog.client.ts: session replay records this page,
                 and the address is the one piece of PII on it. -->
            <span class="text-highlighted" data-private>{{ link?.email }}</span>
            — if that isn't the account you wanted, request a link for the right address instead.
          </p>
        </div>

        <UAlert
          v-if="failure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="failure"
        />

        <UButton size="lg" block :loading="pending" @click="confirm">Sign in</UButton>
        <UButton to="/login" color="neutral" variant="ghost" block>Use another address</UButton>
      </div>

      <div v-else class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-circle-alert" class="mt-1 size-5 shrink-0 text-muted" />
          <p class="text-muted">{{ authErrorMessage(problem) }}</p>
        </div>
        <UButton to="/login" size="lg" block>Request a new link</UButton>
      </div>
    </UCard>
  </div>
</template>
