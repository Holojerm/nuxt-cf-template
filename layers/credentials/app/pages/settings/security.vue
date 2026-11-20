<script setup lang="ts">
import { z } from 'zod'

import type { PasskeyRow } from '../../composables/usePasskeys'

definePageMeta({ layout: 'default', middleware: ['credentials', 'auth'] })

const toast = useToast()
const { changePassword, setPassword } = useCredentials()
const passkeys = usePasskeys()

const { data: me, refresh: refreshMe } = await useFetch('/api/credentials/me')
const { data: listed, refresh: refreshPasskeys } = await useFetch<{ passkeys: PasskeyRow[] }>(
  '/api/credentials/passkeys',
)
const rows = computed(() => listed.value?.passkeys ?? [])

// ── Password ─────────────────────────────────────────────────────────────────
const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: credentialsPasswordFieldSchema,
})
const passwordState = reactive({ currentPassword: '', newPassword: '' })
const passwordPending = ref(false)
const passwordFailure = ref<string | null>(null)

async function submitPassword() {
  passwordPending.value = true
  passwordFailure.value = null
  try {
    await changePassword({ ...passwordState })
    passwordState.currentPassword = ''
    passwordState.newPassword = ''
    await refreshMe()
    toast.add({
      title: 'Password changed',
      description: 'Your other devices have been signed out.',
      color: 'success',
    })
  } catch (error) {
    passwordFailure.value = credentialsErrorMessage(error)
  } finally {
    passwordPending.value = false
  }
}

// An account made with a passkey has no password until it sets one here.
const firstSchema = z.object({ password: credentialsPasswordFieldSchema })
const firstState = reactive({ password: '' })

async function submitFirstPassword() {
  passwordPending.value = true
  passwordFailure.value = null
  try {
    await setPassword(firstState.password)
    firstState.password = ''
    await refreshMe()
    toast.add({ title: 'Password set', color: 'success' })
  } catch (error) {
    passwordFailure.value = credentialsErrorMessage(error)
  } finally {
    passwordPending.value = false
  }
}

// ── Passkeys ─────────────────────────────────────────────────────────────────
const passkeySchema = z.object({ label: credentialsPasskeyLabelSchema })
const passkeyState = reactive({ label: '' })
const passkeyPending = ref(false)
const passkeyFailure = ref<string | null>(null)
const removing = ref<string | null>(null)

async function addPasskey() {
  passkeyPending.value = true
  passkeyFailure.value = null
  try {
    await passkeys.register(passkeyState.label)
    passkeyState.label = ''
    await refreshPasskeys()
    toast.add({ title: 'Passkey added', color: 'success' })
  } catch (error) {
    passkeyFailure.value = credentialsErrorMessage(error)
  } finally {
    passkeyPending.value = false
  }
}

async function removePasskey(row: PasskeyRow) {
  removing.value = row.id
  passkeyFailure.value = null
  try {
    await passkeys.remove(row.id)
    await refreshPasskeys()
    toast.add({ title: 'Passkey removed', color: 'success' })
  } catch (error) {
    passkeyFailure.value = credentialsErrorMessage(error)
  } finally {
    removing.value = null
  }
}

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : null

useSeo({
  title: 'Sign-in and security',
  description: 'Change your password and manage your passkeys.',
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-8 py-12">
    <h1 class="text-3xl text-highlighted">Sign-in and security</h1>

    <UCard>
      <template #header>
        <h2 class="text-xl text-highlighted">Password</h2>
      </template>

      <UForm
        v-if="me?.hasPassword"
        :schema="passwordSchema"
        :state="passwordState"
        class="flex max-w-md flex-col gap-4"
        @submit="submitPassword"
      >
        <p class="text-sm text-muted">
          Changing it signs out every other device. You need your current password to do it.
        </p>
        <UFormField label="Current password" name="currentPassword">
          <UInput
            v-model="passwordState.currentPassword"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>
        <UFormField
          label="New password"
          name="newPassword"
          :help="`At least ${CREDENTIALS_MIN_PASSWORD_LENGTH} characters.`"
        >
          <UInput
            v-model="passwordState.newPassword"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="passwordFailure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="passwordFailure"
        />
        <div>
          <UButton type="submit" :loading="passwordPending">Change password</UButton>
        </div>
      </UForm>

      <UForm
        v-else
        :schema="firstSchema"
        :state="firstState"
        class="flex max-w-md flex-col gap-4"
        @submit="submitFirstPassword"
      >
        <p class="text-sm text-muted">
          This account has no password yet. With one, you can sign in on a computer that doesn't
          have your passkey.
        </p>
        <UFormField
          label="New password"
          name="password"
          :help="`At least ${CREDENTIALS_MIN_PASSWORD_LENGTH} characters.`"
        >
          <UInput
            v-model="firstState.password"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="passwordFailure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="passwordFailure"
        />
        <div>
          <UButton type="submit" :loading="passwordPending">Set a password</UButton>
        </div>
      </UForm>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="text-xl text-highlighted">Passkeys</h2>
      </template>

      <div class="flex flex-col gap-6">
        <p class="text-sm text-muted">
          A passkey signs you in with your fingerprint, face or device PIN instead of your password.
        </p>

        <ul v-if="rows.length" class="flex flex-col divide-y divide-default">
          <li
            v-for="row in rows"
            :key="row.id"
            class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div class="min-w-0">
              <p class="truncate font-medium text-highlighted">{{ row.name }}</p>
              <p class="text-sm text-muted">
                Added {{ day(row.createdAt) }}
                <template v-if="row.lastUsedAt"> · last used {{ day(row.lastUsedAt) }}</template>
                <template v-if="row.backedUp"> · synced</template>
              </p>
            </div>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-trash-2"
              :loading="removing === row.id"
              :aria-label="`Remove passkey ${row.name}`"
              @click="removePasskey(row)"
            >
              Remove
            </UButton>
          </li>
        </ul>
        <p v-else class="text-sm text-muted">No passkeys yet.</p>

        <UAlert
          v-if="passkeyFailure"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="passkeyFailure"
        />

        <UForm
          v-if="passkeys.isSupported.value"
          :schema="passkeySchema"
          :state="passkeyState"
          class="flex max-w-md flex-col gap-4"
          @submit="addPasskey"
        >
          <UFormField
            label="Name for the new passkey"
            name="label"
            help="So you can tell them apart, e.g. the device it lives on."
          >
            <UInput v-model="passkeyState.label" placeholder="MacBook" class="w-full" />
          </UFormField>
          <div>
            <UButton
              type="submit"
              color="neutral"
              variant="outline"
              icon="i-lucide-fingerprint"
              :loading="passkeyPending"
            >
              Add a passkey
            </UButton>
          </div>
        </UForm>
        <p v-else class="text-sm text-muted">This browser cannot create passkeys.</p>
      </div>
    </UCard>
  </div>
</template>
