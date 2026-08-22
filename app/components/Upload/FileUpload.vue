<script setup lang="ts">
// Pick and upload a single file into the caller's own R2 prefix
// (POST /api/files). Mounted on app/pages/files.vue, which owns the list
// this appends to.
//
// The type/size check below is a courtesy that saves a round trip on an
// obviously-wrong file — it is NOT the boundary. The server re-validates
// every one of these with ensureBlob() regardless of what a modified client
// sends (server/api/files/index.post.ts), against the exact same
// MAX_FILE_SIZE_BYTES / ALLOWED_FILE_TYPES this component reads from
// #shared/utils/files, so the two can never disagree about what gets
// rejected.
//
// FileView type import is explicit (app/composables/useSeo.ts and
// app/utils/faq.ts do the same for shared/utils/schema.ts's types) — the
// constants and functions below are left to Nuxt's auto-import, same as
// MAX_COMP_PASSES on app/pages/admin/users/[id].vue.
import type { FileView } from '#shared/utils/files'

const emit = defineEmits<{
  uploaded: [file: FileView]
}>()

const toast = useToast()
const selected = ref<File | null>(null)
const pending = ref(false)

const sizeLimitLabel = formatFileSize(MAX_FILE_SIZE_BYTES)

/** Null when the file is fine to send; otherwise the message to show. */
function precheckError(file: File): string | null {
  if (!isAllowedFileType(file.type)) {
    return 'That file type isn’t supported — upload a JPEG, PNG, WebP, or PDF.'
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `That file is too large — the limit is ${sizeLimitLabel}.`
  }
  return null
}

// UFileUpload's v-model fires on pick/drop; a rejected file is cleared
// immediately so the "Upload" button never offers to send it.
watch(selected, (file) => {
  if (!file) return
  const rejection = precheckError(file)
  if (rejection) {
    toast.add({ title: rejection, color: 'error', icon: 'i-lucide-triangle-alert' })
    selected.value = null
  }
})

async function upload() {
  const file = selected.value
  if (!file) return

  pending.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const uploaded = await $fetch<FileView>('/api/files', { method: 'POST', body })
    selected.value = null
    emit('uploaded', uploaded)
    toast.add({
      title: 'Uploaded',
      description: uploaded.filename,
      color: 'success',
      icon: 'i-lucide-check',
    })
  } catch (err) {
    const failure = err as { data?: { message?: string }; statusMessage?: string }
    toast.add({
      title: 'Upload failed',
      description:
        failure.data?.message ?? failure.statusMessage ?? 'Something went wrong — try again.',
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFileUpload
      v-model="selected"
      :accept="ALLOWED_FILE_TYPES_ACCEPT"
      icon="i-lucide-upload"
      label="Drop a file here, or click to browse"
      :description="`JPEG, PNG, WebP, or PDF — up to ${sizeLimitLabel}`"
      class="w-full min-h-48"
    />

    <div class="flex justify-end">
      <UButton
        label="Upload"
        icon="i-lucide-upload-cloud"
        :loading="pending"
        :disabled="!selected"
        @click="upload"
      />
    </div>
  </div>
</template>
