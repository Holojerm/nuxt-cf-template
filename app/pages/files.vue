<script setup lang="ts">
// The upload feature's own page — everything a paying customer needs to
// manage the files they've stored in their own R2 prefix.
//
// Both middlewares are the UX guard, not the boundary, same as
// app/pages/dashboard.vue: `auth` bounces a signed-out visitor to /login,
// `subscription` bounces a signed-in one without an entitlement to
// /pricing. The real check is `requireSubscription(event)` inside every
// server/api/files/*.ts route — delete the client middleware and this page
// still can't list, upload, or download anything; delete the server check
// and it can.

import type { FileView } from '#shared/utils/files'

definePageMeta({ middleware: ['auth', 'subscription'] })

interface FilesResponse {
  files: FileView[]
  nextCursor: string | null
}

const toast = useToast()
const { data, status, refresh } = await useFetch<FilesResponse>('/api/files')

const files = computed(() => data.value?.files ?? [])

function handleUploaded() {
  // Simplest correct thing: re-fetch rather than splice the new row into
  // local state by hand. A page that lists at most a couple of pages of
  // files does not need to optimize this round trip away, and refetching
  // is what keeps the list's ordering and cursor logic in exactly one
  // place (server/utils/files.ts › listFiles()).
  void refresh()
}

// ── Delete, with a confirm step ─────────────────────────────────────────────
const deleteTarget = ref<FileView | null>(null)
const deletePending = ref(false)

function confirmDelete(file: FileView) {
  deleteTarget.value = file
}

/** Lets <UModal> use its usual v-model:open while this page keeps tracking
 *  which file the confirm is about, not just whether it's showing. */
const isDeleteModalOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open: boolean) => {
    if (!open) deleteTarget.value = null
  },
})

async function doDelete() {
  const file = deleteTarget.value
  if (!file) return

  deletePending.value = true
  try {
    await $fetch(`/api/files/${file.id}`, { method: 'DELETE' })
    deleteTarget.value = null
    await refresh()
    toast.add({
      title: 'Deleted',
      description: file.filename,
      color: 'success',
      icon: 'i-lucide-check',
    })
  } catch (err) {
    const failure = err as { data?: { message?: string }; statusMessage?: string }
    toast.add({
      title: 'Could not delete that file',
      description: failure.data?.message ?? failure.statusMessage ?? 'Try again.',
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
  } finally {
    deletePending.value = false
  }
}

/** Icon + word for status — DESIGN.md › Accessibility: never color alone. */
function statusBadge(file: FileView): {
  color: 'success' | 'neutral'
  icon: string
  label: string
} {
  return file.status === 'uploaded'
    ? { color: 'success', icon: 'i-lucide-check', label: 'Uploaded' }
    : { color: 'neutral', icon: 'i-lucide-loader', label: 'Pending' }
}

function formattedDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

useSeo({
  title: 'Files',
  description: 'Upload, download, and manage the files stored on your account.',
  noindex: true,
})
</script>

<template>
  <div class="flex flex-col gap-8 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Files</h1>
      <p class="mt-2 text-muted">
        Uploads are private to your account — JPEG, PNG, WebP, and PDF, up to
        {{ formatFileSize(MAX_FILE_SIZE_BYTES) }} each.
      </p>
    </div>

    <UCard>
      <template #header>
        <h2 class="text-xl text-highlighted">Upload a file</h2>
      </template>
      <UploadFileUpload @uploaded="handleUploaded" />
    </UCard>

    <div>
      <h2 class="mb-4 text-xl text-highlighted">Your files</h2>

      <!-- Skeletons over spinners for loads above 300ms — DESIGN.md › Motion. -->
      <div v-if="status === 'pending'" class="flex flex-col gap-2">
        <USkeleton class="h-12 w-full" />
        <USkeleton class="h-12 w-full" />
        <USkeleton class="h-12 w-full" />
      </div>

      <!-- One text-muted line, no separate action here — the uploader above
           is already the page's one primary action, and DESIGN.md's "one
           primary button per view" rule is why a second one doesn't belong
           in this empty state too. -->
      <p v-else-if="files.length === 0" class="text-muted">You haven't uploaded anything yet.</p>

      <div v-else class="overflow-x-auto rounded-lg border border-default">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-default text-left text-muted">
              <th scope="col" class="px-4 py-3 font-medium">Name</th>
              <th scope="col" class="px-4 py-3 font-medium">Status</th>
              <th scope="col" class="px-4 py-3 text-right font-medium">Size</th>
              <th scope="col" class="px-4 py-3 font-medium">Uploaded</th>
              <th scope="col" class="px-4 py-3">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="file in files" :key="file.id">
              <td class="px-4 py-3 text-default">
                <a
                  v-if="file.status === 'uploaded'"
                  :href="`/api/files/${file.id}`"
                  target="_blank"
                  rel="noopener"
                  class="text-primary underline underline-offset-2"
                >
                  {{ file.filename }}
                </a>
                <span v-else>{{ file.filename }}</span>
              </td>
              <td class="px-4 py-3">
                <UBadge
                  :color="statusBadge(file).color"
                  :icon="statusBadge(file).icon"
                  variant="subtle"
                >
                  {{ statusBadge(file).label }}
                </UBadge>
              </td>
              <td class="px-4 py-3 text-right font-mono text-muted">
                {{ formatFileSize(file.sizeBytes) }}
              </td>
              <td class="px-4 py-3 text-muted">{{ formattedDate(file.createdAt) }}</td>
              <td class="px-4 py-3 text-right">
                <UButton
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="ghost"
                  size="sm"
                  class="min-touch"
                  :aria-label="`Delete ${file.filename}`"
                  @click="confirmDelete(file)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <UModal
      v-model:open="isDeleteModalOpen"
      title="Delete this file?"
      :description="
        deleteTarget ? `${deleteTarget.filename} will be gone for good — this can't be undone.` : ''
      "
    >
      <template #body>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="Cancel"
            :disabled="deletePending"
            @click="deleteTarget = null"
          />
          <UButton color="error" label="Delete" :loading="deletePending" @click="doDelete" />
        </div>
      </template>
    </UModal>
  </div>
</template>
