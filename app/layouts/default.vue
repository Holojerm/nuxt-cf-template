<script setup lang="ts">
// The app shell for every page — marketing and product alike.
//
// One shell rather than a marketing/app split: at this size a second layout
// costs more than it saves, and the nav already adapts (public links always,
// Dashboard only when signed in, avatar menu instead of a Sign in button).
// Split it the day the product needs a sidebar.

const config = useRuntimeConfig()
const { loggedIn } = useUserSession()

const appName = config.public.appName
const supportEmail = config.public.supportEmail
const year = new Date().getFullYear()

const navLinks = computed(() => [
  { label: 'Pricing', to: '/pricing' },
  ...(loggedIn.value ? [{ label: 'Dashboard', to: '/dashboard' }] : []),
])
</script>

<template>
  <div class="flex min-h-screen flex-col bg-default">
    <!-- Navigation -->
    <header class="border-b border-default">
      <UContainer>
        <div class="flex h-16 items-center justify-between gap-4">
          <NuxtLink to="/" class="flex items-center gap-2 font-medium text-highlighted">
            <!-- Replace with your logo -->
            <span>{{ appName }}</span>
          </NuxtLink>

          <nav class="flex items-center gap-2">
            <UButton
              v-for="link in navLinks"
              :key="link.to"
              :to="link.to"
              color="neutral"
              variant="ghost"
              size="sm"
            >
              {{ link.label }}
            </UButton>
            <UColorModeButton />
            <AuthUserMenu />
          </nav>
        </div>
      </UContainer>
    </header>

    <!-- Main content -->
    <UContainer as="main" class="flex-1 py-8">
      <slot />
    </UContainer>

    <!-- Footer. The legal links are not optional decoration: Paddle's onboarding
         review checks for reachable terms and privacy pages before approving an
         account, and so do most payment processors. -->
    <footer class="mt-16 border-t border-default">
      <UContainer>
        <div class="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-sm text-muted">© {{ year }} {{ appName }}</p>
          <nav class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <ULink to="/pricing" class="text-muted hover:text-default">Pricing</ULink>
            <ULink to="/terms" class="text-muted hover:text-default">Terms</ULink>
            <ULink to="/privacy" class="text-muted hover:text-default">Privacy</ULink>
            <ULink :to="`mailto:${supportEmail}`" class="text-muted hover:text-default">
              Support
            </ULink>
          </nav>
        </div>
      </UContainer>
    </footer>

    <!-- Feedback entry point — on every page, open to signed-out visitors too.
         Remove this and drop <FeedbackWidget position="inline" /> into specific
         pages if a floating button doesn't suit the product. -->
    <FeedbackWidget />
  </div>
</template>
