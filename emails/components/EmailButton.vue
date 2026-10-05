<script setup lang="ts">
// Wraps Maizzle's Button for the Outlook padding workaround it carries.
// `href` is usually a Mustache tag, passed through as a literal string.
defineProps<{
  href: string
  /** `ink` is the quiet one — the ops digest's buttons. */
  tone?: 'accent' | 'ink'
  /** Smaller, with no space beneath: for buttons laid out side by side. */
  compact?: boolean
}>()
</script>

<template>
  <div :class="compact ? '' : 'pb-6'">
    <Button
      :href="href"
      :class="[
        'text-on-accent',
        tone === 'ink' ? 'bg-ink' : 'bg-accent',
        compact ? 'rounded px-4 py-2.5 text-sm font-medium' : 'rounded px-5 py-3 text-base font-medium',
      ]"
    >
      <slot />
    </Button>
  </div>
</template>
