<script setup lang="ts">
// /unsubscribe#u=…&e=…&t=… — where an email footer's Unsubscribe link lands.
//
// ── Why this page exists at all ──────────────────────────────────────────────
// The link in an email footer is a GET, and every URL in inbound mail is
// fetched by a security gateway before a human sees it (Defender Safe Links,
// Proofpoint, Mimecast). When GET /api/email/unsubscribe performed the opt-out
// directly, a corporate mail gateway could unsubscribe someone from mail they
// had asked for, leaving nothing behind but a preference row nobody set. Same
// hazard, same shape, and the same fix as the magic-link flow: the GET
// authenticates and hands off here, and only this page's button writes.
//
// It also has to work signed OUT. The old flow redirected to /account, which is
// auth-gated, so anyone reading their email on a device they weren't signed in
// on got bounced to /login with no idea whether it had worked.
//
// The parameters arrive in the fragment, so this page's own request carries no
// signed token — nothing to land in an access log or a `Referer`.

definePageMeta({ layout: 'default' })

const config = useRuntimeConfig()

interface UnsubscribeParams {
  u: string
  e: string
  t: string
}

const route = useRoute()

const params = ref<UnsubscribeParams | null>(null)
const resolved = ref(false)
const pending = ref(false)
const done = ref(false)
const failed = ref(false)

function readParams() {
  const fragment = new URLSearchParams(route.hash.replace(/^#/, ''))
  const u = fragment.get('u')
  const e = fragment.get('e')
  const t = fragment.get('t')
  params.value = u && e && t ? { u, e, t } : null
  done.value = false
  failed.value = false
  resolved.value = true
}

// Read on mount because the fragment does not exist during SSR, and re-read on
// change because a hash-only navigation does not remount the component — so
// without the watcher a second link opened in the same tab would act on the
// first link's parameters.
onMounted(readParams)
watch(() => route.hash, readParams)

/**
 * What the reader is about to switch off, in the same words the /account
 * preferences section uses. Falls back to the raw event type rather than
 * hiding it: an unrecognised type still deserves an honest label, and the
 * server validates the value against the same list anyway.
 *
 * Used verbatim, as a name — the copy around it never appends "email", because
 * "Welcome email" already ends in the word and "Referral program" is not one.
 */
const label = computed(() => {
  const eventType = params.value?.e
  if (!eventType) return null
  return isOptionalNotificationEventType(eventType)
    ? OPTIONAL_NOTIFICATION_COPY[eventType].label
    : eventType
})

async function confirm() {
  if (!params.value) return
  pending.value = true
  failed.value = false
  try {
    // Same endpoint a mail provider's one-click button POSTs to (RFC 8058).
    await $fetch('/api/email/unsubscribe', { method: 'POST', query: params.value })
    done.value = true
  } catch {
    failed.value = true
  } finally {
    pending.value = false
  }
}

useSeo({
  title: 'Unsubscribe',
  description: `Stop receiving a type of email from ${config.public.appName}.`,
  // A signed token in the URL, and a page that only makes sense arriving from
  // an email. Nothing here belongs in an index.
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <h1 class="text-3xl text-highlighted">Unsubscribe</h1>

    <UCard>
      <div v-if="!resolved" class="flex flex-col gap-3" aria-live="polite">
        <USkeleton class="h-5 w-3/4" />
        <USkeleton class="h-10 w-full" />
      </div>

      <div v-else-if="done" class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-circle-check" class="mt-1 size-5 shrink-0 text-primary" />
          <p class="text-muted">
            Done — you're unsubscribed from <span class="text-highlighted">{{ label }}</span
            >. You can turn it back on any time from your account settings.
          </p>
        </div>
        <UButton to="/account" color="neutral" variant="outline" block>
          Manage email preferences
        </UButton>
      </div>

      <div v-else-if="params" class="flex flex-col gap-4">
        <p class="text-muted">
          Unsubscribe from <span class="text-highlighted">{{ label }}</span
          >? Billing and security email will keep coming — those aren't optional.
        </p>

        <UAlert
          v-if="failed"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          description="That didn't go through. Try again, or change it from your account settings."
        />

        <UButton size="lg" block :loading="pending" @click="confirm">Unsubscribe</UButton>
        <UButton to="/" color="neutral" variant="ghost" block>Keep them coming</UButton>
      </div>

      <div v-else class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-circle-alert" class="mt-1 size-5 shrink-0 text-muted" />
          <p class="text-muted">
            This unsubscribe link is incomplete — mail clients sometimes cut long links in half.
            You can change any email preference from your account settings instead.
          </p>
        </div>
        <UButton to="/account" size="lg" block>Go to account settings</UButton>
      </div>
    </UCard>
  </div>
</template>
