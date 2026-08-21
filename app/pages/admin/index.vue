<script setup lang="ts">
import { z } from 'zod'

// The support console's front door: find a customer, then open their record.
//
// Reachable by URL only — there is deliberately no nav link. Nothing here is
// useful to a customer, and a header entry that 403s for everyone but you is
// an invitation to go looking.
//
// `middleware: 'auth'` is UX, not security: it bounces signed-out visitors to
// /login instead of showing them an empty page. The real boundary is
// requireAdmin(event) inside every endpoint under /api/admin/ — a signed-in
// non-admin who types this URL gets 403s and the "no access" state below.

definePageMeta({ middleware: 'auth' })

const { user } = useUserSession()

// This doubles as the admin probe. It is the one request on the page that runs
// without being asked for, so its 403 is what tells a non-admin they're in the
// wrong place — before they type a customer's email into a box that will
// refuse it anyway.
const {
  data: audit,
  error: auditError,
  status: auditStatus,
  refresh: refreshAudit,
} = await useFetch('/api/admin/audit', { query: { limit: 20 } })

const forbidden = computed(() => auditError.value?.statusCode === 403)

// ── Search ──────────────────────────────────────────────────────────────────
// Email only — see the note in server/api/admin/users.get.ts. Two characters
// minimum, matching the server's schema, so the rejection happens here rather
// than as a 400 the user has to interpret.
const searchSchema = z.object({
  q: z.string().trim().min(2, 'Enter at least two characters of the address'),
})
const search = reactive({ q: '' })

const {
  data: results,
  status: searchStatus,
  error: searchError,
  execute: runSearch,
} = await useFetch('/api/admin/users', {
  query: computed(() => ({ q: search.q })),
  immediate: false,
  // Nothing refetches until the form is submitted: every search writes an audit
  // row, and a watcher on the input would record one per keystroke.
  watch: false,
})

async function submitSearch() {
  await runSearch()
  // The search itself is an audited action, so the trail below is stale the
  // moment it runs.
  await refreshAudit()
}

function clearSearch() {
  search.q = ''
  results.value = undefined
}

