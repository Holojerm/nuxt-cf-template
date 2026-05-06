<template>
  <div class="flex flex-col items-center justify-center gap-8 py-20">
    <div class="text-center">
      <h1 class="text-4xl font-bold tracking-tight text-foreground">
        Welcome to {{ config.public.appName }}
      </h1>
      <p class="mt-4 text-lg text-muted">Nuxt 4 · NuxtUI · Cloudflare Workers · D1 · KV · R2</p>
    </div>

    <div class="flex gap-4">
      <UButton to="https://github.com/jeremyettlinger/nuxt-cf-template" target="_blank" size="lg">
        View on GitHub
      </UButton>
      <UButton to="https://hub.nuxt.com/docs" target="_blank" variant="outline" size="lg">
        NuxtHub Docs
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig()

useSeoMeta({
  title: config.public.appName,
  description: 'Nuxt 4 + Cloudflare Workers template',
})
</script>
