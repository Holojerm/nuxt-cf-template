<script setup lang="ts">
// The first-run checklist on /dashboard. Purely presentational: all the
// "what's done" logic lives in shared/utils/onboarding.ts (pure, unit-tested)
// and server/utils/onboarding.ts (the D1 reads + the one-time activation
// event) — this component only renders what its parent hands it. The fetch,
// the dismissal state, and the activation POST live in
// app/pages/dashboard.vue rather than here, deliberately: the page also
// decides whether the empty state below shows, and that decision has to
// agree with the checklist's own visibility in the exact same render —
// computing both from one ref in one component rules out the two ever
// disagreeing for a frame.
//
// ── A/B: 'onboarding-layout' ────────────────────────────────────────────
// One <UCard>, always — never two separate cards toggled with v-if/v-else.
// The 'control' and 'compact' arms differ ONLY in the header slot's
// content (a two-line heading vs. a single-line progress readout); the
// body (progress bar + step list) and footer (next action) are identical
// markup for both. That's what makes the two arms occupy the same box
// without any manual height-matching: there's barely anything left that
// COULD differ in height. useFlag.ts's own warning is that the flag falls
// back to 'control' for one frame before resolving in onMounted, and to
// design "so that frame is not a visible flash (swap content, not
// layout)" — sharing one card, with only a small header row varying, is
// what satisfies that here. The header still gets a `min-h` (below) to
// absorb the one-line/two-line difference exactly, so even that doesn't
// move anything beneath it.
//
// (Historical note: this used to be two separate <UCard v-if>/<UCard
// v-else> elements. Beyond the height mismatch, that shape doesn't even
// compile if you try to give each branch real named header/footer slots —
// Vue's template compiler doesn't support nesting `<template #slot>`
// blocks inside a `<template v-if>/<template v-else>` wrapper. Always
// rendering one <UCard> with plain `v-if`/`v-else` on <div>s *inside* its
// slots sidesteps both problems at once.)

const props = defineProps<{
  progress: OnboardingProgress | null | undefined
  variant: string
}>()

const emit = defineEmits<{ dismiss: [] }>()

const totalSteps = computed(() => props.progress?.total ?? ONBOARDING_STEP_IDS.length)
const completedSteps = computed(() => props.progress?.completed ?? 0)
</script>

<template>
  <UCard>
    <template #header>
      <!-- min-h-10 covers the taller of the two: control's two lines of
           text vs. compact's one row. Matching it here — rather than
           leaving the two branches to their natural, different heights —
           is the actual fix for issue #2: nothing below this slot moves
           when the flag resolves and swaps which branch is showing. -->
      <div class="flex min-h-10 items-center justify-between gap-4">
        <div v-if="variant === 'compact'" class="flex min-w-0 flex-1 items-center gap-3">
          <UIcon
            name="i-lucide-list-checks"
            class="size-4 shrink-0 text-muted"
            aria-hidden="true"
          />
          <UProgress :model-value="completedSteps" :max="totalSteps" size="sm" class="flex-1" />
          <p class="whitespace-nowrap text-sm text-muted">
            {{ completedSteps }} of {{ totalSteps }} done
          </p>
        </div>
        <div v-else>
          <h2 class="text-lg text-highlighted">Get set up</h2>
          <p class="text-sm text-muted">{{ completedSteps }} of {{ totalSteps }} done</p>
        </div>

        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          class="min-touch shrink-0"
          aria-label="Dismiss checklist"
          @click="emit('dismiss')"
        />
      </div>
    </template>

    <!-- Identical for both arms — see the note above. -->
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
           (app/components/Feedback/FeedbackWidget.vue), inline instead.
           Identical for both arms. -->
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
