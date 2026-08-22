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

const { data, error, status, refresh } = await useFetch(() => `/api/admin/users/${userId.value}`, {
  key: `admin-user-${route.params.id}`,
})

const forbidden = computed(() => isForbidden(error.value))
const missing = computed(() => error.value?.statusCode === 404)

// ── Grant comp access ───────────────────────────────────────────────────────
// Denominated in whole passes, not days, because a comp is the same thing the
// customer would have bought — see server/utils/admin-grants.ts. The day count
// in the label comes from the plan we actually advertise on /pricing rather
// than a second copy of the number; the server's response reports the days it
// really granted, which is what the confirmation shows.
// MAX_COMP_PASSES comes from #shared/utils/comps — the same constant the
// endpoint validates against. It used to be re-typed here as `MAX_PASSES = 12`,
// which fails silently in both directions: raise one and the form offers an
// option the API rejects, lower one and an option vanishes with no error.
const passPlan = PLANS.find((plan) => plan.id === 'pass')
const passDays = passPlan?.unit.code === 'DAY' ? passPlan.unit.value : null

const passOptions = Array.from({ length: MAX_COMP_PASSES }, (_, index) => {
  const passes = index + 1
  const noun = passes === 1 ? 'pass' : 'passes'
  return {
    label: passDays ? `${passes} ${noun} · ${passes * passDays} days` : `${passes} ${noun}`,
    value: passes,
  }
})

const grantSchema = z.object({
  passes: z.number().int().min(1).max(MAX_COMP_PASSES),
  // Required, and required for a reason: an entitlement with no explanation is
  // a row nobody can defend six months later.
  reason: z.string().trim().min(3, 'Say why — this is what the audit trail records').max(500),
})
const grant = reactive({ passes: 1, reason: '' })
const granting = ref(false)

/**
 * A comp to a live subscriber delivers no days at all — the stacked window is
 * exactly what their next payment buys. The server refuses it (409); the form
 * is hidden so nobody composes a reason for an action that cannot happen.
 * `cancellable` is the count of live auto-renewing subscriptions.
 */
const hasLiveSubscription = computed(() => (data.value?.billing.cancellable ?? 0) > 0)

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
  } catch (caught) {
    const code = (caught as { data?: { data?: { code?: string } } }).data?.data?.code
    toast.add({
      title: code === 'active_subscription' ? 'Not the right tool here' : 'Could not grant access',
      description:
        code === 'active_subscription'
          ? 'This customer has an active subscription, so comp days would be swallowed by the paid period. Issue a Paddle credit against their next invoice instead.'
          : 'The grant did not complete. Check the billing history below before retrying.',
      color: code === 'active_subscription' ? 'warning' : 'error',
    })
    // Refresh even on failure. The old copy asserted "Nothing changed on this
    // account" from a bare catch, which it could not know — and while the grant
    // looped N un-batched inserts it was routinely false. The write is atomic
    // now, but a stale screen after an error is still how an operator retries
    // something that already landed.
    await refresh()
  } finally {
    granting.value = false
  }
}

// ── Revoke a comp ───────────────────────────────────────────────────────────
// The inverse of the grant above, and the reason the grant is safe to offer at
// all: before this existed, twelve passes granted by mistake could only be
// undone with hand-written SQL against production.
//
// Behind a confirmation with a mandatory reason, for the same reason the grant
// is: access vanishing from an account is exactly what generates a support call
// months later, and the answer needs to be written down before it happens.
type BillingHistoryRow = NonNullable<typeof data.value>['billing']['history'][number]

/**
 * Is there anything left to take back?
 *
 * Status AND window. Nothing flips a comp's status when its period closes, so
 * an expired comp still reads `status: 'active'` — a status-only check rendered
 * a Revoke button on grants that ran out months ago, and clicking it dragged a
 * long-past end date forward to today. The server refuses that too (409
 * `already_expired`); this keeps the button from appearing at all.
 */
function isRevocable(row: BillingHistoryRow): boolean {
  const granting = row.status === 'active' || row.status === 'trialing'
  if (!granting) return false
  return row.currentPeriodEnd !== null && new Date(row.currentPeriodEnd) > new Date()
}

const revokeOpen = ref(false)
const revokeTarget = ref<BillingHistoryRow | null>(null)
const revokeSchema = z.object({
  reason: z.string().trim().min(3, 'Say why — this is what the audit trail records').max(500),
})
const revokeState = reactive({ reason: '' })
const revoking = ref(false)

function openRevoke(row: BillingHistoryRow) {
  revokeTarget.value = row
  revokeState.reason = ''
  revokeOpen.value = true
}

