<script setup lang="ts">
import { z } from 'zod'

// One customer record — the page a support conversation actually happens on.
//
// Everything on it comes from GET /api/admin/users/:id, which is audited as a
// single privileged read. The two things you can DO from here — grant comp
// access, and render a read-only view of what the customer sees — are audited
// separately, before they run.
//
// `middleware: 'auth'` is a UX guard only. requireAdmin() inside every endpoint
// is the boundary; a non-admin who reaches this URL gets the 403 state below.

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const toast = useToast()
const userId = computed(() => String(route.params.id))

const { data, error, status, refresh } = await useFetch(
  () => `/api/admin/users/${userId.value}`,
  { key: `admin-user-${route.params.id}` },
)

const forbidden = computed(() => error.value?.statusCode === 403)
const missing = computed(() => error.value?.statusCode === 404)

// ── Grant comp access ───────────────────────────────────────────────────────
// Denominated in whole passes, not days, because a comp is the same thing the
// customer would have bought — see server/utils/admin-grants.ts. The day count
// in the label comes from the plan we actually advertise on /pricing rather
// than a second copy of the number; the server's response reports the days it
// really granted, which is what the confirmation shows.
const MAX_PASSES = 12
const passPlan = PLANS.find((plan) => plan.id === 'pass')
const passDays = passPlan?.unit.code === 'DAY' ? passPlan.unit.value : null

const passOptions = Array.from({ length: MAX_PASSES }, (_, index) => {
  const passes = index + 1
  const noun = passes === 1 ? 'pass' : 'passes'
  return {
    label: passDays ? `${passes} ${noun} · ${passes * passDays} days` : `${passes} ${noun}`,
    value: passes,
  }
})

const grantSchema = z.object({
  passes: z.number().int().min(1).max(MAX_PASSES),
  // Required, and required for a reason: an entitlement with no explanation is
  // a row nobody can defend six months later.
  reason: z.string().trim().min(3, 'Say why — this is what the audit trail records').max(500),
})
const grant = reactive({ passes: 1, reason: '' })
const granting = ref(false)

async function submitGrant() {
  granting.value = true
  try {
    const result = await $fetch(`/api/admin/users/${userId.value}/grant`, {
      method: 'POST',
      body: { passes: grant.passes, reason: grant.reason },
    })
    grant.reason = ''
    grant.passes = 1
    toast.add({
      // "Extended" and "granted" are different facts, and telling a customer
      // the wrong one costs a second support round trip.
      title: result.stackedOn ? 'Access extended' : 'Access granted',
      description: `${result.days} days — access now ends ${formatDay(result.endsAt)}.`,
      color: 'success',
      icon: 'i-lucide-gift',
    })
    // Re-reads the record, which writes its own `admin.user_viewed` row. That
    // is accurate rather than noisy: the console did read it again.
    await refresh()
  } catch {
    toast.add({
      title: 'Could not grant access',
      description: 'Nothing changed on this account. Try again.',
      color: 'error',
    })
  } finally {
    granting.value = false
  }
}

// ── View as (read-only) ─────────────────────────────────────────────────────
// Not an impersonated session — see the long note at the top of
// server/api/admin/users/[id]/view-as.get.ts. This asks the server what the
// customer's own /api/billing/entitlement would return for them and renders it.
// Nothing here can write, because there is nothing to write with.
// The payload type is inferred from the route rather than restated here — a
// hand-written copy would let this panel and the endpoint disagree, which is
// the exact failure the shared entitlement view exists to prevent.
function fetchViewAs() {
  return $fetch(`/api/admin/users/${userId.value}/view-as`)
}

const viewAs = ref<Awaited<ReturnType<typeof fetchViewAs>> | null>(null)
const viewAsPending = ref(false)
const viewAsFailed = ref(false)

// Behind a button, not loaded with the page: rendering it writes an audit row,
// so it happens because someone asked for it.
async function loadViewAs() {
  viewAsPending.value = true
  viewAsFailed.value = false
  try {
    viewAs.value = await fetchViewAs()
  } catch {
    viewAsFailed.value = true
  } finally {
    viewAsPending.value = false
  }
}

