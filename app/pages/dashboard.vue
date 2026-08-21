<script setup lang="ts">
// The gated page — the one that proves the whole chain works end to end:
// sign in → buy → get in. Replace its contents with your actual product.
//
// Both middlewares run in order: `auth` bounces signed-out visitors to /login
// (carrying `?redirect=/dashboard`), then `subscription` bounces signed-in
// visitors without an entitlement to /pricing.
//
// Neither is the security boundary. The API route this page calls does the real
// check with `await requireSubscription(event)`, which 402s. Delete the client
// middleware and this page still can't show paid data; delete the server check
// and it can.

definePageMeta({ middleware: ['auth', 'subscription'] })

const config = useRuntimeConfig()
const { user } = useUserSession()

useSeoMeta({ title: `Dashboard · ${config.public.appName}`, robots: 'noindex' })
</script>

<template>
  <div class="flex flex-col gap-8 py-12">
    <div>
      <h1 class="text-3xl text-highlighted">Welcome back, {{ user?.name }}</h1>
      <p class="mt-2 text-muted">
        You're signed in with an active plan — this page is only reachable in that state.
      </p>
    </div>

    <UCard>
      <template #header>
        <h2 class="text-xl text-highlighted">Build your product here</h2>
      </template>

      <div class="flex flex-col gap-4 text-default">
        <p>
          The plumbing behind this page is done: a session, an entitlement, and two middlewares that
          keep the wrong people out of the UI. What's missing is the thing you're actually selling.
        </p>
        <p class="text-muted">
          Gate the API routes that back it with
          <code class="rounded bg-elevated px-1 py-0.5 font-mono text-sm"
            >await requireSubscription(event)</code
          >
          — never on the client-side middleware alone.
        </p>
      </div>

      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton to="/account" color="neutral" variant="outline">Manage your plan</UButton>
          <UButton to="/design-system" color="neutral" variant="ghost">Design system</UButton>
        </div>
      </template>
    </UCard>
  </div>
</template>
