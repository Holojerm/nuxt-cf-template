<script setup lang="ts">
// The brand mark, and the only place it is drawn.
//
// DESIGN.md › Brand mark is the contract; this file is what it compiles to, the
// same way main.css and app.config.ts are what the rest of DESIGN.md compiles
// to. `bun run brand:generate` extracts the <svg data-brand-mark> element below
// and derives every standalone asset from it — favicon.svg, the apple-touch
// icon, the OG share image. That is the whole reason the mark lives in a
// component instead of three hand-drawn files: a logo that exists in four
// places gets redesigned in one of them.
//
// Two consequences worth knowing before editing:
//
//   1. The geometry must stay static. No interpolation, no bindings, no
//      directives inside the <svg> — a .png cannot evaluate them, and the
//      generator refuses rather than silently shipping a mark that differs
//      between the header and the browser tab.
//   2. It paints with `currentColor`, so in-app it inherits whatever text token
//      its container sets, and the generated files get the resolved DESIGN.md
//      color substituted in. Never put a hex in here — design:check fails on it.
//
// After changing the mark, run `bun run brand:generate` and commit what it
// writes. `bun run brand:check` (part of `bun run ci`) fails the build if you
// forget.

interface Props {
  /** `lockup` pairs the mark with the app name; `mark` is the glyph alone. */
  variant?: 'mark' | 'lockup'
  /** Utilities for the glyph itself — size *and* color. Kept off the root so
   *  the lockup's text size stays independent of it, and passed rather than
   *  merged so a caller can actually recolor the mark: two competing color
   *  utilities on one element are settled by stylesheet order, not by argument
   *  order, so `text-primary` baked in here would quietly beat a `text-inverted`
   *  from outside. Override it and you own both halves. */
  markClass?: string
}

withDefaults(defineProps<Props>(), {
  variant: 'lockup',
  markClass: 'size-6 text-primary',
})

const appName = useRuntimeConfig().public.appName
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <svg
      data-brand-mark
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      :class="['shrink-0', markClass]"
    >
      <!-- Two quarried strata, offset — DESIGN.md › Brand mark. Slab corners
           (rx 1.5), not pills: the radius echoes --ui-radius rather than
           contradicting it. -->
      <rect x="3" y="7" width="26" height="6.5" rx="1.5" />
      <rect x="3" y="18.5" width="17" height="6.5" rx="1.5" opacity=".55" />
    </svg>

    <span
      v-if="variant === 'lockup'"
      class="font-display text-xl tracking-tight text-highlighted"
      >{{ appName }}</span
    >
  </span>
</template>
