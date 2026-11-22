<script setup lang="ts">
// /updates/confirm#s=…&t=… — where the confirmation email's link lands.
//
// The page confirms nothing by being opened. Every link in inbound mail is
// fetched by a security gateway before a person sees it, so a link that
// confirmed on load would subscribe addresses nobody confirmed. Only the button
// POSTs, which is the same split as app/pages/unsubscribe.vue and for the same
// reason. The parameters arrive in the fragment, so this page's own request
// carries no token.

definePageMeta({ layout: 'default' })

const config = useRuntimeConfig()

const pending = ref(false)
const outcome = ref<'confirmed' | 'gone' | null>(null)
const failed = ref(false)

const { params: fragment, resolved } = useFragmentParams(() => {
  outcome.value = null
  failed.value = false
})

const params = computed(() => {
  const s = fragment.value?.get('s')
  const t = fragment.value?.get('t')
  return s && t ? { s, t } : null
})

async function confirm() {
  if (!params.value) return
  pending.value = true
  failed.value = false
  try {
    const result = await $fetch('/api/email/updates/confirm', {
      method: 'POST',
      body: params.value,
    })
    outcome.value = result.state
  } catch {
    failed.value = true
  } finally {
    pending.value = false
  }
}

useSeo({
  title: 'Confirm your email',
  description: `Confirm your address to get product updates from ${config.public.appName}.`,
  // A signed token in the URL, and a page that only makes sense from an email.
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 py-12">
    <h1 class="text-3xl text-highlighted">Confirm your email</h1>

    <UCard>
      <div v-if="!resolved" class="flex flex-col gap-3" aria-live="polite">
        <USkeleton class="h-5 w-3/4" />
        <USkeleton class="h-10 w-full" />
      </div>

      <div v-else-if="outcome === 'confirmed'" class="flex items-start gap-3" role="status">
        <UIcon name="i-lucide-circle-check" class="mt-1 size-5 shrink-0 text-primary" />
        <p class="text-muted">
          Done — you'll get an occasional email when something new ships. Every one has a link that
          removes your address.
        </p>
      </div>

      <div v-else-if="outcome === 'gone'" class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-circle-alert" class="mt-1 size-5 shrink-0 text-muted" />
          <p class="text-muted">
            This link is more than a week old, so the address it was for has been deleted. You can
            ask for updates again from the home page.
          </p>
        </div>
        <UButton to="/" size="lg" block>Go to the home page</UButton>
      </div>

      <div v-else-if="params" class="flex flex-col gap-4">
        <p class="text-muted">
          Confirm that you want product updates from
          <span class="text-highlighted">{{ config.public.appName }}</span> sent to this address.
        </p>

        <UAlert
          v-if="failed"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          description="That didn't go through. Try again, or open the link from your email once more."
        />

        <UButton size="lg" block :loading="pending" @click="confirm">Confirm</UButton>
        <UButton to="/" color="neutral" variant="ghost" block>No thanks</UButton>
      </div>

      <div v-else class="flex items-start gap-3">
        <UIcon name="i-lucide-circle-alert" class="mt-1 size-5 shrink-0 text-muted" />
        <p class="text-muted">
          This confirmation link is incomplete — mail clients sometimes cut long links in half. Open
          it again from the email, or copy the whole link into your browser.
        </p>
      </div>
    </UCard>
  </div>
</template>
