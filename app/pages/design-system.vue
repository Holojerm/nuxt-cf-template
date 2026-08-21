<script setup lang="ts">
// Living style guide — every token and component state from DESIGN.md on one
// page, in both color modes. This is the verification surface: after editing
// DESIGN.md and running /design-sync, screenshot this route to confirm the
// personality actually landed instead of assuming it did.
//
// Dev-only — stripped from production routes by the `pages:extend` hook in
// nuxt.config.ts, so it never ships to users.

// Literal class strings: Tailwind scans source text, so `bg-clay-${n}` would
// generate nothing. Direct ramp access is exactly what design:check forbids in
// app code — this page is the one legitimate exception, since its job is to
// display the raw ramp.
const ramp = [
  { shade: '50', class: 'bg-clay-50' }, // design-check-ignore
  { shade: '100', class: 'bg-clay-100' }, // design-check-ignore
  { shade: '200', class: 'bg-clay-200' }, // design-check-ignore
  { shade: '300', class: 'bg-clay-300' }, // design-check-ignore
  { shade: '400', class: 'bg-clay-400' }, // design-check-ignore
  { shade: '500', class: 'bg-clay-500' }, // design-check-ignore
  { shade: '600', class: 'bg-clay-600' }, // design-check-ignore
  { shade: '700', class: 'bg-clay-700' }, // design-check-ignore
  { shade: '800', class: 'bg-clay-800' }, // design-check-ignore
  { shade: '900', class: 'bg-clay-900' }, // design-check-ignore
  { shade: '950', class: 'bg-clay-950' }, // design-check-ignore
]

const surfaces = [
  { token: 'bg-default', class: 'bg-default', use: 'Page background' },
  { token: 'bg-muted', class: 'bg-muted', use: 'Subtle sections' },
  { token: 'bg-elevated', class: 'bg-elevated', use: 'Cards, modals' },
  { token: 'bg-accented', class: 'bg-accented', use: 'Hover states' },
  { token: 'bg-inverted', class: 'bg-inverted', use: 'Inverted sections' },
]

const textTokens = [
  { token: 'text-highlighted', class: 'text-highlighted', use: 'Headings' },
  { token: 'text-default', class: 'text-default', use: 'Body copy' },
  { token: 'text-toned', class: 'text-toned', use: 'Subtitles' },
  { token: 'text-muted', class: 'text-muted', use: 'Secondary, captions' },
  { token: 'text-dimmed', class: 'text-dimmed', use: 'Placeholders, disabled' },
]

const borderTokens = [
  { token: 'border-default', class: 'border-default' },
  { token: 'border-muted', class: 'border-muted' },
  { token: 'border-accented', class: 'border-accented' },
]

const typeScale = [
  { token: 'text-5xl', class: 'text-5xl' },
  { token: 'text-4xl', class: 'text-4xl' },
  { token: 'text-3xl', class: 'text-3xl' },
  { token: 'text-2xl', class: 'text-2xl' },
  { token: 'text-xl', class: 'text-xl' },
  { token: 'text-lg', class: 'text-lg' },
  { token: 'text-base', class: 'text-base' },
  { token: 'text-sm', class: 'text-sm' },
  { token: 'text-xs', class: 'text-xs' },
]

const semanticColors = [
  'primary',
  'secondary',
  'success',
  'info',
  'warning',
  'error',
  'neutral',
] as const
const buttonVariants = ['solid', 'outline', 'soft', 'subtle', 'ghost', 'link'] as const

useSeo({
  title: 'Design system',
  description: 'Every design token and component state, in both color modes.',
  noindex: true,
})
</script>