useSeo({
  title: 'Admin',
  description: 'Internal support console — find a customer and review their account.',
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-4xl flex-col gap-8 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Admin</h1>
      <p class="mt-2 text-muted">
        Support tools. Every search, record you open, and pass you grant is written to an
        append-only audit trail.
      </p>
    </div>

    <UAlert
      v-if="forbidden"
      color="error"
      variant="subtle"
      icon="i-lucide-lock"
      title="You don't have access to the admin console"
      description="This area is limited to accounts with the admin role. If you think that's wrong, ask whoever runs this deployment to grant it."
    />

    <template v-else>
      <!-- Find a customer -->
      <UCard>
        <template #header>
          <h2 class="text-xl text-highlighted">Find a customer</h2>
        </template>

        <UForm
          :schema="searchSchema"
          :state="search"
          class="flex flex-col gap-4"
          @submit="submitSearch"
        >
          <UFormField
            label="Email address"
            name="q"
            help="Full address or the start of one. Searching by name is deliberately not possible."
          >
            <!-- `type="text"`, deliberately, on a field that takes an email.
                 `type="email"` turns on native constraint validation, and the
                 browser then refuses to submit anything that isn't a complete
                 address — silently, with no error the app can render. That
                 kills prefix search, which is the whole point of the field.
                 `inputmode` still gets the right keyboard on a phone. -->
            <UInput
              v-model="search.q"
              type="text"
              inputmode="email"
              autocapitalize="off"
              autocomplete="off"
              spellcheck="false"
              placeholder="jane@example.com"
              icon="i-lucide-search"
              class="w-full"
            />
          </UFormField>

          <div class="flex flex-wrap gap-3">
            <UButton type="submit" :loading="searchStatus === 'pending'">Search</UButton>
            <UButton
              v-if="results"
              color="neutral"
              variant="ghost"
              type="button"
              @click="clearSearch"
            >
              Clear
            </UButton>
          </div>
        </UForm>
      </UCard>

      <UAlert
        v-if="searchError && !forbidden"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="That search didn't run"
        description="Check the address and try again. Nothing was recorded against the customer."
      />

      <!-- Results -->
      <UCard v-if="results">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-xl text-highlighted">
              {{ results.total === 1 ? '1 match' : `${results.total} matches` }}
            </h2>
            <UBadge
              v-if="results.capped"
              color="warning"
              variant="subtle"
              icon="i-lucide-circle-ellipsis"
            >
              capped — narrow the address
            </UBadge>
          </div>
        </template>

        <div v-if="!results.items.length" class="flex flex-col items-start gap-4">
          <p class="text-muted">No account matches that address.</p>
          <UButton color="neutral" variant="outline" @click="clearSearch">Search again</UButton>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <caption class="sr-only">
              Customer accounts matching the search, one per row
            </caption>
            <thead>
              <tr class="border-b border-default text-left text-muted">
                <th scope="col" class="py-2 pr-4 font-medium">Email</th>
                <th scope="col" class="py-2 pr-4 font-medium">Name</th>
                <th scope="col" class="py-2 pr-4 font-medium">Provider</th>
                <th scope="col" class="py-2 text-right font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in results.items" :key="item.id" class="border-b border-default">
                <td class="py-2 pr-4">
                  <!-- A real anchor, not a row click handler: it is keyboard
                       reachable, focusable, and middle-clickable for free. -->
                  <ULink
                    :to="`/admin/users/${item.id}`"
                    class="font-mono text-primary underline underline-offset-2"
                  >
                    {{ item.email }}
                  </ULink>
                </td>
                <td class="py-2 pr-4 text-default">{{ item.name }}</td>
                <td class="py-2 pr-4 text-muted">
                  {{ item.provider ?? '—' }}
                  <UBadge
                    v-if="item.role === 'admin'"
                    class="ml-2"
                    color="warning"
                    variant="subtle"
                    icon="i-lucide-shield"
                  >
                    admin
                  </UBadge>
                </td>
                <td class="py-2 text-right font-mono text-default">
                  {{ formatDay(item.createdAt) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>

      <!-- First-run state. One line, one action (DESIGN.md › Empty states). -->
      <UCard v-else>
        <div class="flex flex-col items-start gap-4">
          <p class="text-muted">Search by email address to open a customer record.</p>
          <UButton to="/admin/feedback" color="neutral" variant="outline" icon="i-lucide-inbox">
            Go to the feedback queue
          </UButton>
        </div>
      </UCard>

      <!-- Recent admin activity -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-history" class="text-muted" />
            <h2 class="text-xl text-highlighted">Recent admin activity</h2>
          </div>
        </template>

        <div v-if="auditStatus === 'pending'" class="flex flex-col gap-3">
          <USkeleton class="h-4 w-64" />
          <USkeleton class="h-4 w-48" />
        </div>

        <p v-else-if="!audit?.items.length" class="text-muted">
          Nothing has been done through this console yet.
        </p>

        <ul v-else class="flex flex-col divide-y divide-default">
          <li v-for="entry in audit.items" :key="entry.id" class="flex gap-3 py-3 first:pt-0">
            <UIcon :name="auditActionIcon(entry.action)" class="mt-1 shrink-0 text-muted" />
            <div class="min-w-0 flex-1">
              <p class="text-default">
                {{ auditActionLabel(entry.action) }}
                <span v-if="entry.actorUserId === user?.id" class="text-muted">· you</span>
              </p>
              <p class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
                <span class="font-mono">{{ formatDateTime(entry.createdAt) }}</span>
                <ULink
                  v-if="entry.targetType === 'user' && entry.targetId"
                  :to="`/admin/users/${entry.targetId}`"
                  class="font-mono text-primary underline underline-offset-2"
                >
                  {{ entry.metadata?.email ?? entry.targetId }}
                </ULink>
                <span
                  v-for="pair in metadataPairs(entry.metadata).filter((p) => p.key !== 'email')"
                  :key="pair.key"
                  class="font-mono"
                >
                  {{ pair.key }}: {{ pair.value }}
                </span>
              </p>
            </div>
          </li>
        </ul>

        <template #footer>
          <p class="text-sm text-muted">
            The audit log is append-only — rows are never edited or deleted by the app. Reading it
            is not itself recorded; acting on a customer always is.
          </p>
        </template>
      </UCard>
    </template>
  </div>
</template>
