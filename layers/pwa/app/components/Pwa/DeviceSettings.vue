<script setup lang="ts">
// "This device": put the app on it, and turn its notifications on or off.
// Both are per browser, not per account, which is why they sit apart from the
// email preferences.
//
// Notifications are off until the person turns them on. The browser's
// permission question appears only as the answer to that click, never on page
// load, and nothing here asks twice. Rows with nothing to offer are left out,
// and the card with them, so an app with no VAPID keys in a browser that
// cannot install shows nothing at all (or the `empty` slot, where a page has
// nothing else to show).

const toast = useToast()
const install = usePwaInstall()
const push = usePushSubscription()

// Everything below depends on the browser, so the server renders nothing and
// the card appears once this is true.
const ready = ref(false)
onMounted(async () => {
  try {
    await push.refresh()
  } catch {
    // The switch shows off; turning it on will say what is wrong.
  }
  ready.value = true
})

const showInstall = computed(
  () => install.installed.value || install.canPrompt.value || install.needsHomeScreen.value,
)
// iOS has no push until the app is on the Home Screen, and the install row
// already says how to get it there.
const pushWaitsForInstall = computed(() => !push.supported.value && install.needsHomeScreen.value)
const showPush = computed(() => push.configured)
// The disabled switch keeps its label and description at full strength and
// fades only the control (the `ui` override in the template): NuxtUI fades the
// whole row below AA contrast, and this is the state where the words matter most.
const blocked = computed(() => push.permission.value === 'denied')

async function installApp(): Promise<void> {
  await install.prompt()
}

async function setNotifications(on: boolean): Promise<void> {
  try {
    if (!on) {
      await push.unsubscribe()
      return
    }
    await push.subscribe()
  } catch {
    toast.add({
      title: on ? 'Could not turn notifications on' : 'Could not turn notifications off',
      description: 'Check your connection, then try again.',
      color: 'error',
    })
  }
}
</script>

<template>
  <UCard v-if="ready && (showInstall || showPush)" data-testid="pwa-device-settings">
    <template #header>
      <h2 class="text-xl text-highlighted">This device</h2>
    </template>

    <div class="flex flex-col gap-6">
      <div
        v-if="showInstall"
        class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <p class="text-default">Install the app</p>
          <p v-if="install.installed.value" class="text-sm text-muted">
            Installed. You are using it now.
          </p>
          <p v-else-if="install.needsHomeScreen.value" class="text-sm text-muted">
            Tap Share in your browser's toolbar, then Add to Home Screen.
          </p>
          <p v-else class="text-sm text-muted">
            Opens in its own window, from your home screen or dock.
          </p>
        </div>
        <UButton
          v-if="install.canPrompt.value"
          color="neutral"
          variant="outline"
          icon="i-lucide-download"
          class="min-touch"
          @click="installApp"
        >
          Install
        </UButton>
      </div>

      <div v-if="showPush" class="flex flex-col gap-2">
        <p v-if="pushWaitsForInstall" class="text-sm text-muted">
          Notifications work on this device once the app is on your Home Screen.
        </p>
        <p v-else-if="!push.supported.value" class="text-sm text-muted">
          This browser cannot show notifications.
        </p>
        <template v-else>
          <USwitch
            :model-value="push.subscribed.value"
            :loading="push.pending.value"
            :disabled="blocked"
            :ui="{ root: 'opacity-100', base: blocked ? 'opacity-75' : '' }"
            label="Notifications on this device"
            description="Off until you turn them on. Turn them off here whenever you like."
            @update:model-value="(value) => setNotifications(Boolean(value))"
          />
          <p v-if="blocked" class="text-sm text-muted">
            Notifications from this site are blocked in your browser. Allow them in the browser's
            site settings, then come back.
          </p>
        </template>
      </div>
    </div>
  </UCard>
  <slot v-else-if="ready" name="empty" />
</template>
