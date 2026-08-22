// GENERATED FROM /DESIGN.md — edit that file, then run `/design-sync`.
//
// Hand-edits here will be overwritten on the next sync. Raw values (palette,
// type scale, radius) belong in app/assets/css/main.css.
//
// Keep this file small. Before adding a component override, read the resolved
// theme at .nuxt/ui/<component>.ts — most of what you would write here is
// already NuxtUI's default, and a `slots` override loses to any `variants`
// entry that touches the same property.

export default defineAppConfig({
  ui: {
    // DESIGN.md › Color › Semantic assignments.
    // `clay` is the custom ramp in main.css; the rest are Tailwind built-ins.
    // Every color named here must have all 11 shades available.
    colors: {
      primary: 'clay',
      secondary: 'stone',
      neutral: 'stone',
      success: 'emerald',
      info: 'sky',
      warning: 'amber',
      error: 'rose',
    },

    // DESIGN.md › Component behavior › Cards. NuxtUI's `subtle` variant is
    // already "elevated surface + hairline ring + no shadow" — expressing it
    // as a variant default rather than a slot override keeps tailwind-merge
    // out of the picture. Radius and padding come from --ui-radius and the
    // component's own mobile-first defaults.
    card: {
      defaultVariants: {
        variant: 'subtle',
      },
    },

    // DESIGN.md › Component behavior › Long-form content.
    //
    // NuxtUI registers its Prose* components as soon as @nuxt/content is
    // installed, and <ContentRenderer> maps every markdown node onto them. They
    // use the semantic token layer already — these are the two defaults that
    // contradict DESIGN.md, and nothing else.
    prose: {
      // The display face ships at 400 only, so `font-bold` on a serif heading
      // is the faux-bold DESIGN.md › Identity › Never rules out. It survives
      // today only because `font-synthesis-weight: none` refuses to fake it.
      h1: { slots: { base: 'font-normal' } },
      h2: { slots: { base: 'font-normal' } },
      h3: { slots: { base: 'font-normal' } },
      // DESIGN.md › Accessibility › Contrast: an inline prose link is
      // underlined, because colour alone is not a distinction (WCAG 1.4.1).
      // NuxtUI's default is a transparent bottom border that only appears on
      // hover — invisible to a reader who never hovers, and to axe's
      // link-in-text-block rule.
      a: { base: 'border-b-0 underline underline-offset-2 hover:decoration-2' },
    },
  },
})
