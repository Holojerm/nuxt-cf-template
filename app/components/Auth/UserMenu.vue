<script setup lang="ts">
// The nav's right-hand side. Signed out: a Sign in button. Signed in: an avatar
// dropdown. Kept out of the layout so the layout stays readable and this can be
// dropped into any other shell you build.

const { loggedIn, user, clear: clearSession } = useUserSession()
const route = useRoute()
const isLoginPage = computed(() => route.path === '/login')

async function signOut() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clearSession()
  // Reload rather than navigate when we're already on a page the `auth`
  // middleware guards — otherwise the guard fires mid-navigation and the user
  // watches themselves get redirected to /login, which reads as an error.
  await navigateTo('/')
}

const items = computed(() => [
  [
    {
      label: user.value?.email ?? '',
      slot: 'account' as const,
      type: 'label' as const,
    },
  ],
  [
    { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/dashboard' },
    { label: 'Account', icon: 'i-lucide-user', to: '/account' },
    { label: 'Pricing', icon: 'i-lucide-tag', to: '/pricing' },
  ],
  [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }],
])
</script>

<template>
  <UDropdownMenu v-if="loggedIn" :items="items" :ui="{ content: 'w-56' }">
    <UButton color="neutral" variant="ghost" class="gap-2">
      <UAvatar :src="user?.avatarUrl ?? undefined" :alt="user?.name" size="2xs" />
      <span class="hidden max-w-32 truncate sm:inline">{{ user?.name }}</span>
    </UButton>

    <template #account-label>
      <div class="text-left">
        <p class="truncate font-medium text-highlighted">{{ user?.name }}</p>
        <p class="truncate text-sm text-muted">{{ user?.email }}</p>
      </div>
    </template>
  </UDropdownMenu>

  <!-- Nothing to show on /login itself: the button would link to the page it's
       already on, nesting `?redirect=/login?redirect=…` one level per visit. -->
  <UButton
    v-else-if="!isLoginPage"
    :to="{ path: '/login', query: { redirect: route.fullPath } }"
    size="sm"
  >
    Sign in
  </UButton>
</template>
