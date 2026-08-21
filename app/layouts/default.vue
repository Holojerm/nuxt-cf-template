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

// Mobile nav drawer. Two links don't need one — five do, and this is the seam a
// fork grows through, so the pattern ships now rather than being retrofitted
// once the header has already started wrapping.
const navOpen = ref(false)

// Close on navigation. A route watcher rather than a click handler on each link:
// it also covers programmatic redirects (the auth middleware bouncing someone to
// /login) that never fire a click.
const route = useRoute()
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-default">
    <!-- Skip link — WCAG 2.4.1. First focusable element on every page, so a
         keyboard or screen-reader user can jump the nav instead of tabbing it on
         each navigation. Visually hidden until focused. -->
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-4 focus:py-2 focus:text-highlighted focus:ring-2 focus:ring-primary"
    >
      Skip to content
    </a>

    <!-- Navigation -->
    <header class="border-b border-default">
      <UContainer>
        <div class="flex h-16 items-center justify-between gap-4">
          <!-- The mark and the wordmark both come from BrandLogo, which is also
               what every generated icon is derived from (DESIGN.md › Brand mark).
               Redesign it there and the tab, the home screen, and the share
               image follow on the next `bun run brand:generate`. -->
          <NuxtLink to="/" class="min-touch flex items-center" :aria-label="`${appName} — home`">
            <BrandLogo />
          </NuxtLink>

          <div class="flex items-center gap-1 sm:gap-2">
            <!-- Inline nav, desktop only. Below `sm` these move into the drawer
                 rather than wrapping or scrolling horizontally. -->
            <nav aria-label="Primary" class="hidden items-center gap-2 sm:flex">
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
            </nav>

            <UColorModeButton class="min-touch" />
            <AuthUserMenu />

            <!-- Drawer trigger, mobile only. -->
            <USlideover
              v-model:open="navOpen"
              title="Menu"
              side="right"
              :ui="{ content: 'max-w-xs' }"
            >
              <UButton
                class="min-touch sm:hidden"
                color="neutral"
                variant="ghost"
                icon="i-lucide-menu"
                aria-label="Open menu"
              />

              <template #body>
                <nav aria-label="Mobile" class="flex flex-col gap-1">
                  <UButton
                    v-for="link in navLinks"
                    :key="link.to"
                    :to="link.to"
                    color="neutral"
                    variant="ghost"
                    size="lg"
                    block
                    class="min-touch justify-start"
                  >
                    {{ link.label }}
                  </UButton>
                </nav>
              </template>
            </USlideover>
          </div>
        </div>
      </UContainer>
    </header>

    <!-- Main content -->
    <!-- tabindex="-1" so the skip link moves focus here, not just the scroll
         position — without it the next Tab lands back at the top of the nav.
         The focus-visible rule protects elements a user can Tab to; `main` is only
         ever focused programmatically by the skip link, and a ring around the whole
         page region reads as a rendering bug. design-check-ignore -->
    <UContainer id="main" as="main" tabindex="-1" class="flex-1 py-8 focus:outline-none">
      <slot />
    </UContainer>

    <!-- Footer. The legal links are not optional decoration: Paddle's onboarding
         review checks for reachable terms and privacy pages before approving an
         account, and so do most payment processors. -->
    <footer class="mt-16 border-t border-default">
      <UContainer>
        <div class="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-sm text-muted">© {{ year }} {{ appName }}</p>
          <nav aria-label="Footer" class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <ULink to="/pricing" class="text-muted hover:text-default">Pricing</ULink>
            <ULink to="/changelog" class="text-muted hover:text-default">Changelog</ULink>
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
