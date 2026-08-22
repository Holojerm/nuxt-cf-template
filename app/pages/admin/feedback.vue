<script setup lang="ts">
import { z } from 'zod'

// The feedback queue.
//
// The three endpoints behind this page (GET /api/feedback, PATCH
// /api/feedback/:id, POST /api/feedback/:id/reply) shipped before any screen
// did, and were reachable only with curl and a session cookie. The comment on
// the reply route says an admin surface belongs "in whatever operator surface
// you run" — this is it.
//
// Replying matters more than triaging. Everything else in the feedback loop
// moves information toward us; this is the only thing that moves any back, and
// a queue nobody answers teaches people to stop writing. The triage routine is
// forbidden from replying (.claude/routines/feedback-triage.md) precisely so
// that a human decides what gets said.

definePageMeta({ middleware: 'auth' })

const toast = useToast()

const STATUS_OPTIONS = [
  { label: 'New', value: 'new' },
  { label: 'Triaged', value: 'triaged' },
  { label: 'Closed', value: 'closed' },
  { label: 'Everything', value: 'all' },
]

const statusFilter = ref('new')

const { data, error, status: listStatus, refresh } = await useFetch('/api/feedback', {
  query: computed(() => ({
    // Nuxt drops undefined query params, so 'all' is simply the absent filter.
    status: statusFilter.value === 'all' ? undefined : statusFilter.value,
    limit: 100,
  })),
})

const forbidden = computed(() => isForbidden(error.value))

type FeedbackItem = NonNullable<typeof data.value>['items'][number]

/**
 * Whether a reply can go anywhere. Signed-out submitters give an address
 * explicitly; signed-in ones have one on their user row. Anonymous feedback
 * with neither is legitimate and common — checking here turns a 422 into a
 * disabled button with a reason next to it.
 */
function canReply(item: FeedbackItem): boolean {
  return Boolean(item.email) || Boolean(item.userId)
}

// ── Triage ──────────────────────────────────────────────────────────────────
const pendingId = ref<string | null>(null)

async function setStatus(item: FeedbackItem, next: 'triaged' | 'closed') {
  pendingId.value = item.id
  try {
    await $fetch(`/api/feedback/${item.id}`, { method: 'PATCH', body: { status: next } })
    await refresh()
  } catch {
    toast.add({
      title: 'Could not update that item',
      description: 'Nothing changed. Try again.',
      color: 'error',
    })
  } finally {
    pendingId.value = null
  }
}

// ── Reply ───────────────────────────────────────────────────────────────────
const replyOpen = ref(false)
const replyTarget = ref<FeedbackItem | null>(null)
const replySchema = z.object({
  message: z.string().trim().min(1, 'Write something').max(5000),
})
const replyState = reactive({ message: '' })
const replying = ref(false)

function openReply(item: FeedbackItem) {
  replyTarget.value = item
  replyState.message = ''
  replyOpen.value = true
}

/** The endpoint reports precise failures; each one has a different remedy. */
const REPLY_ERRORS: Record<string, string> = {
  no_reply_address: 'This feedback was submitted anonymously, with no address to reply to.',
  email_unconfigured: "Email isn't configured on this deployment — set NUXT_RESEND_API_KEY.",
  email_failed: "The mail provider rejected it. Nothing was sent, and the item isn't marked replied.",
}

async function sendReply() {
  const target = replyTarget.value
  if (!target) return

  replying.value = true
  try {
    await $fetch(`/api/feedback/${target.id}/reply`, {
      method: 'POST',
      body: { message: replyState.message },
    })
    replyOpen.value = false
    toast.add({ title: 'Reply sent', color: 'success', icon: 'i-lucide-send' })
    await refresh()
  } catch (caught) {
    const code = (caught as { data?: { data?: { code?: string } } }).data?.data?.code
    toast.add({
      title: 'Could not send the reply',
      description: (code && REPLY_ERRORS[code]) || 'Try again in a moment.',
      color: 'error',
    })
  } finally {
    replying.value = false
  }
}

