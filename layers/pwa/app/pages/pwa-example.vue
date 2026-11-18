<script setup lang="ts">
// The worked example of an offline route and the outbox, and the page the
// layer's browser spec drives. Dev only: the layer's nuxt.config strips it from
// a production route table, and its API routes 404 outside `nuxt dev`. To try
// it: NUXT_PUBLIC_PWA_OFFLINE_ROUTES='["/pwa-example"]' and
// NUXT_PUBLIC_PWA_OFFLINE_API='["/api/pwa/example"]', load the page twice,
// then cut the network in DevTools.
//
// The three things an app's own page does: read with `useFetch` from a path
// listed in `offlineApi`, write with `useOutbox().send()`, and say what is
// still on the device.

definePageMeta({ middleware: 'auth' })

useSeo({
  title: 'Offline example',
  description: 'A page that opens without a network and keeps what you write until it can send it.',
  noindex: true,
})

const { user } = useUserSession()
// Signing out ends in `useUserSession().clear()`, which is what the layer's
// plugin watches for: the kept copies and the outbox go with it.
const { signOut, pending: signingOut } = useSignOut()
const toast = useToast()
const outbox = useOutbox()

const { data, refresh } = await useFetch('/api/pwa/example/notes')
const text = ref('')

const { pending, run: save } = useAsyncAction(
  async () => {
    const result = await outbox.send('/api/pwa/example/notes', { body: { text: text.value } })
    text.value = ''
    if (!result.queued) await refresh()
  },
  { errorTitle: 'Could not save the note' },
)

// A queued note reaches the server later, from here or from the worker.
watch(
  () => outbox.waiting.value.length,
  (now, before) => {
    if (now < before) void refresh().catch(() => {})
  },
)

async function discard(entry: (typeof outbox.failed.value)[number]) {
  await outbox.discard(entry)
  toast.add({ title: 'Note discarded' })
}
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-8 py-12">
    <div class="flex flex-col gap-2">
      <h1 class="text-3xl text-highlighted">Offline example</h1>
      <p class="text-muted">Signed in as {{ user?.email }}.</p>
      <div>
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :loading="signingOut"
          data-testid="pwa-example-sign-out"
          @click="signOut"
        >
          Sign out and clear this device
        </UButton>
      </div>
    </div>

    <form class="flex flex-col gap-3 sm:flex-row sm:items-end" @submit.prevent="save">
      <UFormField label="Note" class="flex-1">
        <UInput v-model="text" name="note" class="w-full" />
      </UFormField>
      <UButton type="submit" :loading="pending" :disabled="!text.trim()" class="min-touch">
        Save
      </UButton>
    </form>

    <p v-if="outbox.waiting.value.length" role="status" class="text-sm text-muted">
      {{ outbox.waiting.value.length }} saved on this device. They will send when you are back
      online.
    </p>

    <ul v-if="outbox.failed.value.length" class="flex flex-col gap-3" aria-label="Not saved">
      <li
        v-for="entry in outbox.failed.value"
        :key="entry.id"
        class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <p class="text-sm text-default">
          Not saved: {{ entry.error?.message || `the server answered ${entry.error?.status}` }}
        </p>
        <div class="flex gap-2">
          <UButton color="neutral" variant="outline" size="sm" @click="outbox.retry(entry)">
            Try again
          </UButton>
          <UButton color="neutral" variant="ghost" size="sm" @click="discard(entry)">
            Discard
          </UButton>
        </div>
      </li>
    </ul>

    <ul v-if="data?.notes.length" class="flex flex-col gap-2" aria-label="Notes">
      <li v-for="note in data.notes" :key="note.id" class="text-default">{{ note.text }}</li>
    </ul>
    <p v-else class="text-muted">No notes yet.</p>
  </div>
</template>
