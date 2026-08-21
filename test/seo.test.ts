// The SEO/AEO layer: URL identity, structured data, and the two crawler files.
//
// All of it is pure functions on purpose. The failure mode for SEO code is that
// it is silently wrong for months — nothing throws when a canonical URL grows a
// trailing slash or an Offer publishes a price of "$12" instead of "12". These
// tests are the only thing that notices.

import { describe, expect, it } from 'vitest'

import { buildLlmsTxt, buildRobotsTxt, AI_CRAWLERS } from '../server/utils/seo'
import type { SiteContext } from '../shared/utils/schema'
import {
  faqSchema,
  jsonLdGraph,
  offerSchema,
  organizationSchema,
  softwareApplicationSchema,
  webPageSchema,
} from '../shared/utils/schema'
import { absoluteUrl, canonicalPath, escapeXml, normalizeOrigin } from '../shared/utils/site'

const SITE: SiteContext = {
  appName: 'My App',
  appUrl: 'https://example.com',
  supportEmail: 'support@example.com',
  legalEntity: 'My Company Ltd',
}

describe('canonicalPath', () => {
  it('collapses the spellings of one page to a single URL', () => {
    // Every one of these is the same page. If they canonicalise differently,
    // the ranking for that page is split across them.
    expect(canonicalPath('/pricing')).toBe('/pricing')
    expect(canonicalPath('/pricing/')).toBe('/pricing')
    expect(canonicalPath('/pricing///')).toBe('/pricing')
    expect(canonicalPath('/pricing?ref=twitter')).toBe('/pricing')
    expect(canonicalPath('/pricing#plans')).toBe('/pricing')
    expect(canonicalPath('/pricing/?utm_source=x#plans')).toBe('/pricing')
  })

  it('keeps the root as a bare slash', () => {
    expect(canonicalPath('/')).toBe('/')
    expect(canonicalPath('')).toBe('/')
  })

  it('adds the leading slash a relative path is missing', () => {
    expect(canonicalPath('pricing')).toBe('/pricing')
  })
})

describe('absoluteUrl', () => {
  it('joins without doubling the slash, however appUrl was written', () => {
    expect(absoluteUrl('https://example.com', '/pricing')).toBe('https://example.com/pricing')
    expect(absoluteUrl('https://example.com/', '/pricing')).toBe('https://example.com/pricing')
    expect(absoluteUrl('https://example.com///', '/pricing')).toBe('https://example.com/pricing')
  })

  it('renders the root without a trailing slash', () => {
    expect(absoluteUrl('https://example.com', '/')).toBe('https://example.com')
  })

  it('returns empty when no origin is configured', () => {
    // A relative canonical is treated as self-referential and ignored, so the
    // caller must be able to tell there is nothing worth emitting.
    expect(absoluteUrl('', '/pricing')).toBe('')
    expect(absoluteUrl(undefined, '/pricing')).toBe('')
  })
})

describe('normalizeOrigin / escapeXml', () => {
  it('strips trailing slashes and survives undefined', () => {
    expect(normalizeOrigin('https://example.com//')).toBe('https://example.com')
    expect(normalizeOrigin(undefined)).toBe('')
  })

  it('escapes the five XML entities', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })
})

describe('jsonLdGraph', () => {
  it('drops null nodes so a builder can decline without the caller branching', () => {
    const parsed = JSON.parse(jsonLdGraph([{ '@type': 'Thing' }, null, undefined]))
    expect(parsed['@graph']).toHaveLength(1)
  })

  it('escapes < so a value cannot close the script tag it is embedded in', () => {
    // The realistic path here is an appName or a FAQ answer containing markup.
    const json = jsonLdGraph([{ '@type': 'Thing', name: '</script><script>alert(1)</script>' }])
    expect(json).not.toContain('</script>')
    expect(json).toContain('\\u003c')
    // Still valid JSON carrying the original text — escaped, not mangled.
    expect(JSON.parse(json)['@graph'][0].name).toBe('</script><script>alert(1)</script>')
  })
})

describe('organizationSchema / webPageSchema', () => {
  it('anchors the organization at a stable @id', () => {
    const node = organizationSchema(SITE)
    expect(node?.['@id']).toBe('https://example.com/#organization')
    expect(node?.name).toBe('My Company Ltd')
  })

  it('returns null with no origin, rather than emitting relative @ids', () => {
    expect(organizationSchema({ ...SITE, appUrl: '' })).toBeNull()
    expect(
      webPageSchema({ ...SITE, appUrl: '' }, { url: '', title: 't', description: 'd' }),
    ).toBeNull()
  })

  it('links a page back to the site graph', () => {
    const node = webPageSchema(SITE, {
      url: 'https://example.com/pricing',
      title: 'Pricing',
      description: 'Plans.',
    })
    expect(node?.isPartOf).toEqual({ '@id': 'https://example.com/#website' })
  })
})

