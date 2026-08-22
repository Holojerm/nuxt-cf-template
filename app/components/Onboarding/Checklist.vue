<script setup lang="ts">
// The first-run checklist on /dashboard. Purely presentational: all the
// "what's done" logic lives in shared/utils/onboarding.ts (pure, unit-tested)
// and server/utils/onboarding.ts (the D1 reads + the one-time activation
// event) — this component only renders what its parent hands it. The fetch
// and the dismissal state live in app/pages/dashboard.vue rather than here,
// deliberately: both also decide whether the page's empty state shows, and
// computing that in one place (dashboard.vue) means the checklist's
// visibility and the empty state's visibility can never briefly disagree —
// splitting them across a parent ref and a child emit invites exactly the
// one-render lag that useFlag.ts warns about, just between two components
// instead of between SSR and onMounted.
//
// ── A/B: 'onboarding-layout' ────────────────────────────────────────────
// Two renderings behind one multivariate flag (app/composables/useFlag.ts):
// 'control' is the full checklist below, 'compact' is a single-line
// progress strip. Both render in the SAME position in the page, as the only
// child here — useFlag.ts's own warning is that the flag falls back to
// 'control' for one frame before resolving in onMounted, and to design "so
// that frame is not a visible flash (swap content, not layout)". Neither
// variant ever appears or disappears independently of the other — this
// component always renders exactly one <UCard>, so there's no frame where
// the checklist itself pops in or out because of the flag, only a frame
// where its contents redraw.
//
// (The two branches below are two separate <UCard> elements rather than one
// shared element with conditional slots — Vue's template compiler doesn't
// support nesting named `<template #slot>` blocks inside a `<template
// v-if>/<template v-else>` wrapper, which is the shape this started as. Vue
// still doesn't guarantee reusing the underlying DOM node across the two
// branches, but the position in the page — the thing that actually matters
// for "not shifting layout" — is identical either way.)

const props = defineProps<{
  progress: OnboardingProgress | null | undefined
  variant: string
}>()

const emit = defineEmits<{ dismiss: [] }>()

const totalSteps = computed(() => props.progress?.total ?? ONBOARDING_STEP_IDS.length)
const completedSteps = computed(() => props.progress?.completed ?? 0)
</script>

<template>
  <!-- compact: one line — progress bar, count, single next action -->
  <UCard v-if="variant === 'compact'">
    <div class="flex flex-wrap items-center gap-4">
      <UIcon name="i-lucide-list-checks" class="size-4 shrink-0 text-muted" aria-hidden="true" />
      <UProgress :model-value="completedSteps" :max="totalSteps" size="sm" class="min-w-32 flex-1" />
      <p class="whitespace-nowrap text-sm text-muted">{{ completedSteps }} of {{ totalSteps }} done</p>

      <FeedbackWidget
        v-if="progress?.next?.id === 'feedback'"
        position="inline"
        label="Send feedback"
      />
      <UButton v-else-if="progress?.next" :to="progress.next.action.to" size="sm">
        {{ progress.next.action.label }}
      </UButton>

      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        class="min-touch"
        aria-label="Dismiss checklist"
        @click="emit('dismiss')"
      />
    </div>
  </UCard>

  <!-- control: the full checklist -->
  <UCard v-else>
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <div>
          <h2 class="text-lg text-highlighted">Get set up</h2>
          <p class="text-sm text-muted">{{ completedSteps }} of {{ totalSteps }} done</p>
        </div>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          class="min-touch"
          aria-label="Dismiss checklist"
          @click="emit('dismiss')"
        />
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <UProgress :model-value="completedSteps" :max="totalSteps" size="sm" />

      <ul class="flex flex-col gap-2">
        <li
          v-for="step in progress?.steps ?? []"
          :key="step.id"
          class="flex items-center gap-2 text-sm"
        >
          <!-- Done vs. pending is never color alone: the icon shape differs
               (a filled check vs. a dashed outline), and the word itself is
               struck through — see DESIGN.md › Accessibility. -->
          <UIcon
            :name="step.done ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'"
            :class="step.done ? 'text-success' : 'text-muted'"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          <span :class="step.done ? 'text-muted line-through' : 'text-default'">
            {{ step.label }}
          </span>
        </li>
      </ul>
    </div>

    <template #footer>
      <!-- One primary action per view — the next incomplete step, and
           nothing else. The 'feedback' step isn't a plain link: it embeds
           the same widget every other page uses floating
           (app/components/Feedback/FeedbackWidget.vue), inline instead. -->
      <FeedbackWidget
        v-if="progress?.next?.id === 'feedback'"
        position="inline"
        label="Send feedback"
      />
      <UButton v-else-if="progress?.next" :to="progress.next.action.to">
        {{ progress.next.action.label }}
      </UButton>
    </template>
  </UCard>
</template>
