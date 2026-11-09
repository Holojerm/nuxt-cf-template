// The share-card pipeline's pure half: which route a page file is, what it asks
// for, and where `useSeo()` looks for the file. The drawing itself runs in
// `bun run build`, and `scripts/og-images.ts --check` proves each card landed
// in .output/public/og.

import { describe, expect, it } from 'vitest'

import { ogCardPath } from '../shared/utils/og'
import { cardOfPage, clip, ogCardFile, routeOfPageFile, titleSize } from '../scripts/lib/og-source'

const PAGE = `<script setup lang="ts">
// publicPage: { title: 'commented out' }
definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '0.8',
    title: 'Pricing',
    summary:
      "Every plan and what it costs, monthly.",
  },
})
</script>`

describe('ogCardPath', () => {
  it('maps a route to its card, and the home page to the site card', () => {
    expect(ogCardPath('/')).toBe('/og.png')
    expect(ogCardPath('/pricing')).toBe('/og/pricing.png')
    expect(ogCardPath('/blog/hello/')).toBe('/og/blog/hello.png')
    expect(ogCardPath('/pricing?plan=a#x')).toBe('/og/pricing.png')
  })

  it('names the build output file the same way', () => {
    expect(ogCardFile('/blog/hello')).toBe('public/og/blog/hello.png')
  })
})

describe('routeOfPageFile', () => {
  it('handles pages, index files and layer pages', () => {
    expect(routeOfPageFile('app/pages/index.vue')).toBe('/')
    expect(routeOfPageFile('app/pages/blog/index.vue')).toBe('/blog')
    expect(routeOfPageFile('layers/billing/app/pages/pricing.vue')).toBe('/pricing')
  })

  it('skips dynamic routes', () => {
    expect(routeOfPageFile('app/pages/blog/[slug].vue')).toBeNull()
    expect(routeOfPageFile('app/components/Foo.vue')).toBeNull()
  })
})

describe('cardOfPage', () => {
  it('reads the literal publicPage block', () => {
    expect(cardOfPage('layers/billing/app/pages/pricing.vue', PAGE)).toEqual({
      path: '/pricing',
      title: 'Pricing',
      summary: 'Every plan and what it costs, monthly.',
    })
  })

  it('gives no card to private, noindex or dynamic pages', () => {
    expect(cardOfPage('app/pages/account.vue', '<script setup>useSeo({})</script>')).toBeNull()
    expect(
      cardOfPage(
        'app/pages/x.vue',
        PAGE.replace('definePageMeta', 'noindex: true\ndefinePageMeta'),
      ),
    ).toBeNull()
    expect(cardOfPage('app/pages/blog/[slug].vue', PAGE)).toBeNull()
  })
})

describe('layout helpers', () => {
  it('clips on a word boundary', () => {
    expect(clip('one two three four', 12)).toBe('one two…')
    expect(clip('short', 12)).toBe('short')
  })

  it('steps the title size down as it grows', () => {
    expect(titleSize('Pricing')).toBeGreaterThan(
      titleSize('A much longer title than the short one'),
    )
  })
})