const accessBadge = computed(() => {
  const billing = data.value?.billing
  if (!billing?.active) {
    return { label: 'no access', icon: 'i-lucide-circle-x', color: 'neutral' as const }
  }
  if (billing.status === 'trialing') {
    return { label: 'trialing', icon: 'i-lucide-circle-dashed', color: 'info' as const }
  }
  return { label: billing.status ?? 'active', icon: 'i-lucide-circle-check', color: 'success' as const }
})

/** Attribution columns, rendered only where there is something to render. */
const attribution = computed(() => {
  const user = data.value?.user
  if (!user) return []
  return [
    { label: 'Source', value: user.signupSource },
    { label: 'Medium', value: user.signupMedium },
    { label: 'Campaign', value: user.signupCampaign },
    { label: 'Referrer', value: user.signupReferrer },
    { label: 'Referred by', value: user.referredBy },
  ].filter((row) => Boolean(row.value))
})

useSeo({
  title: 'Customer record',
  description: 'Internal support view of one customer account, billing, and feedback.',
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-4xl flex-col gap-8 py-12">
    <ULink to="/admin" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-arrow-left" />
      Back to search
    </ULink>

    <UAlert
      v-if="forbidden"
      color="error"
      variant="subtle"
      icon="i-lucide-lock"
      title="You don't have access to the admin console"
      description="This area is limited to accounts with the admin role."
    />

    <UAlert
      v-else-if="missing"
      color="warning"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="No such customer"
      description="That account id doesn't exist. It may have been deleted."
    />

    <template v-else>
      <div v-if="status === 'pending'" class="flex flex-col gap-3">
        <USkeleton class="h-8 w-72" />
        <USkeleton class="h-4 w-48" />
      </div>

      <template v-else-if="data">
        <!-- Identity -->
        <div class="flex flex-wrap items-center gap-4">
          <UAvatar
            :src="data.user.avatarUrl ?? undefined"
            :alt="`${data.user.name}'s avatar`"
            size="lg"
          />
          <div class="min-w-0">
            <h1 class="truncate font-mono text-2xl text-highlighted">{{ data.user.email }}</h1>
            <p class="mt-1 text-muted">{{ data.user.name }}</p>
          </div>
          <div class="ml-auto flex flex-wrap gap-2">
            <UBadge v-if="data.user.role === 'admin'" color="warning" variant="subtle" icon="i-lucide-shield">
              admin
            </UBadge>
            <UBadge :color="accessBadge.color" variant="subtle" :icon="accessBadge.icon">
              {{ accessBadge.label }}
            </UBadge>
          </div>
        </div>

        <UCard>
          <template #header>
            <h2 class="text-xl text-highlighted">Account</h2>
          </template>

          <dl class="grid gap-4 sm:grid-cols-2">
            <div>
              <dt class="text-sm text-muted">Joined</dt>
              <dd class="font-mono text-default">{{ formatDay(data.user.createdAt) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Last sign-in</dt>
              <dd class="font-mono text-default">{{ formatDateTime(data.user.lastLoginAt) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Signed up with</dt>
              <dd class="text-default">{{ data.user.provider ?? 'unknown' }}</dd>
            </div>
            <div>
              <dt class="text-sm text-muted">Referral code</dt>
              <dd class="font-mono text-default">{{ data.user.referralCode ?? '—' }}</dd>
            </div>
          </dl>

          <template v-if="attribution.length" #footer>
            <div class="flex flex-col gap-2">
              <p class="text-sm text-muted">
                First-touch attribution, written once at signup and never overwritten.
              </p>
              <dl class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <div v-for="row in attribution" :key="row.label" class="flex gap-2">
                  <dt class="text-muted">{{ row.label }}</dt>
                  <dd class="font-mono text-default">{{ row.value }}</dd>
                </div>
              </dl>
            </div>
          </template>
        </UCard>

        <!-- Access + the apology grant -->
        <UCard>
          <template #header>
            <h2 class="text-xl text-highlighted">Access</h2>
          </template>

          <div class="flex flex-col gap-6">
            <dl class="grid gap-4 sm:grid-cols-2">
              <div>
                <dt class="text-sm text-muted">Currently</dt>
                <dd class="text-default">
                  {{
                    data.billing.active
                      ? data.billing.kind === 'pass'
                        ? 'Time-limited access — does not renew'
                        : 'Auto-renewing subscription'
                      : 'No active access'
                  }}
                  <UBadge
                    v-if="data.billing.comped"
                    class="ml-2"
                    color="info"
                    variant="subtle"
                    icon="i-lucide-gift"
                  >
                    comped
                  </UBadge>
                </dd>
              </div>
              <div>
                <dt class="text-sm text-muted">Ends</dt>
                <dd class="font-mono text-default">{{ formatDay(data.billing.currentPeriodEnd) }}</dd>
              </div>
            </dl>

            <UForm
              :schema="grantSchema"
              :state="grant"
              class="flex flex-col gap-4 border-t border-default pt-6"
              @submit="submitGrant"
            >
              <h3 class="text-lg text-highlighted">Grant comp access</h3>
              <p class="text-sm text-muted">
                Days stack on whatever this customer already has — nobody loses time they paid for.
                Each pass becomes its own line in their billing history, marked as a comp.
              </p>

              <UFormField label="How much" name="passes">
                <USelect v-model="grant.passes" :items="passOptions" class="w-full sm:w-72" />
              </UFormField>

              <UFormField
                label="Reason"
                name="reason"
                help="Recorded in the audit trail, alongside your account and the exact entitlements created."
              >
                <UTextarea
                  v-model="grant.reason"
                  :rows="2"
                  class="w-full"
                  placeholder="Outage on the 3rd — lost most of a day."
                />
              </UFormField>

              <UButton type="submit" class="self-start" :loading="granting" icon="i-lucide-gift">
                Grant comp access
              </UButton>
            </UForm>
          </div>
        </UCard>

        <!-- Billing history -->
        <UCard v-if="data.billing.history.length">
          <template #header>
            <h2 class="text-xl text-highlighted">Billing history</h2>
          </template>

          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <caption class="sr-only">
                Every entitlement ever written for this customer, newest first
              </caption>
              <thead>
                <tr class="border-b border-default text-left text-muted">
                  <th scope="col" class="py-2 pr-4 font-medium">Started</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Type</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Ref</th>
                  <th scope="col" class="py-2 text-right font-medium">Ends</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.billing.history" :key="row.ref" class="border-b border-default">
                  <td class="py-2 pr-4 font-mono text-default">{{ formatDay(row.purchasedAt) }}</td>
                  <td class="py-2 pr-4 text-default">
                    {{ row.kind === 'pass' ? 'Pass' : 'Subscription' }}
                    <UBadge
                      v-if="row.comped"
                      class="ml-2"
                      color="info"
                      variant="subtle"
                      icon="i-lucide-gift"
                    >
                      comp
                    </UBadge>
                  </td>
                  <td class="py-2 pr-4 text-muted">{{ row.status }}</td>
                  <td class="py-2 pr-4 font-mono text-xs text-dimmed">{{ row.ref }}</td>
                  <td class="py-2 text-right font-mono text-default">
                    {{ formatDay(row.currentPeriodEnd) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>

        <!-- View as -->
        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-eye" class="text-muted" />
              <h2 class="text-xl text-highlighted">View as this customer</h2>
            </div>
          </template>

          <div class="flex flex-col gap-4">
            <p class="text-muted">
              Resolves what their app would tell them right now, without signing in as them. No
              session is created and nothing here can write to their account.
            </p>

            <UButton
              class="self-start"
              color="neutral"
              variant="outline"
              icon="i-lucide-eye"
              :loading="viewAsPending"
              @click="loadViewAs"
            >
              {{ viewAs ? 'Refresh the view' : 'Load read-only view' }}
            </UButton>

            <UAlert
              v-if="viewAsFailed"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              title="Could not load that view"
              description="Try again. Nothing was changed on the customer's account."
            />

            <div v-if="viewAs" class="flex flex-col gap-4">
              <UAlert
                color="warning"
                variant="subtle"
                icon="i-lucide-eye"
                title="Read-only view"
                :description="`This is what ${viewAs.user.email} sees. It is a computed view, not their session — nothing on this panel can change their account.`"
              />

              <dl class="grid gap-4 border border-default p-4 sm:grid-cols-2">
                <div>
                  <dt class="text-sm text-muted">Their plan reads as</dt>
                  <dd class="text-default">
                    {{
                      viewAs.entitlement.active
                        ? viewAs.entitlement.kind === 'pass'
                          ? 'A one-time pass. It will not renew.'
                          : 'A subscription that renews automatically.'
                        : "You don't have an active plan."
                    }}
                  </dd>
                </div>
                <div>
                  <dt class="text-sm text-muted">
                    {{ viewAs.entitlement.kind === 'pass' ? 'Expires' : 'Renews' }}
                  </dt>
                  <dd class="font-mono text-default">
                    {{ formatDay(viewAs.entitlement.currentPeriodEnd) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-sm text-muted">Can they open /dashboard?</dt>
                  <dd>
                    <UBadge
                      :color="viewAs.dashboardReachable ? 'success' : 'error'"
                      variant="subtle"
                      :icon="viewAs.dashboardReachable ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                    >
                      {{ viewAs.dashboardReachable ? 'yes' : 'no — sent to /pricing' }}
                    </UBadge>
                  </dd>
                </div>
                <div>
                  <dt class="text-sm text-muted">Self-serve billing portal</dt>
                  <dd>
                    <UBadge
                      :color="viewAs.entitlement.portalAvailable ? 'success' : 'neutral'"
                      variant="subtle"
                      :icon="
                        viewAs.entitlement.portalAvailable
                          ? 'i-lucide-circle-check'
                          : 'i-lucide-circle-x'
                      "
                    >
                      {{ viewAs.entitlement.portalAvailable ? 'available' : 'unavailable' }}
                    </UBadge>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </UCard>

        <!-- Feedback -->
        <UCard>
          <template #header>
            <div class="flex items-center justify-between gap-3">
              <h2 class="text-xl text-highlighted">What they've told us</h2>
              <ULink to="/admin/feedback" class="text-sm text-primary underline underline-offset-2">
                Full queue
              </ULink>
            </div>
          </template>

          <p v-if="!data.feedback.length" class="text-muted">
            This customer hasn't sent any feedback.
          </p>

          <ul v-else class="flex flex-col divide-y divide-default">
            <li v-for="item in data.feedback" :key="item.id" class="flex flex-col gap-2 py-4 first:pt-0">
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
                <span class="font-mono text-sm text-muted">{{
                  formatDateTime(item.createdAt)
                }}</span>
              </div>
              <!-- Interpolated, never v-html: this is text anyone on the
                   internet can POST, and it is not markup or instructions. -->
              <p class="whitespace-pre-wrap text-default">{{ item.message }}</p>
            </li>
          </ul>
        </UCard>

        <!-- Audit trail -->
        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-history" class="text-muted" />
              <h2 class="text-xl text-highlighted">What we've done to this account</h2>
            </div>
          </template>

          <p v-if="!data.audit.length" class="text-muted">
            Nothing has been done to this account through the console.
          </p>

          <ul v-else class="flex flex-col divide-y divide-default">
            <li v-for="entry in data.audit" :key="entry.id" class="flex gap-3 py-3 first:pt-0">
              <UIcon :name="auditActionIcon(entry.action)" class="mt-1 shrink-0 text-muted" />
              <div class="min-w-0 flex-1">
                <p class="text-default">{{ auditActionLabel(entry.action) }}</p>
                <p class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
                  <span class="font-mono">{{ formatDateTime(entry.createdAt) }}</span>
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
              Append-only. Rows are written before the action they describe, so a grant that failed
              halfway still leaves a record of what was attempted.
            </p>
          </template>
        </UCard>
      </template>
    </template>
  </div>
</template>
