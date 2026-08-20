<template>
  <div class="min-h-screen bg-default">
    <!-- Navigation -->
    <header class="border-b border-default">
      <UContainer>
        <div class="flex h-16 items-center justify-between">
          <NuxtLink to="/" class="flex items-center gap-2 font-semibold text-highlighted">
            <!-- Replace with your logo -->
            <span>{{ appName }}</span>
          </NuxtLink>

          <nav class="flex items-center gap-4">
            <UColorModeButton />
            <!-- Add nav links here -->
          </nav>
        </div>
      </UContainer>
    </header>

    <!-- Main content -->
    <UContainer as="main" class="py-8">
      <slot />
    </UContainer>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig()
const appName = config.public.appName
</script>