async function submitRevoke() {
  const target = revokeTarget.value
  if (!target) return

  revoking.value = true
  try {
    const result = await $fetch(`/api/admin/users/${userId.value}/revoke`, {
      method: 'POST',
      body: { ref: target.ref, reason: revokeState.reason },
    })
    revokeOpen.value = false
    toast.add({
      title: result.outcome === 'already_revoked' ? 'Already revoked' : 'Comp revoked',
      // What the customer has LEFT is the line support reads out loud, and it
      // is not derivable from the row that was just revoked.
      description: result.remainingEndsAt
        ? `They still have access until ${formatDay(result.remainingEndsAt)}.`
        : 'They now have no active access.',
      color: 'success',
      icon: 'i-lucide-circle-check',
    })
    await refresh()
  } catch (caught) {
    const code = (caught as { data?: { data?: { code?: string } } }).data?.data?.code
    toast.add({
      title: 'Could not revoke that',
      description:
        code === 'not_comp'
          ? 'Only comped access can be revoked here. Refunds and cancellations go through Paddle.'
          : code === 'already_expired'
            ? 'That comp had already run out on its own, so there was nothing left to revoke.'
            : 'The revoke did not complete. Check the billing history below before retrying.',
      color: 'error',
    })
    // Refresh on failure too — never leave the operator looking at a stale
    // table after an error, which is how the same action gets retried twice.
    await refresh()
  } finally {
    revoking.value = false
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

// Switched on `state`, the same field /account branches on — not on
// `active`/`status`, which cannot tell a lapsed customer from one whose card
// just failed. Reading "no access" here while the customer reads "payment
// failed" on their own screen is the precise drift entitlement-view.ts exists
// to prevent, and it costs a support person the first five minutes of the call.
// Shared with /account's own badge (app/utils/admin.ts › billingStateMeta), so
// a support person and the customer cannot be looking at two different words
// for one state — which they were, on two of the four states.
const accessBadge = computed(() => billingStateMeta(data.value?.billing.state))

/**
 * The sentence the customer's own /account renders right now. A support person
 * reads this line out loud, so it has to be the customer's wording rather than
 * a near-copy — see app/pages/account.vue and app/components/Billing/.
 */
const planReadsAs = computed(() => {
  const entitlement = viewAs.value?.entitlement
  if (!entitlement) return ''
  if (entitlement.state === 'past_due') {
    return 'Their last payment did not go through. The subscription is paused while Paddle retries the card.'
  }
  if (!entitlement.active) return "You don't have an active plan."
  return entitlement.kind === 'pass'
    ? 'A one-time pass. It will not renew.'
    : 'A subscription that renews automatically.'
})

/**
 * Why the subscription gate resolves the way it does — the entire question this
 * panel gets opened to answer. `active` alone says whether they get in; it does
 * not say whether anyone can do anything about it, and "payment failed, Paddle
 * is retrying" is a different support conversation from "they never subscribed".
 */
const subscriptionGate = computed(() => {
  const entitlement = viewAs.value?.entitlement
  if (!entitlement) return null
  if (entitlement.active) return 'subscription gate: passes'
  if (entitlement.state === 'past_due') {
    return 'subscription gate: fails — payment failed, Paddle is retrying'
  }
  return 'subscription gate: fails — no active plan'
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

    <!-- Identity, and the page's only level-1 heading.
         Hoisted above every conditional below on purpose: when it lived inside
         the `data` branch, the 403, 404, and loading states rendered a page
         with no level-1 heading at all — an axe `page-has-heading-one` failure
         and, more to the point, a screen reader landing on a document that
         never says what it is. The subject's address is the heading once it
         loads; before that the heading still exists and names the page.
         (Keep the tag name out of this comment — seo:check counts heading tags
         in raw template text, HTML comments included.) -->
    <div class="flex flex-wrap items-center gap-4">
      <UAvatar
        v-if="data"
        :src="data.user.avatarUrl ?? undefined"
        :alt="`${data.user.name}'s avatar`"
        size="lg"
      />
      <div class="min-w-0">
        <h1 class="truncate text-2xl text-highlighted" :class="{ 'font-mono': data }">
          {{ data?.user.email ?? 'Customer record' }}
        </h1>
        <p v-if="data" class="mt-1 text-muted">{{ data.user.name }}</p>
      </div>
      <div v-if="data" class="ml-auto flex flex-wrap gap-2">
        <UBadge
          v-if="data.user.role === 'admin'"
          color="warning"
          variant="subtle"
          icon="i-lucide-shield"
        >
          admin
        </UBadge>
        <UBadge :color="accessBadge.color" variant="subtle" :icon="accessBadge.icon">
          {{ accessBadge.label }}
        </UBadge>
      </div>
    </div>

    <UAlert
      v-if="forbidden"
      color="error"
      variant="subtle"
      icon="i-lucide-lock"
      :title="ADMIN_FORBIDDEN.title"
      :description="ADMIN_FORBIDDEN.description"
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
        <USkeleton class="h-4 w-64" />
        <USkeleton class="h-4 w-48" />
      </div>

      <template v-else-if="data">
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
                <dd class="font-mono text-default">
                  {{ formatDay(data.billing.currentPeriodEnd) }}
                </dd>
              </div>
            </dl>

            <div
              v-if="hasLiveSubscription"
              class="flex flex-col gap-3 border-t border-default pt-6"
            >
              <h3 class="text-lg text-highlighted">Grant comp access</h3>
              <UAlert
                color="info"
                variant="subtle"
                icon="i-lucide-circle-alert"
                title="Not available for an active subscriber"
                description="Comp days stack from the renewal date, so the customer's next payment covers the same window and they gain nothing. To compensate a subscriber, issue a credit or discount against their next invoice in Paddle — that gives money back rather than time they already have."
              />
            </div>

            <UForm
              v-else
              :schema="grantSchema"
              :state="grant"
              class="flex flex-col gap-4 border-t border-default pt-6"
              @submit="submitGrant"
            >
              <h3 class="text-lg text-highlighted">Grant comp access</h3>
              <p class="text-sm text-muted">
                Days stack on whatever this customer already has — nobody loses time they paid for.
                Each pass becomes its own line in their billing history, marked as a comp, and can
                be revoked there individually.
              </p>
              <p class="text-sm text-muted">
                The cap below applies to one grant, not to the account: repeat grants keep stacking.
                Every one is on the audit trail with the reason you give.
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
                  <th scope="col" class="py-2 pr-4 text-right font-medium">Ends</th>
                  <th scope="col" class="py-2 text-right font-medium">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in data.billing.history"
                  :key="row.ref"
                  class="border-b border-default"
                >
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
                    <!-- Referral days are also a pass nobody was charged for,
                         and without this the Type column says "Pass" while the
                         ref column beside it says `referral_…` — support
                         reading the first one would go looking for a payment
                         that never existed. Not revocable: revokeCompPass
                         refuses anything that isn't a `comp_` ref. -->
                    <UBadge
                      v-else-if="row.referral"
                      class="ml-2"
                      color="info"
                      variant="subtle"
                      icon="i-lucide-users"
                    >
                      referral
                    </UBadge>
                  </td>
                  <td class="py-2 pr-4 text-muted">{{ row.status }}</td>
                  <td class="py-2 pr-4 font-mono text-xs text-dimmed">{{ row.ref }}</td>
                  <td class="py-2 pr-4 text-right font-mono text-default">
                    {{ formatDay(row.currentPeriodEnd) }}
                  </td>
                  <td class="py-2 text-right">
                    <!-- Comps only. A `sub_` or `txn_` row is money Paddle owns:
                         revoking it locally would either be overwritten by the
                         next webhook or take away something the customer paid
                         for with no refund attached. The server refuses those
                         too (422) — this just never offers it. -->
                    <UButton
                      v-if="row.comped && isRevocable(row)"
                      color="error"
                      variant="ghost"
                      size="xs"
                      @click="openRevoke(row)"
                    >
                      Revoke
                    </UButton>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <template #footer>
            <p class="text-sm text-muted">
              Revoking ends a comp immediately and leaves the row here, marked revoked — it is a
              record of something that happened, not a mistake to erase. Refunds and cancellations
              go through Paddle.
            </p>
          </template>
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
                  <dd class="text-default">{{ planReadsAs }}</dd>
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
                      :icon="
                        viewAs.dashboardReachable ? 'i-lucide-circle-check' : 'i-lucide-circle-x'
                      "
                    >
                      {{ viewAs.dashboardReachable ? 'yes' : 'no — sent to /pricing' }}
                    </UBadge>
                    <p v-if="subscriptionGate" class="mt-2 text-sm text-muted">
                      {{ subscriptionGate }}
                    </p>
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
            <li
              v-for="item in data.feedback"
              :key="item.id"
              class="flex flex-col gap-2 py-4 first:pt-0"
            >
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
                    v-for="pair in metadataPairs(entry.metadata)"
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

    <!-- Revoke confirmation. Destructive, so it is solid `error` per DESIGN.md
         rather than the page's primary — and it asks for a reason rather than
         just a yes, because "why did my access disappear" is the question this
         answers months from now. -->
    <UModal v-model:open="revokeOpen" title="Revoke this comp?">
      <template #body>
        <UForm
          id="revoke-comp"
          :schema="revokeSchema"
          :state="revokeState"
          class="flex flex-col gap-5"
          @submit="submitRevoke"
        >
          <p class="text-muted">
            Access from this grant ends immediately. Anything else the customer has — a paid pass, a
            subscription, another comp — is untouched.
          </p>

          <dl
            v-if="revokeTarget"
            class="grid gap-3 border border-default p-4 text-sm sm:grid-cols-2"
          >
            <div>
              <dt class="text-muted">Granted</dt>
              <dd class="font-mono text-default">{{ formatDay(revokeTarget.purchasedAt) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Would have ended</dt>
              <dd class="font-mono text-default">
                {{ formatDay(revokeTarget.currentPeriodEnd) }}
              </dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-muted">Ref</dt>
              <dd class="truncate font-mono text-xs text-dimmed">{{ revokeTarget.ref }}</dd>
            </div>
          </dl>

          <UFormField
            label="Reason"
            name="reason"
            help="Recorded in the audit trail, alongside your account and the access being removed."
          >
            <UTextarea
              v-model="revokeState.reason"
              :rows="2"
              class="w-full"
              placeholder="Granted twice by mistake."
            />
          </UFormField>
        </UForm>
      </template>

      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton type="submit" form="revoke-comp" color="error" :loading="revoking">
            Revoke access
          </UButton>
          <UButton color="neutral" variant="ghost" @click="revokeOpen = false">Cancel</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