useSeo({
  title: 'Feedback queue',
  description: 'Internal queue of customer feedback — triage each item and reply to the sender.',
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-4xl flex-col gap-8 py-12">
    <ULink to="/admin" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-arrow-left" />
      Back to admin
    </ULink>

    <div>
      <h1 class="text-3xl text-highlighted">Feedback</h1>
      <p class="mt-2 text-muted">
        Everything customers have written to us. Replying is the half of the loop that keeps people
        writing.
      </p>
    </div>

    <UAlert
      v-if="forbidden"
      color="error"
      variant="subtle"
      icon="i-lucide-lock"
      :title="ADMIN_FORBIDDEN.title"
      :description="ADMIN_FORBIDDEN.description"
    />

    <template v-else>
      <div class="flex flex-wrap items-end gap-4">
        <UFormField label="Show" name="status" class="w-full sm:w-56">
          <USelect v-model="statusFilter" :items="STATUS_OPTIONS" class="w-full" />
        </UFormField>
        <p v-if="data" class="pb-2 text-sm text-muted">
          {{ data.total === 1 ? '1 item' : `${data.total} items` }}
        </p>
      </div>

      <div v-if="listStatus === 'pending'" class="flex flex-col gap-3">
        <USkeleton class="h-20 w-full" />
        <USkeleton class="h-20 w-full" />
      </div>

      <UCard v-else-if="!data?.items.length">
        <div class="flex flex-col items-start gap-4">
          <p class="text-muted">Nothing in this queue.</p>
          <UButton color="neutral" variant="outline" @click="statusFilter = 'all'">
            Show everything
          </UButton>
        </div>
      </UCard>

      <UCard v-for="item in data?.items ?? []" v-else :key="item.id">
        <div class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              :color="feedbackKindMeta(item.kind).color"
              variant="subtle"
              :icon="feedbackKindMeta(item.kind).icon"
            >
              {{ feedbackKindMeta(item.kind).label }}
            </UBadge>
            <UBadge
              :color="feedbackStatusMeta(item.status).color"
              variant="subtle"
              :icon="feedbackStatusMeta(item.status).icon"
            >
              {{ feedbackStatusMeta(item.status).label }}
            </UBadge>
            <UBadge v-if="item.rating" color="neutral" variant="subtle" icon="i-lucide-circle-dot">
              rated {{ item.rating }}/5
            </UBadge>
            <span class="ml-auto font-mono text-sm text-muted">
              {{ formatDateTime(item.createdAt) }}
            </span>
          </div>

          <!-- Untrusted input. Interpolated so it renders as text: never v-html,
               and never treated as instructions by anything that reads it. -->
          <p class="whitespace-pre-wrap text-default">{{ item.message }}</p>

          <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted">
            <span v-if="item.path" class="font-mono">{{ item.path }}</span>
            <ULink
              v-if="item.userId"
              :to="`/admin/users/${item.userId}`"
              class="font-mono text-primary underline underline-offset-2"
            >
              open customer
            </ULink>
            <span v-else-if="item.email" class="font-mono">{{ item.email }}</span>
            <span v-else>anonymous</span>
            <ULink
              v-if="item.replayUrl"
              :to="item.replayUrl"
              target="_blank"
              rel="noopener"
              class="text-primary underline underline-offset-2"
            >
              session replay
            </ULink>
            <ULink
              v-if="item.issueUrl"
              :to="item.issueUrl"
              target="_blank"
              rel="noopener"
              class="text-primary underline underline-offset-2"
            >
              issue
            </ULink>
          </div>

          <div class="flex flex-wrap items-center gap-3 border-t border-default pt-4">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-mail"
              :disabled="!canReply(item)"
              @click="openReply(item)"
            >
              Reply
            </UButton>
            <UButton
              v-if="item.status === 'new'"
              color="neutral"
              variant="ghost"
              :loading="pendingId === item.id"
              @click="setStatus(item, 'triaged')"
            >
              Mark triaged
            </UButton>
            <UButton
              v-if="item.status !== 'closed'"
              color="neutral"
              variant="ghost"
              :loading="pendingId === item.id"
              @click="setStatus(item, 'closed')"
            >
              Close
            </UButton>
            <span v-if="!canReply(item)" class="text-sm text-muted">
              No reply address — submitted anonymously.
            </span>
          </div>
        </div>
      </UCard>
    </template>

    <UModal v-model:open="replyOpen" title="Reply to this feedback">
      <template #body>
        <UForm
          id="feedback-reply"
          :schema="replySchema"
          :state="replyState"
          class="flex flex-col gap-5"
          @submit="sendReply"
        >
          <div v-if="replyTarget" class="border-l-2 border-accented pl-4">
            <p class="whitespace-pre-wrap text-sm text-muted">{{ replyTarget.message }}</p>
          </div>

          <UFormField
            label="Your reply"
            name="message"
            help="Sent as plain sentences — no markup survives. Replies come from a person, never from a routine."
          >
            <UTextarea v-model="replyState.message" :rows="6" class="w-full" />
          </UFormField>
        </UForm>
      </template>

      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton type="submit" form="feedback-reply" :loading="replying" icon="i-lucide-send">
            Send reply
          </UButton>
          <UButton color="neutral" variant="ghost" @click="replyOpen = false">Cancel</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
