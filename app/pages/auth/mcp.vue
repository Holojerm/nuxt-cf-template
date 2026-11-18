<script setup lang="ts">
// /auth/mcp?request=… — where the MCP worker's /authorize sends a browser to
// learn who is connecting (mcp/src/authorize.ts).
//
// The page exists for its middleware: someone signed out goes through /login
// and comes back here, by whichever sign-in method they use. Signed in, it
// asks the app for a single-use code bound to the worker's request and leaves
// for the worker, which shows the approval page. Nothing is granted here.
//
// The code is minted in the browser, not during SSR, so the POST carries the
// session cookie and the per-user rate limit like any other call.

definePageMeta({ middleware: 'auth' })

useSeo({
  title: 'Connect an AI client',
  description: 'Sign in to connect an AI client to your account.',
  noindex: true,
})

const route = useRoute()
const failed = ref(false)

onMounted(async () => {
  try {
    const { redirect } = await $fetch('/api/mcp/connect-code', {
      method: 'POST',
      body: { request: route.query.request },
    })
    if (!redirect) throw new Error('no MCP server')
    await navigateTo(redirect, { external: true })
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <!-- Plain text, not a UAlert: the alert's description is drawn at 90% opacity,
       which fell under 4.5:1 on a fork's error tint. This page is scanned by a
       fork's axe suite in exactly this state, since it is what a signed-in
       visitor with no request to answer sees. -->
  <UContainer
    class="flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-3 text-center"
  >
    <h1 class="text-xl text-highlighted">Connect an AI client</h1>
    <p v-if="failed" class="text-muted" role="alert">
      This sign-in link has expired or is not valid. Go back to your AI client and connect again.
    </p>
    <template v-else>
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
      <p class="text-muted" role="status">Connecting…</p>
    </template>
  </UContainer>
</template>
