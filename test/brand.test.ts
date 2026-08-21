// The brand pipeline's parsers.
//
// Worth testing for the same reason the SEO helpers are: every failure mode
// here is silent. A regex that stops finding the mark doesn't crash the site —
// it ships a favicon from two redesigns ago, and the only way anyone finds out
// is by looking at a browser tab and noticing.

import { describe, expect, it } from 'vitest'

import {
  BRAND_ROLES,
  extractMark,
  fingerprint,
  markTransform,
  parseBrandRoles,
  parseColorTokens,
  parseFontFamilies,
  parseNuxtPublicVar,
  parseWranglerVar,
} from '../scripts/brand-source'

const component = `<script setup lang="ts">
// Prose about <svg data-brand-mark> lives up here, and must not be mistaken
// for the element itself.
const appName = 'x'
</script>

<template>
  <span>
    <svg
      data-brand-mark
      viewBox="0 0 32 32"
      fill="currentColor"
      :class="markClass"
    >
      <!-- geometry notes -->
      <rect x="3" y="7" width="26" height="6.5" rx="1.5" />
    </svg>
    <span v-if="variant === 'lockup'">{{ appName }}</span>
  </span>
</template>
`

describe('extractMark', () => {
  it('reads the element, not the sentence describing it', () => {
    const mark = extractMark(component)
    expect(mark.viewBox).toBe('0 0 32 32')
    expect(mark.inner).toContain('<rect')
  })

  it('drops comments, so rewording one does not invalidate the assets', () => {
    expect(extractMark(component).inner).not.toContain('geometry notes')
  })

  it('refuses geometry a .png could not render the same way', () => {
    const dynamic = component.replace('<rect x="3"', '<rect :x="offset"')
    expect(() => extractMark(dynamic)).toThrow(/static/i)
  })

  it('refuses a hardcoded color, which would bypass the token layer', () => {
    const hex = component.replace('rx="1.5"', 'rx="1.5" fill="#c74f2f"')
    expect(() => extractMark(hex)).toThrow(/currentColor/)
  })

  it('names the missing attribute when the mark is unlabelled', () => {
    expect(() => extractMark(component.replaceAll('data-brand-mark', ''))).toThrow(
      /data-brand-mark/,
    )
  })
})

describe('parseColorTokens', () => {
  it('keeps values verbatim — hex and oklch both resolve in the browser', () => {
    const tokens = parseColorTokens(`@theme static {
      --color-clay-600: #c74f2f;
      --color-stone-500: oklch(55.3% 0.013 58.071);
    }`)
    expect(tokens['--color-clay-600']).toBe('#c74f2f')
    expect(tokens['--color-stone-500']).toBe('oklch(55.3% 0.013 58.071)')
  })
})

describe('parseFontFamilies', () => {
  it('takes the first family — the one a font provider has to be asked for', () => {
    const fonts = parseFontFamilies(`--font-display: 'Instrument Serif', ui-serif, Georgia, serif;
      --font-sans: 'Inter', system-ui, sans-serif;`)
    expect(fonts.display).toBe('Instrument Serif')
    expect(fonts.sans).toBe('Inter')
  })
})

describe('parseBrandRoles', () => {
  const table = `
## Brand mark

| Role | Token | Where it lands |
|---|---|---|
${BRAND_ROLES.map((role) => `| \`${role}\` | \`--color-clay-600\` | somewhere |`).join('\n')}

## Color
`

  it('maps every declared role to its token', () => {
    const roles = parseBrandRoles(table)
    for (const role of BRAND_ROLES) expect(roles[role]).toBe('--color-clay-600')
  })

  it('says which role is missing rather than generating a half-coloured icon', () => {
    const short = table.replace(/\| `og-muted` \|.*\n/, '')
    expect(() => parseBrandRoles(short)).toThrow(/og-muted/)
  })

  it('fails loudly when DESIGN.md has no Brand mark section at all', () => {
    expect(() => parseBrandRoles('## Color\n')).toThrow(/Brand mark/)
  })
})

describe('markTransform', () => {
  it('centres the mark inside an icon square', () => {
    expect(markTransform('0 0 32 32', 32, 0.7)).toBe('translate(4.8 4.8) scale(0.7)')
  })

  it('derives placement from the authored grid, not an assumed one', () => {
    // A fork drawing on a 24 grid gets the same optical result.
    expect(markTransform('0 0 24 24', 32, 0.75)).toBe('translate(4 4) scale(1)')
  })
})

describe('fingerprint', () => {
  it('ignores whitespace — reindenting the component is not a redesign', () => {
    expect(fingerprint({ geometry: '<rect  x="3" />' })).toBe(
      fingerprint({ geometry: '<rect\n  x="3" />' }),
    )
  })

  it('changes when a color role changes', () => {
    expect(fingerprint({ ink: '#c74f2f' })).not.toBe(fingerprint({ ink: '#c74f30' }))
  })
})

describe('app identity', () => {
  it('prefers what the deployed Worker actually serves', () => {
    expect(
      parseWranglerVar('[vars]\nNUXT_PUBLIC_APP_NAME = "Quarry"\n', 'NUXT_PUBLIC_APP_NAME'),
    ).toBe('Quarry')
  })

  it('falls back to the nuxt.config default, wrapped line and all', () => {
    const config = `    public: {
      appName: 'My App',
      appDescription:
        'A full-stack SaaS template.',
    },`
    expect(parseNuxtPublicVar(config, 'appName')).toBe('My App')
    expect(parseNuxtPublicVar(config, 'appDescription')).toBe('A full-stack SaaS template.')
  })
})
