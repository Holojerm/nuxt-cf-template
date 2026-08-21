<script setup lang="ts">
// Everything a customer needs to do to themselves, in one page: see what they're
// paying for, change or cancel it, connect the MCP worker, sign out.
//
// The cancellation path is deliberately prominent. Making people email support
// to stop paying is a dark pattern, it generates the support load you least want,
// and in several jurisdictions it isn't legal. One button, straight to Paddle.
//
// The one thing between that button and Paddle is a question, never an obstacle:
// cancelling happens on Paddle's hosted portal, a different origin where no
// survey of ours can run, so this is the only moment the reason can be asked at
// all. The prompt's primary button leaves whether or not anything is answered,
// and no retention offer is inserted — see app/utils/churn.ts.

definePageMeta({ middleware: 'auth' })

const { user, clear: clearSession } = useUserSession()
const toast = useToast()

const { data: billing, status } = await useFetch('/api/billing/entitlement')

const portalPending = ref(false)

// ── Cancellation prompt ─────────────────────────────────────────────────────
const cancelOpen = ref(false)
// `undefined`, not `null`: URadioGroup's modelValue is `T | undefined`.
const cancelReason = ref<string | undefined>()
const cancelDetail = ref('')
const cancelReasons = CANCEL_REASONS
const { submit: submitFeedback } = useFeedback()

/**
 * "Manage or cancel" on a live subscription asks why first. "Manage billing"
 * (no cancellable subscription) goes straight through — someone updating a card
 * has not told us they're leaving, and asking would be noise.
 */
function requestPortal(): void {
  if (billing.value?.cancellable) {
    cancelOpen.value = true
    return
  }
  void openBillingPortal()
}

async function continueToPortal(): Promise<void> {
  // Awaited, not floated: the very next thing this function does is navigate
  // to another origin, which cancels in-flight requests. submit() swallows its
  // own errors and returns a boolean, so a failed write costs a few hundred
  // milliseconds and never blocks the cancellation.
  if (cancelReason.value) {
    await submitFeedback({
      kind: 'churn',
      message: cancelFeedbackMessage(cancelReason.value, cancelDetail.value),
    })
  }
  cancelOpen.value = false
  await openBillingPortal()
}

async function openBillingPortal(): Promise<void> {
  portalPending.value = true
  try {
    const links = await $fetch('/api/billing/portal', { method: 'POST' })
    // Deep-link straight to cancel when Paddle gave us one — the person who
    // clicked "Manage or cancel" on a live subscription usually means cancel,
    // and burying it one screen deeper is the pattern this page exists to avoid.
    const target = links.cancelUrl || links.overviewUrl
    if (!target) throw new Error('No portal URL returned')
    await navigateTo(target, { external: true })
    return
  } catch (error) {
    const code = (error as { data?: { data?: { code?: string } } }).data?.data?.code
    toast.add({
      title: 'Could not open the billing portal',
      description:
        code === 'portal_unconfigured'
          ? 'NUXT_PADDLE_API_KEY is not set on the server.'
          : "Reply to your Paddle receipt email and we'll cancel it for you.",
      color: 'error',
    })
  } finally {
    portalPending.value = false
  }
}

// ── MCP connect code ────────────────────────────────────────────────────────
// Single-use, 10-minute code that bridges this session to the MCP worker's
// OAuth flow. Shown once — only its hash is stored (server/api/mcp/connect-code).
const connectCode = ref<string | null>(null)
const connectPending = ref(false)

async function mintConnectCode() {
  connectPending.value = true
  try {
    const result = await $fetch('/api/mcp/connect-code', { method: 'POST' })
    connectCode.value = result.code
  } catch {
    toast.add({ title: 'Could not create a connect code', color: 'error' })
  } finally {
    connectPending.value = false
  }
}

async function signOut() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clearSession()
  await navigateTo('/')
}

const statusColor = computed(() => {
  if (!billing.value?.active) return 'neutral'
  return billing.value.status === 'trialing' ? 'info' : 'success'
})

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

