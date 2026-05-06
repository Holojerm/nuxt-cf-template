<template>
  <div class="min-h-screen bg-background">
    <!-- Navigation -->
    <header class="border-b border-border">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-16 items-center justify-between">
          <NuxtLink to="/" class="flex items-center gap-2 font-semibold text-foreground">
            <!-- Replace with your logo -->
            <span>{{ appName }}</span>
          </NuxtLink>

          <nav class="flex items-center gap-4">
            <UColorModeButton />
            <!-- Add nav links here -->
          </nav>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig()
const appName = config.public.appName
</script>
