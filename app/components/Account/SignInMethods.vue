<script setup lang="ts">
// "Sign-in methods" on /account: the email link (always, it is the account's
// address), every linked provider account, and a button for each configured
// provider that could be added. Linking runs through the provider and comes back
// here with `?linked=` or `?link_error=` (server/utils/oauth-callback.ts).
//
// No unlink: a provider whose address matches the account would be re-linked by
// its next sign-in anyway, and the one case it would mean something (a hidden
// Apple address) is the one where removing it can lock the person out.

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { user } = useUserSession()

const { data } = await useFetch('/api/account/identities')
const pending = ref<string | null>(null)

const LINK_ERRORS: Record<string, string> = {
  taken:
    'That account already signs in to a different account here, so it was not linked. Sign in with it to reach that account.',
  provider_error:
    "The provider returned an error, so nothing was linked. That's usually temporary.",
}

const labelFor = (id: string) =>
  data.value?.providers.find((provider) => provider.id === id)?.label ??
  id.charAt(0).toUpperCase() + id.slice(1)

const linkable = computed(() => {
  const linked = new Set(data.value?.identities.map((identity) => identity.provider))
  return data.value?.providers.filter((provider) => !linked.has(provider.id)) ?? []
})

onMounted(() => {
  const { linked, link_error: linkError, ...rest } = route.query
  if (typeof linked === 'string') {
    toast.add({ title: `${labelFor(linked)} is linked`, color: 'success' })
  } else if (typeof linkError === 'string') {
    toast.add({
      title: 'Not linked',
      description: LINK_ERRORS[linkError] ?? LINK_ERRORS.provider_error,
      color: 'error',
    })
  }
  if (linked !== undefined || linkError !== undefined) router.replace({ query: rest })
})

async function link(provider: string): Promise<void> {
  pending.value = provider
  try {
    const { url } = await $fetch('/api/account/identities/link', {
      method: 'POST',
      body: { provider },
    })
    await navigateTo(url, { external: true })
  } catch {
    pending.value = null
    toast.add({ title: 'Could not start linking', color: 'error' })
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl text-highlighted">Sign-in methods</h2>
    </template>

    <div class="flex flex-col gap-4">
      <ul class="flex flex-col gap-3">
        <li class="flex items-center gap-3">
          <UIcon name="i-lucide-mail" class="size-5 shrink-0 text-muted" />
          <div class="min-w-0">
            <p class="font-medium text-highlighted">Email link</p>
            <p class="truncate text-sm text-muted">{{ user?.email }}</p>
          </div>
        </li>
        <li
          v-for="identity in data?.identities ?? []"
          :key="`${identity.provider}:${identity.linkedAt}`"
          class="flex items-center gap-3"
        >
          <UIcon name="i-lucide-key-round" class="size-5 shrink-0 text-muted" />
          <div class="min-w-0">
            <p class="font-medium text-highlighted">{{ labelFor(identity.provider) }}</p>
            <p v-if="identity.email" class="truncate text-sm text-muted">{{ identity.email }}</p>
          </div>
        </li>
      </ul>

      <div v-if="linkable.length" class="flex flex-wrap gap-2">
        <UButton
          v-for="provider in linkable"
          :key="provider.id"
          :icon="provider.icon"
          color="neutral"
          variant="outline"
          :loading="pending === provider.id"
          :disabled="pending !== null"
          @click="link(provider.id)"
        >
          Link {{ provider.label }}
        </UButton>
      </div>

      <p class="text-sm text-muted">
        Linking lets you sign in to this account with that provider too, even when it shares a
        different or hidden email address.
      </p>
    </div>
  </UCard>
</template>