<template>
  <div class="space-y-16 py-8">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Design system</h1>
      <p class="text-muted">
        Generated from <code class="text-default">DESIGN.md</code>. Toggle color mode to verify both
        themes — every token below must remain legible in each.
      </p>
      <UColorModeButton />
    </header>

    <!-- ── Color ─────────────────────────────────────────────────────── -->
    <section class="space-y-6">
      <h2 class="text-2xl text-highlighted">Color</h2>

      <div class="space-y-2">
        <h3 class="text-lg text-highlighted">Primary ramp — clay</h3>
        <div class="flex overflow-hidden rounded border border-default">
          <div v-for="step in ramp" :key="step.shade" class="flex-1">
            <div :class="step.class" class="h-16" />
            <div class="bg-default px-1 py-2 text-center text-xs text-muted">{{ step.shade }}</div>
          </div>
        </div>
        <p class="text-sm text-muted">
          App code must never reach these directly — use the semantic tokens below.
        </p>
      </div>

      <div class="space-y-2">
        <h3 class="text-lg text-highlighted">Semantic colors</h3>
        <div class="flex flex-wrap gap-3">
          <div v-for="color in semanticColors" :key="color" class="space-y-1">
            <UBadge :color="color" variant="solid">{{ color }}</UBadge>
          </div>
        </div>
      </div>

      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <div class="space-y-2">
          <h3 class="text-lg text-highlighted">Surfaces</h3>
          <div
            v-for="s in surfaces"
            :key="s.token"
            :class="s.class"
            class="flex items-center justify-between rounded border border-default px-3 py-2"
          >
            <code
              class="text-xs"
              :class="s.token === 'bg-inverted' ? 'text-inverted' : 'text-default'"
            >
              {{ s.token }}
            </code>
            <span
              class="text-xs"
              :class="s.token === 'bg-inverted' ? 'text-inverted' : 'text-muted'"
            >
              {{ s.use }}
            </span>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-lg text-highlighted">Text</h3>
          <div
            v-for="t in textTokens"
            :key="t.token"
            class="flex items-baseline justify-between gap-3"
          >
            <span :class="t.class">{{ t.token }}</span>
            <span class="text-xs text-dimmed">{{ t.use }}</span>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-lg text-highlighted">Borders</h3>
          <div
            v-for="b in borderTokens"
            :key="b.token"
            :class="b.class"
            class="rounded border-2 px-3 py-2"
          >
            <code class="text-xs text-default">{{ b.token }}</code>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Typography ────────────────────────────────────────────────── -->
    <section class="space-y-6">
      <h2 class="text-2xl text-highlighted">Typography</h2>

      <div class="grid gap-6 sm:grid-cols-3">
        <div class="space-y-1">
          <p class="text-xs uppercase tracking-wide text-dimmed">font-display</p>
          <p class="font-display text-3xl text-highlighted">Instrument Serif</p>
          <p class="text-sm text-muted">Headings only. Weight 400 — never bold.</p>
        </div>
        <div class="space-y-1">
          <p class="text-xs uppercase tracking-wide text-dimmed">font-sans</p>
          <p class="font-sans text-3xl text-highlighted">Inter</p>
          <p class="text-sm text-muted">Body, UI, labels.</p>
        </div>
        <div class="space-y-1">
          <p class="text-xs uppercase tracking-wide text-dimmed">font-mono</p>
          <p class="font-mono text-3xl text-highlighted">JetBrains</p>
          <p class="text-sm text-muted">Code, IDs, numerals.</p>
        </div>
      </div>

      <div class="space-y-3">
        <div
          v-for="t in typeScale"
          :key="t.token"
          class="flex items-baseline gap-4 border-b border-muted pb-2"
        >
          <code class="w-20 shrink-0 text-xs text-dimmed">{{ t.token }}</code>
          <span :class="t.class" class="text-default">Quarried, editorial, unhurried</span>
        </div>
      </div>

      <div class="max-w-prose space-y-2">
        <h3 class="text-lg text-highlighted">Body copy at reading width</h3>
        <p class="text-default">
          Body copy runs at a 1.65 line height because this system is built for reading. Set a
          paragraph here and check the rhythm against the heading above it — if the block feels
          cramped or the headings float free of their text, the scale needs work, not the copy.
        </p>
      </div>
    </section>

    <!-- ── Components ────────────────────────────────────────────────── -->
    <section class="space-y-6">
      <h2 class="text-2xl text-highlighted">Components</h2>

      <div class="space-y-3">
        <h3 class="text-lg text-highlighted">Buttons — variant × color</h3>
        <div
          v-for="variant in buttonVariants"
          :key="variant"
          class="flex flex-wrap items-center gap-2"
        >
          <code class="w-16 shrink-0 text-xs text-dimmed">{{ variant }}</code>
          <UButton v-for="color in semanticColors" :key="color" :color="color" :variant="variant">
            {{ color }}
          </UButton>
        </div>
      </div>

      <div class="space-y-3">
        <h3 class="text-lg text-highlighted">Button states</h3>
        <div class="flex flex-wrap items-center gap-2">
          <UButton>Default</UButton>
          <UButton loading>Loading</UButton>
          <UButton disabled>Disabled</UButton>
          <UButton icon="i-lucide-arrow-right" trailing>With icon</UButton>
          <UButton size="xs">xs</UButton>
          <UButton size="sm">sm</UButton>
          <UButton size="md">md</UButton>
          <UButton size="lg">lg</UButton>
          <UButton size="xl">xl</UButton>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          <h3 class="text-lg text-highlighted">Form controls</h3>
          <UFormField label="Label" help="Helper text sits in text-muted.">
            <UInput placeholder="Placeholder in text-dimmed" class="w-full" />
          </UFormField>
          <UFormField label="Error state" error="This field is required.">
            <UInput class="w-full" />
          </UFormField>
          <UFormField label="Disabled">
            <UInput disabled placeholder="Disabled" class="w-full" />
          </UFormField>
          <div class="flex flex-wrap items-center gap-4">
            <UCheckbox label="Checkbox" :model-value="true" />
            <USwitch label="Switch" :model-value="true" />
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="text-lg text-highlighted">Containers and feedback</h3>
          <UCard>
            <template #header>
              <h4 class="text-lg text-highlighted">Card</h4>
            </template>
            <p class="text-default">Bordered, never shadowed. Body padding p-6.</p>
          </UCard>
          <UAlert
            v-for="color in ['info', 'success', 'warning', 'error'] as const"
            :key="color"
            :color="color"
            variant="soft"
            :title="`${color} alert`"
            description="One line of context, then an action if one exists."
          />
          <div class="space-y-2">
            <USkeleton class="h-4 w-3/4" />
            <USkeleton class="h-4 w-1/2" />
          </div>
        </div>
      </div>

      <div class="space-y-3">
        <h3 class="text-lg text-highlighted">Focus visibility</h3>
        <p class="text-sm text-muted">
          Tab through these — every one must show a visible ring. Any element that swallows focus is
          a bug, not a style choice.
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <UButton variant="outline">Focusable button</UButton>
          <UInput placeholder="Focusable input" />
          <a href="#" class="text-primary underline underline-offset-4">Focusable link</a>
        </div>
      </div>
    </section>
  </div>
</template>