useSeo({
  title: 'Account',
  description: 'Your plan, billing history, and account settings.',
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-8 py-12">
    <h1 class="text-3xl text-highlighted">Account</h1>

    <!-- Identity -->
    <UCard>
      <div class="flex items-center gap-4">
        <UAvatar :src="user?.avatarUrl ?? undefined" :alt="user?.name" size="lg" />
        <div class="min-w-0">
          <p class="truncate font-medium text-highlighted">{{ user?.name }}</p>
          <p class="truncate text-sm text-muted">{{ user?.email }}</p>
        </div>
        <UButton class="ml-auto" color="neutral" variant="outline" @click="signOut">
          Sign out
        </UButton>
      </div>
    </UCard>

    <!-- Plan -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-xl text-highlighted">Plan</h2>
          <UBadge v-if="status !== 'pending'" :color="statusColor" variant="subtle">
            {{ billing?.active ? (billing.status ?? 'active') : 'no active plan' }}
          </UBadge>
        </div>
      </template>

      <div v-if="status === 'pending'" class="flex flex-col gap-3">
        <USkeleton class="h-4 w-48" />
        <USkeleton class="h-4 w-64" />
      </div>

      <div v-else-if="billing?.active" class="flex flex-col gap-4">
        <p class="text-default">
          {{
            billing.kind === 'pass'
              ? 'You have a one-time pass. It will not renew.'
              : 'Your subscription renews automatically.'
          }}
        </p>
        <dl class="grid gap-4 sm:grid-cols-2">
          <div>
            <dt class="text-sm text-muted">Type</dt>
            <dd class="text-default">
              {{ billing.kind === 'pass' ? 'One-time pass' : 'Subscription' }}
            </dd>
          </div>
          <div>
            <dt class="text-sm text-muted">
              {{ billing.kind === 'pass' ? 'Expires' : 'Renews' }}
            </dt>
            <dd class="font-mono text-default">{{ formatDate(billing.currentPeriodEnd) }}</dd>
          </div>
        </dl>

        <div class="flex flex-wrap gap-3">
          <UButton
            v-if="billing.portalAvailable"
            :loading="portalPending"
            color="neutral"
            variant="outline"
            icon="i-lucide-external-link"
            @click="requestPortal"
          >
            {{ billing.cancellable ? 'Manage or cancel' : 'Manage billing' }}
          </UButton>
          <UButton to="/pricing" variant="ghost" color="neutral">See all plans</UButton>
        </div>

        <p v-if="!billing.portalAvailable" class="text-sm text-muted">
          The self-serve billing portal isn't configured on this deployment. To cancel, reply to
          your Paddle receipt email — we'll action it the same day.
        </p>
      </div>

      <div v-else class="flex flex-col items-start gap-4">
        <p class="text-muted">You don't have an active plan.</p>
        <UButton to="/pricing">See plans</UButton>
      </div>
    </UCard>

    <!-- History -->
    <UCard v-if="billing?.history?.length">
      <template #header>
        <h2 class="text-xl text-highlighted">Billing history</h2>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-default text-left text-muted">
              <th class="py-2 pr-4 font-medium">Purchased</th>
              <th class="py-2 pr-4 font-medium">Type</th>
              <th class="py-2 pr-4 font-medium">Status</th>
              <th class="py-2 text-right font-medium">Ends</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in billing.history" :key="item.ref" class="border-b border-default">
              <td class="py-2 pr-4 font-mono text-default">{{ formatDate(item.purchasedAt) }}</td>
              <td class="py-2 pr-4 text-default">
                {{ item.kind === 'pass' ? 'Pass' : 'Subscription' }}
              </td>
              <td class="py-2 pr-4 text-muted">{{ item.status }}</td>
              <td class="py-2 text-right font-mono text-default">
                {{ formatDate(item.currentPeriodEnd) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template #footer>
        <p class="text-sm text-muted">
          Invoices and receipts come from Paddle, our merchant of record.
        </p>
      </template>
    </UCard>

    <!-- MCP -->
    <UCard>
      <template #header>
        <h2 class="text-xl text-highlighted">Connect an AI client</h2>
      </template>

      <div class="flex flex-col gap-4">
        <p class="text-muted">
          Generate a single-use code to link this account to the MCP server from Claude, Cursor, or
          any MCP-capable client. Codes expire after 10 minutes.
        </p>

        <UAlert
          v-if="connectCode"
          color="success"
          variant="subtle"
          icon="i-lucide-key-round"
          title="Your connect code"
        >
          <template #description>
            <span class="font-mono text-lg tracking-widest text-highlighted">{{
              connectCode
            }}</span>
            <p class="mt-2 text-sm">Paste it into the client's authorization page. Shown once.</p>
          </template>
        </UAlert>

        <UButton
          class="self-start"
          color="neutral"
          variant="outline"
          :loading="connectPending"
          @click="mintConnectCode"
        >
          {{ connectCode ? 'Generate another' : 'Generate code' }}
        </UButton>
      </div>
    </UCard>

    <div class="text-sm text-muted">
      <p>
        Need your data deleted? Reply to any email from us and we'll remove the account and
        everything attached to it — see the
        <ULink to="/privacy" class="text-primary">Privacy Policy</ULink>.
      </p>
    </div>

    <!-- Cancellation prompt. Every control here leads out; there is no path
         that keeps someone subscribed against their intent. -->
    <UModal v-model:open="cancelOpen" title="Before you go">
      <template #body>
        <div class="flex flex-col gap-5">
          <p class="text-muted">
            What's making you cancel? Answering is optional and changes nothing about your
            cancellation — it just tells us what to fix.
          </p>

          <URadioGroup
            v-model="cancelReason"
            legend="Reason for cancelling"
            :items="cancelReasons"
          />

          <UFormField label="Anything else?" name="cancel-detail">
            <UTextarea
              v-model="cancelDetail"
              :rows="3"
              class="w-full"
              placeholder="Optional — the more specific, the more useful."
            />
          </UFormField>
        </div>
      </template>

      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton :loading="portalPending" @click="continueToPortal"> Continue to cancel </UButton>
          <UButton color="neutral" variant="ghost" @click="cancelOpen = false">
            Never mind
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
