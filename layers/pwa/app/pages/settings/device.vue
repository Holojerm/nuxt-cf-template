<script setup lang="ts">
// The settings component's own page, so the layer works in an app that has
// not placed <PwaDeviceSettings /> anywhere yet. An app with a settings page
// of its own puts the component there and can leave this one unlinked.
// `auth` is the UX guard; the push routes check the session themselves.

definePageMeta({ middleware: 'auth' })

useSeo({
  title: 'Install and notifications',
  description: 'Install the app and choose whether this device gets notifications.',
  noindex: true,
})
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-8 py-12">
    <h1 class="text-3xl text-highlighted">Install and notifications</h1>
    <PwaDeviceSettings>
      <template #empty>
        <p class="text-muted">There is nothing to set up in this browser.</p>
      </template>
    </PwaDeviceSettings>
    <p class="text-sm text-muted">
      Both are set for each browser you use, so they are not part of your account's settings.
    </p>
  </div>
</template>