describe('offerSchema', () => {
  it('publishes a bare number and a currency, never the display string', () => {
    const offer = offerSchema(SITE, {
      name: 'Monthly',
      description: 'Billed monthly.',
      amount: 12,
      currency: 'USD',
      unit: { value: 1, code: 'MON' },
      recurring: true,
    })
    expect(offer.price).toBe('12')
    expect(offer.priceCurrency).toBe('USD')
    expect(JSON.stringify(offer)).not.toContain('$')
  })

  it('distinguishes a recurring charge from a one-time one', () => {
    const base = { name: 'x', description: 'y', amount: 18, currency: 'USD' }
    const subscription = offerSchema(SITE, {
      ...base,
      unit: { value: 1, code: 'MON' },
      recurring: true,
    })
    const oneOff = offerSchema(SITE, {
      ...base,
      unit: { value: 30, code: 'DAY' },
      recurring: false,
    })

    const subSpec = subscription.priceSpecification as Record<string, unknown>
    const oneOffSpec = oneOff.priceSpecification as Record<string, unknown>

    // Same number, completely different products — billingDuration is what
    // stops an answer engine reporting the pass as "$18/month".
    expect(subSpec.billingDuration).toBe(1)
    expect(oneOffSpec.billingDuration).toBeUndefined()
    expect(oneOffSpec.referenceQuantity).toMatchObject({ value: 30, unitCode: 'DAY' })
  })
})

describe('softwareApplicationSchema', () => {
  const offers = [
    {
      name: 'Monthly',
      description: '',
      amount: 12,
      currency: 'USD',
      unit: { value: 1, code: 'MON' as const },
      recurring: true,
    },
    {
      name: 'Yearly',
      description: '',
      amount: 120,
      currency: 'USD',
      unit: { value: 1, code: 'ANN' as const },
      recurring: true,
    },
    {
      name: 'Pass',
      description: '',
      amount: 18,
      currency: 'USD',
      unit: { value: 30, code: 'DAY' as const },
      recurring: false,
    },
  ]

  it('reports the real low and high price across every plan', () => {
    const node = softwareApplicationSchema(SITE, { description: 'd', offers })
    const aggregate = node?.offers as Record<string, unknown>
    expect(aggregate.lowPrice).toBe('12')
    expect(aggregate.highPrice).toBe('120')
    expect(aggregate.offerCount).toBe(3)
  })

  it('omits the offer block entirely when nothing is for sale', () => {
    const node = softwareApplicationSchema(SITE, { description: 'd', offers: [] })
    expect(node?.offers).toBeUndefined()
  })
})

describe('faqSchema', () => {
  it('returns null for an empty FAQ instead of an empty FAQPage', () => {
    expect(faqSchema([])).toBeNull()
  })

  it('maps each item to a Question/Answer pair', () => {
    const node = faqSchema([{ question: 'Who charges my card?', answer: 'Paddle does.' }])
    expect(node?.mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'Who charges my card?',
        acceptedAnswer: { '@type': 'Answer', text: 'Paddle does.' },
      },
    ])
  })
})

describe('buildRobotsTxt', () => {
  const BASE = { appUrl: 'https://example.com', indexable: true, allowAiCrawlers: true }

  it('disallows everything on a preview deploy', () => {
    const body = buildRobotsTxt({ ...BASE, indexable: false })
    expect(body).toBe('User-agent: *\nDisallow: /\n')
    // No sitemap line: an indexed preview competing with production is the
    // exact thing this flag exists to prevent.
    expect(body).not.toContain('Sitemap')
  })

  it('disallows everything when no canonical origin is set', () => {
    expect(buildRobotsTxt({ ...BASE, appUrl: '' })).toBe('User-agent: *\nDisallow: /\n')
  })

  it('points at the sitemap and keeps private paths out', () => {
    const body = buildRobotsTxt(BASE)
    expect(body).toContain('Sitemap: https://example.com/sitemap.xml')
    expect(body).toContain('Disallow: /account')
    expect(body).toContain('Disallow: /api/')
    expect(body).toContain('Disallow: /ingest/')
  })

  it('names every AI crawler explicitly in both directions', () => {
    const allowed = buildRobotsTxt(BASE)
    const blocked = buildRobotsTxt({ ...BASE, allowAiCrawlers: false })

    for (const { agent } of AI_CRAWLERS) {
      expect(allowed).toContain(`User-agent: ${agent}`)
      expect(blocked).toContain(`User-agent: ${agent}`)
    }
    // The point of naming them is that the policy is visible and reversible.
    expect(blocked.match(/Disallow: \/$/gm)?.length).toBe(AI_CRAWLERS.length)
    expect(allowed).not.toMatch(/^Disallow: \/$/m)
  })

  it('still hides private paths from AI crawlers that are allowed', () => {
    const body = buildRobotsTxt(BASE)
    const gptSection = body.slice(body.indexOf('User-agent: GPTBot'))
    expect(gptSection).toContain('Disallow: /account')
  })
})

describe('buildLlmsTxt', () => {
  const INPUT = {
    appName: 'My App',
    appUrl: 'https://example.com/',
    description: 'A template.',
    supportEmail: 'support@example.com',
    legalEntity: 'My Company Ltd',
    pages: [
      {
        path: '/pricing',
        changefreq: 'weekly' as const,
        priority: '0.8',
        title: 'Pricing',
        summary: 'Every plan and what it costs.',
      },
    ],
  }

  it('renders the llmstxt.org shape: h1, blockquote, then links', () => {
    const body = buildLlmsTxt(INPUT)
    expect(body.startsWith('# My App\n')).toBe(true)
    expect(body).toContain('> A template.')
    expect(body).toContain(
      '- [Pricing](https://example.com/pricing): Every plan and what it costs.',
    )
  })

  it('builds absolute links even when appUrl has a trailing slash', () => {
    expect(buildLlmsTxt(INPUT)).not.toContain('example.com//pricing')
  })

  it('omits the Pages section rather than emitting an empty heading', () => {
    const body = buildLlmsTxt({ ...INPUT, pages: [] })
    expect(body).not.toContain('## Pages')
    expect(body).toContain('## About')
  })
})
