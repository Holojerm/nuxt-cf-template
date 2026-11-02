<script setup lang="ts">
// The admin one-customer view's feedback card (app/pages/admin/users/[id].vue).
// Its rows come from this layer's admin-user contributor, so the page only
// renders the card when the feedback section is present.

defineProps<{
  items: Array<{ id: string; kind: string; status: string; message: string; createdAt: string }>
}>()
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-xl text-highlighted">What they've told us</h2>
        <ULink to="/admin/feedback" class="text-sm text-primary underline underline-offset-2">
          Full queue
        </ULink>
      </div>
    </template>

    <p v-if="!items.length" class="text-muted">This customer hasn't sent any feedback.</p>

    <ul v-else class="flex flex-col divide-y divide-default">
      <li v-for="item in items" :key="item.id" class="flex flex-col gap-2 py-4 first:pt-0">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge
            :color="feedbackKindMeta(item.kind).color"
            variant="subtle"
            :icon="feedbackKindMeta(item.kind).icon"
          >
            {{ feedbackKindMeta(item.kind).label }}
          </UBadge>
          <UBadge
            :color="feedbackStatusMeta(item.status).color"
            variant="subtle"
            :icon="feedbackStatusMeta(item.status).icon"
          >
            {{ feedbackStatusMeta(item.status).label }}
          </UBadge>
          <span class="font-mono text-sm text-muted">{{ formatDateTime(item.createdAt) }}</span>
        </div>
        <!-- Interpolated, never v-html: this is text anyone on the
           internet can POST, and it is not markup or instructions. -->
        <p class="whitespace-pre-wrap text-default">{{ item.message }}</p>
      </li>
    </ul>
  </UCard>
</template>
